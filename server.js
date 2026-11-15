'use strict';
// Kamerarendszer webfelület – Hikvision NVR (ISAPI + RTSP) elé tett kis szerver.
// Külső csomag nélkül fut: Node + ffmpeg kell hozzá.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const media = require('./media');

// ---------------------------------------------------------------- config

function loadEnv(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };

const NVR = {
  host: env.NVR_HOST,
  port: Number(env.NVR_HTTP_PORT || 80),
  rtspPort: Number(env.NVR_RTSP_PORT || 554),
  user: env.NVR_USER || '',
  pass: env.NVR_PASSWORD || '',
};
const INTERCOM = {
  host: env.INTERCOM_HOST || '',
  rtspPort: Number(env.INTERCOM_RTSP_PORT || 554),
  user: env.INTERCOM_USER || '',
  pass: env.INTERCOM_PASSWORD || '',
};
const PORT = Number(env.PORT || 8088);
const HOST = env.HOST || '127.0.0.1';
const FFMPEG = env.FFMPEG_PATH
  || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p))
  || 'ffmpeg';

const SECRETS = [NVR.pass, INTERCOM.pass].filter(Boolean)
  .flatMap((s) => [s, encodeURIComponent(s)]);
function redact(text) {
  let out = String(text);
  for (const s of SECRETS) out = out.split(s).join('***');
  return out;
}
function log(...args) {
  console.log(new Date().toTimeString().slice(0, 8), redact(args.join(' ')));
}

// ---------------------------------------------------------------- ISAPI (HTTP digest)

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseDigestChallenge(header) {
  const m = /Digest\s+([\s\S]*)/i.exec(header || '');
  if (!m) return null;
  const part = m[1].split(/,\s*Basic\s/i)[0];
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let kv;
  while ((kv = re.exec(part))) out[kv[1].toLowerCase()] = kv[2] !== undefined ? kv[2] : kv[3];
  return out;
}

function digestHeader(ch, method, uri, user, pass) {
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${user}:${ch.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = (ch.qop || '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : '';
  const response = qop
    ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${ch.nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (ch.opaque) h += `, opaque="${ch.opaque}"`;
  return h;
}

// Minden kérés saját kapcsolaton megy: a rögzítő régi webszervere megbízhatatlanul
// kezeli az újrahasznált (keep-alive) kapcsolatokat.
function rawRequest(method, uri, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: NVR.host, port: NVR.port, method, path: uri, agent: false, timeout: 15000,
      headers: { ...headers, Connection: 'close', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, buffer: buf, text: () => buf.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('A rögzítő nem válaszolt időben')));
    req.on('error', reject);
    req.end(body);
  });
}

async function requestWithRetry(method, uri, headers, body) {
  try {
    return await rawRequest(method, uri, headers, body);
  } catch (e) {
    if (!['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(e.code)) throw e;
    await new Promise((r) => setTimeout(r, 300));
    return rawRequest(method, uri, headers, body);
  }
}

async function isapi(method, uri, body) {
  const headers = body ? { 'Content-Type': 'application/xml' } : {};
  let res = await requestWithRetry(method, uri, headers, body);
  if (res.status === 401) {
    const www = [].concat(res.headers['www-authenticate'] || []).find((h) => /^Digest/i.test(h));
    const ch = parseDigestChallenge(www);
    if (!ch) throw new Error('A rögzítő nem adott digest hitelesítési kihívást');
    res = await requestWithRetry(method, uri, { ...headers, Authorization: digestHeader(ch, method, uri, NVR.user, NVR.pass) }, body);
  }
  if (res.status === 401) throw new Error('A rögzítő elutasította a belépést (felhasználó/jelszó)');
  return res;
}

const xmlBlocks = (xml, tag) => xml.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'g')) || [];
const xmlVal = (xml, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].trim() : '';
};

let cameraCache = { at: 0, list: null };
async function getCameras() {
  if (cameraCache.list && Date.now() - cameraCache.at < 30000) return cameraCache.list;
  const [chRes, stRes] = await Promise.all([
    isapi('GET', '/ISAPI/ContentMgmt/InputProxy/channels'),
    isapi('GET', '/ISAPI/ContentMgmt/InputProxy/channels/status'),
  ]);
  if (!chRes.ok) throw new Error(`Csatornalista lekérése sikertelen (HTTP ${chRes.status})`);
  const online = new Map();
  if (stRes.ok) {
    for (const b of xmlBlocks(stRes.text(), 'InputProxyChannelStatus')) {
      online.set(Number(xmlVal(b, 'id')), xmlVal(b, 'online') === 'true');
    }
  }
  const list = xmlBlocks(chRes.text(), 'InputProxyChannel').map((b) => {
    const id = Number(xmlVal(b, 'id'));
    return { id, name: xmlVal(b, 'name') || `Kamera ${id}`, online: online.get(id) ?? true };
  });
  cameraCache = { at: Date.now(), list };
  return list;
}

// A rögzítő a helyi időt adja vissza "Z" jelöléssel, ezért itt mindenhol
// zónajelölés nélküli helyi időként kezeljük (YYYY-MM-DDTHH:MM:SS).
// A keresés a találatokat a keresési ablakra vágja; a fájlok valódi határaihoz
// tágabb ablakkal kell keresni (lásd findSegments).
async function searchRaw(ch, startIso, endIso) {
  const segments = [];
  let position = 0;
  for (let page = 0; page < 30; page++) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
<searchID>${crypto.randomUUID().toUpperCase()}</searchID>
<trackList><trackID>${ch}01</trackID></trackList>
<timeSpanList><timeSpan><startTime>${startIso}Z</startTime><endTime>${endIso}Z</endTime></timeSpan></timeSpanList>
<maxResults>40</maxResults>
<searchResultPostion>${position}</searchResultPostion>
<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`;
    const res = await isapi('POST', '/ISAPI/ContentMgmt/search', body);
    if (!res.ok) throw new Error(`Felvételkeresés sikertelen (HTTP ${res.status})`);
    const xml = res.text();
    const items = xmlBlocks(xml, 'searchMatchItem');
    for (const it of items) {
      const start = xmlVal(it, 'startTime').replace(/Z$/, '');
      const end = xmlVal(it, 'endTime').replace(/Z$/, '');
      if (start && end) segments.push({ start, end, uri: xmlVal(it, 'playbackURI') });
    }
    if (xmlVal(xml, 'responseStatusStrg') !== 'MORE' || !items.length) break;
    position += items.length;
  }
  segments.sort((x, y) => x.start.localeCompare(y.start));
  return segments;
}

async function searchRecordings(ch, date) {
  // Az egymáshoz érő szakaszok összevonása az idővonalhoz
  const merged = [];
  for (const s of await searchRaw(ch, `${date}T00:00:00`, `${date}T23:59:59`)) {
    const last = merged[merged.length - 1];
    if (last && Date.parse(s.start) - Date.parse(last.end) <= 2000) {
      if (s.end > last.end) last.end = s.end;
    } else merged.push({ start: s.start, end: s.end });
  }
  return merged;
}

// A megadott időszakot érintő felvételfájlok a valódi kezdő- és végidejükkel.
async function findSegments(ch, startIso, endIso) {
  const pad = 2 * 3600 * 1000;
  const all = await searchRaw(ch, media.toIso(media.toMs(startIso) - pad), media.toIso(media.toMs(endIso) + pad));
  return all.filter((s) => s.uri && s.end > startIso && s.start < endIso);
}

// Egy felvételfájl letöltése folyamként (a fájl mindig az elejétől jön).
async function openSegment(seg) {
  const uri = '/ISAPI/ContentMgmt/download';
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<downloadRequest version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<playbackURI>${seg.uri}</playbackURI>
</downloadRequest>`;
  const headers = { 'Content-Type': 'application/xml' };
  const first = await requestWithRetry('GET', uri, headers, body);
  const www = [].concat(first.headers['www-authenticate'] || []).find((h) => /^Digest/i.test(h));
  const ch = parseDigestChallenge(www);
  if (first.status !== 401 || !ch) throw new Error(`A felvétel letöltése nem indítható (HTTP ${first.status})`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: NVR.host, port: NVR.port, method: 'GET', path: uri, agent: false,
      headers: { ...headers, Connection: 'close', 'Content-Length': Buffer.byteLength(body), Authorization: digestHeader(ch, 'GET', uri, NVR.user, NVR.pass) },
    }, (res) => {
      if (res.statusCode === 200) return resolve(res);
      res.resume();
      reject(new Error(`A felvétel letöltése sikertelen (HTTP ${res.statusCode})`));
    });
    req.setTimeout(20000, () => req.destroy(new Error('A rögzítő nem válaszolt időben')));
    req.on('error', reject);
    req.end(body);
  });
}

async function getSystemStatus() {
  const [info, storage, time] = await Promise.all([
    isapi('GET', '/ISAPI/System/deviceInfo'), isapi('GET', '/ISAPI/ContentMgmt/Storage'), isapi('GET', '/ISAPI/System/time'),
  ]);
  const i = info.text();
  return {
    model: xmlVal(i, 'model'),
    firmware: `${xmlVal(i, 'firmwareVersion')} ${xmlVal(i, 'firmwareReleasedDate')}`.trim(),
    time: xmlVal(time.text(), 'localTime'),
    disks: xmlBlocks(storage.text(), 'hdd').map((d) => ({
      name: xmlVal(d, 'hddName'), status: xmlVal(d, 'status'),
      capacityMb: Number(xmlVal(d, 'capacity')), freeMb: Number(xmlVal(d, 'freeSpace')),
    })),
    cameras: await getCameras(),
  };
}

// ---------------------------------------------------------------- video (RTSP -> fMP4 -> WebSocket)

function rtspUrl(dev, pathAndQuery) {
  return `rtsp://${encodeURIComponent(dev.user)}:${encodeURIComponent(dev.pass)}@${dev.host}:${dev.rtspPort}${pathAndQuery}`;
}

function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const ws = {
    open: true,
    onclose: null,
    send(buf) {
      if (!ws.open) return false;
      if (socket.writableLength > 16 * 1024 * 1024) { ws.close(); return false; } // a kliens nem győzi
      socket.write(wsFrame(0x2, buf));
      return true;
    },
    sendText(text) { if (ws.open) socket.write(wsFrame(0x1, Buffer.from(text))); },
    close() {
      if (!ws.open) return;
      ws.open = false;
      try { socket.end(wsFrame(0x8, Buffer.alloc(0))); } catch { /* már lezárult */ }
      if (ws.onclose) ws.onclose();
    },
  };
  const gone = () => { if (ws.open) { ws.open = false; if (ws.onclose) ws.onclose(); } socket.destroy(); };
  socket.on('data', (d) => { if ((d[0] & 0x0f) === 0x8) gone(); }); // a kliens csak lezárást küld
  socket.on('close', gone);
  socket.on('error', gone);
  return ws;
}

// Kizárás elleni védelem: ha egy eszköz elutasította a belépést, addig nem
// próbálkozunk újra, amíg a .env fájl meg nem változik (a Hikvision eszközök
// néhány hibás kísérlet után letiltják a klienst).
const ENV_FILE = path.join(__dirname, '.env');
const AUTH_STATE_FILE = path.join(__dirname, '.auth-state.json');
const envMtime = () => { try { return Math.floor(fs.statSync(ENV_FILE).mtimeMs); } catch { return 0; } };
const ENV_MTIME = envMtime();
let authState = {};
try { authState = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, 'utf8')); } catch { /* nincs még */ }
const authBlocked = (device) => authState[device] === ENV_MTIME;
function markAuthFailed(device) {
  authState[device] = ENV_MTIME;
  try { fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(authState)); } catch { /* nem kritikus */ }
}

let streamSeq = 0;
function startStream(ws, url, { label, live, device }) {
  if (authBlocked(device)) {
    ws.sendText(JSON.stringify({ error: 'auth' }));
    ws.close();
    return;
  }
  const id = ++streamSeq;
  const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp'];
  if (live) args.push('-fflags', 'nobuffer', '-flags', 'low_delay');
  args.push('-analyzeduration', '1000000', '-probesize', '1000000', '-i', url,
    '-an', '-c:v', 'copy', '-f', 'mp4',
    '-movflags', '+frag_every_frame+empty_moov+default_base_moof',
    '-flush_packets', '1', 'pipe:1');
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let bytes = 0;
  log(`[${id}] indul: ${label}`);
  ff.stdout.on('data', (d) => { bytes += d.length; ws.send(d); });
  ff.stderr.on('data', (d) => { stderr = (stderr + d).slice(-1500); });
  ff.on('error', (e) => { stderr += `ffmpeg nem indítható: ${e.message}`; });
  ff.on('close', (code) => {
    if (ws.open && !bytes) {
      const reason = /401|Unauthorized/i.test(stderr) ? 'auth'
        : /Connection refused|timed out|No route|unreachable/i.test(stderr) ? 'unreachable' : 'failed';
      if (reason === 'auth') markAuthFailed(device);
      ws.sendText(JSON.stringify({ error: reason }));
    }
    log(`[${id}] vége: ${label} (kód ${code}, ${(bytes / 1e6).toFixed(1)} MB)${stderr && !bytes ? ' – ' + stderr.trim().split('\n').pop() : ''}`);
    ws.close();
  });
  ws.onclose = () => { ff.kill('SIGKILL'); };
}

// ---------------------------------------------------------------- kapunyitás (Hikvision SDK konténerben)

const DOCKER = env.DOCKER_PATH
  || ['/opt/homebrew/bin/docker', '/usr/local/bin/docker'].find((p) => fs.existsSync(p))
  || 'docker';
const DOOR_IMAGE = env.DOOR_IMAGE || 'kamerak-door';
const AUTH_HINT = 'A kaputelefon elutasította a jelszót. Javítsd a .env fájlban, majd indítsd újra az alkalmazást.';
const SDK_ERRORS = {
  1: AUTH_HINT,
  7: 'A kaputelefon nem érhető el a hálózaton.',
  10: 'A kaputelefon nem válaszolt időben.',
  153: 'A kaputelefon a hibás belépések miatt átmenetileg letiltotta a felhasználót. Próbáld újra fél óra múlva.',
};

const door = { proc: null, ready: false, error: '', waiters: [], busy: false };
const doorConfigured = () => Boolean(INTERCOM.host && INTERCOM.user);

function doorStart() {
  if (door.proc || !doorConfigured()) return;
  door.ready = false;
  door.error = '';
  const proc = spawn(DOCKER, ['run', '-i', '--rm', '--pull=never', '--platform', 'linux/amd64',
    '-e', 'INTERCOM_HOST', '-e', 'INTERCOM_USER', '-e', 'INTERCOM_PASSWORD', DOOR_IMAGE, 'serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, INTERCOM_HOST: INTERCOM.host, INTERCOM_USER: INTERCOM.user, INTERCOM_PASSWORD: INTERCOM.pass },
  });
  door.proc = proc;
  let buf = '';
  let stderr = '';
  const ended = (why) => {
    if (door.proc !== proc) return;
    door.proc = null;
    door.ready = false;
    const text = `${stderr} ${why || ''}`;
    door.error = /ENOENT/.test(text) ? 'A Docker nincs telepítve, ezért a kapunyitás nem érhető el.'
      : /Cannot connect to the Docker daemon|docker\.sock/i.test(text) ? 'A konténerkörnyezet nem fut. Indítsd el a „colima start” paranccsal, majd indítsd újra az alkalmazást.'
        : /No such image|Unable to find image/i.test(text) ? 'A kapunyitó nincs felépítve (docker build --platform linux/amd64 -t kamerak-door door).'
          : 'A kapunyitó szolgáltatás leállt.';
    log('kapunyitó leállt:', door.error, stderr.trim().split('\n').pop() || '');
    for (const w of door.waiters.splice(0)) w({ ok: false, step: 'service' });
  };
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { door.ready = true; log('kapunyitó készenlétben'); continue; }
      const w = door.waiters.shift();
      if (w) w(msg);
    }
  });
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-800); });
  proc.stdin.on('error', () => {});
  proc.on('error', (e) => ended(e.code || e.message));
  proc.on('close', () => ended());
}

function doorCommand(cmd, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!door.proc) doorStart();
    const started = Date.now();
    const attempt = () => {
      if (!door.proc) return resolve({ ok: false, step: 'service' });
      if (!door.ready) {
        if (Date.now() - started > 40000) return resolve({ ok: false, step: 'service' });
        return setTimeout(attempt, 200);
      }
      const proc = door.proc;
      let done = false;
      const finish = (msg) => { if (!done) { done = true; clearTimeout(timer); resolve(msg); } };
      // Időtúllépésnél újraindítjuk a szolgáltatást, hogy a kései válasz ne keveredjen a következő kéréssel.
      const timer = setTimeout(() => { finish({ ok: false, step: 'timeout' }); proc.kill(); }, timeoutMs);
      door.waiters.push(finish);
      proc.stdin.write(`${cmd}\n`);
    };
    attempt();
  });
}

function doorStatus() {
  if (!doorConfigured()) return { door: false, doorNote: 'A kaputelefon nincs beállítva a .env fájlban.' };
  if (authBlocked('intercom')) return { door: false, doorNote: AUTH_HINT };
  if (!door.proc) return { door: false, doorNote: door.error || 'A kapunyitó szolgáltatás nem fut.' };
  return { door: true, doorNote: '' };
}

async function openDoor(who) {
  if (!doorConfigured()) return { status: 501, error: 'A kaputelefon nincs beállítva.' };
  if (authBlocked('intercom')) return { status: 409, error: AUTH_HINT };
  if (door.busy) return { status: 429, error: 'Már folyamatban van egy nyitás.' };
  door.busy = true;
  try {
    const msg = await doorCommand('open');
    if (msg.ok) { log(`kapunyitás: sikeres (${who})`); return { status: 200 }; }
    if (msg.step === 'login' && msg.code === 1) markAuthFailed('intercom');
    const error = msg.step === 'service' ? (door.error || 'A kapunyitó szolgáltatás nem érhető el.')
      : msg.step === 'timeout' ? 'A kaputelefon nem válaszolt időben.'
        : SDK_ERRORS[msg.code] || `A kaputelefon hibát jelzett (${msg.step}, SDK hibakód: ${msg.code}).`;
    log(`kapunyitás: sikertelen (${who}) – ${msg.step} ${msg.code ?? ''}`);
    return { status: 502, error };
  } finally {
    door.busy = false;
  }
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const PUBLIC = path.join(__dirname, 'public');

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function channelParam(url) {
  const ch = Number(url.searchParams.get('ch'));
  return Number.isInteger(ch) && ch >= 1 && ch <= 64 ? ch : null;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Nincs ilyen oldal'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

let heavyJob = false; // egyszerre egy letöltős művelet, hogy a rögzítőt ne terheljük túl

// Elkészült részletek: 15 percig letölthetők, utána törlődnek.
const clips = new Map();
function dropClip(id) {
  const clip = clips.get(id);
  if (!clip) return;
  clearTimeout(clip.timer);
  clips.delete(id);
  fs.rm(clip.dir, { recursive: true, force: true }, () => {});
}

async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/config' && req.method === 'GET') {
    const cameras = await getCameras();
    return json(res, 200, {
      cameras,
      intercom: { video: doorConfigured(), ...doorStatus() },
    });
  }
  if (p === '/api/recordings' && req.method === 'GET') {
    const ch = channelParam(url);
    const date = url.searchParams.get('date') || '';
    if (!ch || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'Hibás paraméter' });
    return json(res, 200, { segments: await searchRecordings(ch, date) });
  }
  if (p === '/api/status' && req.method === 'GET') {
    return json(res, 200, await getSystemStatus());
  }
  if (p === '/api/clip/download' && req.method === 'GET') {
    const clip = clips.get(url.searchParams.get('id') || '');
    if (!clip) return json(res, 404, { error: 'A részlet már nem érhető el, mentsd újra.' });
    res.writeHead(200, {
      'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(clip.file).size,
      'Content-Disposition': `attachment; filename="${clip.name}"`, 'Cache-Control': 'no-store',
    });
    fs.createReadStream(clip.file).pipe(res);
    return undefined;
  }
  if ((p === '/api/motion' || p === '/api/clip') && req.method === 'GET') {
    const ch = channelParam(url);
    const start = url.searchParams.get('start') || '';
    const end = url.searchParams.get('end') || '';
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
    if (!ch || !iso.test(start) || !iso.test(end) || !(end > start)) return json(res, 400, { error: 'Hibás paraméter' });
    const hours = (media.toMs(end) - media.toMs(start)) / 3600000;
    const deps = { ffmpeg: FFMPEG, findSegments, openSegment };
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    if (p === '/api/clip') {
      if (hours > 1) return json(res, 400, { error: 'Egyszerre legfeljebb 1 órányi részlet menthető.' });
      if (heavyJob) return json(res, 429, { error: 'Már fut egy mentés vagy mozgáskeresés, várd meg a végét.' });
      heavyJob = true;
      try {
        log(`mentés: ${ch}. kamera ${start} – ${end}`);
        const clip = await media.exportClip(deps, { ch, start, end, signal: abort.signal });
        const id = crypto.randomBytes(8).toString('hex');
        const name = `kamera${ch}_${start.replace(/[-:]/g, '').replace('T', '_')}.mp4`;
        clips.set(id, { ...clip, name, timer: setTimeout(() => dropClip(id), 15 * 60 * 1000) });
        json(res, 200, { id, name, size: fs.statSync(clip.file).size });
      } finally {
        heavyJob = false;
      }
      return undefined;
    }

    if (hours > 6) return json(res, 400, { error: 'Egyszerre legfeljebb 6 órányi időszakban lehet keresni.' });
    if (heavyJob) return json(res, 429, { error: 'Már fut egy mentés vagy mozgáskeresés, várd meg a végét.' });
    let region = null;
    const rp = (url.searchParams.get('region') || '').split(',').map(Number);
    if (rp.length === 4 && rp.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && rp[2] > 0 && rp[3] > 0) {
      region = { x: rp[0], y: rp[1], w: rp[2], h: rp[3] };
    }
    heavyJob = true;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
    let lastProgress = 0;
    try {
      log(`mozgáskeresés: ${ch}. kamera ${start} – ${end}`);
      const found = await media.searchMotion(deps, {
        ch, start, end, region, sensitivity: url.searchParams.get('sens') || 'medium', signal: abort.signal,
        onProgress: (fraction, at) => {
          if (Date.now() - lastProgress < 250) return;
          lastProgress = Date.now();
          send({ progress: fraction, at });
        },
        onEvent: (event) => send({ event }),
      });
      send({ done: true, found });
      log(`mozgáskeresés kész: ${found} esemény`);
    } catch (e) {
      if (!abort.signal.aborted) { log('mozgáskeresés hiba:', e.message); send({ error: redact(e.message) }); }
    } finally {
      heavyJob = false;
      res.end();
    }
    return undefined;
  }
  if (p === '/api/snapshot' && req.method === 'GET') {
    const ch = channelParam(url);
    if (!ch) return json(res, 400, { error: 'Hibás paraméter' });
    const r = await isapi('GET', `/ISAPI/Streaming/channels/${ch}01/picture`);
    if (!r.ok) return json(res, 502, { error: `Pillanatkép nem érhető el (HTTP ${r.status})` });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    return res.end(r.buffer);
  }
  if (p === '/api/door/open' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Tiltott kérés' });
    const r = await openDoor(req.socket.remoteAddress);
    return json(res, r.status, r.error ? { error: r.error } : { ok: true });
  }
  return json(res, 404, { error: 'Nincs ilyen végpont' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') serveStatic(res, url.pathname);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    log('hiba:', req.method, url.pathname, e.code || '', e.message);
    if (!res.headersSent) json(res, 502, { error: redact(e.message) });
    else res.end();
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  const reject = (code) => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); };
  if (!sameOrigin(req)) return reject('403 Forbidden');

  let target = null;
  if (url.pathname === '/ws/live') {
    const ch = channelParam(url);
    const sub = url.searchParams.get('stream') !== 'main';
    if (ch) target = { url: rtspUrl(NVR, `/Streaming/Channels/${ch}0${sub ? 2 : 1}`), label: `élő ${ch}/${sub ? 'kis' : 'nagy'}`, live: true, device: 'nvr' };
  } else if (url.pathname === '/ws/playback') {
    const ch = channelParam(url);
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(url.searchParams.get('start') || '');
    if (ch && m) {
      const t = `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`;
      target = { url: rtspUrl(NVR, `/Streaming/tracks/${ch}01/?starttime=${t}`), label: `felvétel ${ch} @ ${m[0]}`, live: false, device: 'nvr' };
    }
  } else if (url.pathname === '/ws/intercom') {
    if (INTERCOM.host && INTERCOM.user) {
      target = { url: rtspUrl(INTERCOM, '/Streaming/Channels/101'), label: 'kaputelefon', live: true, device: 'intercom' };
    }
  }
  if (!target) return reject('400 Bad Request');
  const ws = wsAccept(req, socket);
  if (ws) startStream(ws, target.url, target);
});

if (!NVR.host || !NVR.user) {
  console.error('Hiányzik az NVR_HOST / NVR_USER / NVR_PASSWORD a .env fájlból.');
  process.exit(1);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (door.proc) door.proc.stdin.end(); // a konténer a bemenet lezárására kilép
    for (const clip of clips.values()) fs.rmSync(clip.dir, { recursive: true, force: true });
    process.exit(0);
  });
}
server.listen(PORT, HOST, () => {
  if (doorConfigured() && !authBlocked('intercom')) {
    // Induláskor egyszer ellenőrizzük a kaputelefon jelszavát (csak belépés, nyitás nélkül).
    doorCommand('check', 30000).then((msg) => {
      if (msg.ok) log('kaputelefon: a belépés rendben');
      else {
        if (msg.step === 'login' && msg.code === 1) markAuthFailed('intercom');
        log(`kaputelefon: a belépés sikertelen (${msg.step} ${msg.code ?? ''})`);
      }
    });
  }
  log(`Kamerák: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (rögzítő: ${NVR.host}, ffmpeg: ${FFMPEG})`);
});
