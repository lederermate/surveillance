'use strict';
// Felvételek feldolgozása: mozgáskeresés és részletek mentése.
// A rögzítőről a felvételfájlok a valós idejű lejátszásnál kb. 40-szer gyorsabban
// tölthetők le, ezért mindkét funkció a letöltött fájlfolyamot dolgozza fel ffmpeg-gel.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = 320;           // elemzési felbontás
const H = 180;
const BLOCK = 8;         // blokkméret képpontban
const BW = W / BLOCK;    // 40
const BH = Math.floor(H / BLOCK); // 22
const FRAME_BYTES = W * H * 3;

const SENSITIVITY = {
  low: { minDiff: 10, minBlocks: 6 },
  medium: { minDiff: 6, minBlocks: 3 },
  high: { minDiff: 4, minBlocks: 3 },
};

// A rögzítő zónajelölés nélküli helyi időt használ; a számoláshoz UTC-ként kezeljük.
const toMs = (iso) => Date.parse(`${iso}Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 19);

function blockMeans(rgb) {
  const sums = new Float64Array(BW * BH);
  for (let y = 0; y < BH * BLOCK; y++) {
    const row = Math.floor(y / BLOCK) * BW;
    let p = y * W * 3;
    for (let x = 0; x < W; x++, p += 3) {
      sums[row + (x >> 3)] += (rgb[p] * 77 + rgb[p + 1] * 150 + rgb[p + 2] * 29) >> 8;
    }
  }
  for (let i = 0; i < sums.length; i++) sums[i] /= BLOCK * BLOCK;
  return sums;
}

function regionMask(region) {
  const mask = new Uint8Array(BW * BH).fill(1);
  if (!region) return mask;
  const x0 = Math.floor(region.x * BW), x1 = Math.ceil((region.x + region.w) * BW);
  const y0 = Math.floor(region.y * BH), y1 = Math.ceil((region.y + region.h) * BH);
  for (let by = 0; by < BH; by++) {
    for (let bx = 0; bx < BW; bx++) {
      if (bx < x0 || bx >= x1 || by < y0 || by >= y1) mask[by * BW + bx] = 0;
    }
  }
  return mask;
}

/**
 * Két egymást követő kulcsképkocka összevetése: a megváltozott blokkok indexei.
 * A küszöb a kép zajszintjéhez igazodik (éjszaka zajosabb a kép).
 */
function changedBlocks(prev, cur, mask, sens) {
  const diffs = [];
  for (let i = 0; i < cur.length; i++) if (mask[i]) diffs.push(Math.abs(cur[i] - prev[i]));
  if (!diffs.length) return { changed: [], total: 0 };
  const sorted = Float64Array.from(diffs).sort();
  const noise = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(sens.minDiff, noise * 4 + 2);
  const changed = [];
  for (let i = 0; i < cur.length; i++) {
    if (mask[i] && Math.abs(cur[i] - prev[i]) > threshold) changed.push(i);
  }
  return { changed, total: diffs.length };
}

/**
 * A folyton változó blokkok (óra-felirat, mozgó ágak, pókháló) kiszűrése:
 * minden blokkról vezetjük, milyen gyakran változik, és a "nyugtalan" blokkokat nem számoljuk.
 */
function filterRestless(changed, activity) {
  // Egy változás 0,03-at ad, ami lassan cseng le: az a blokk esik ki, amelyik
  // kb. fél percen belül másodszor is megváltozik.
  const kept = changed.filter((i) => activity[i] < 0.05);
  const set = new Set(changed);
  for (let i = 0; i < activity.length; i++) activity[i] = activity[i] * 0.97 + (set.has(i) ? 0.03 : 0);
  return kept;
}

function boundingBox(blocks) {
  if (!blocks.length) return null;
  let x0 = BW, y0 = BH, x1 = -1, y1 = -1;
  for (const i of blocks) {
    const bx = i % BW, by = Math.floor(i / BW);
    if (bx < x0) x0 = bx; if (bx > x1) x1 = bx;
    if (by < y0) y0 = by; if (by > y1) y1 = by;
  }
  return { x: x0 / BW, y: y0 / BH, w: (x1 - x0 + 1) / BW, h: (y1 - y0 + 1) / BH };
}

function encodeJpeg(ffmpeg, rgb) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', 'pipe:0',
      '-frames:v', '1', '-q:v', '6', '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', () => resolve(Buffer.concat(chunks)));
    ff.on('error', () => resolve(Buffer.alloc(0)));
    ff.stdin.on('error', () => {});
    ff.stdin.end(rgb);
  });
}

/**
 * Egy felvételfájl-folyam (Hikvision MPEG-PS) kulcsképkockáinak elemzése.
 * @param {import('stream').Readable} source  a letöltött fájl folyama
 * @param {object} o  { ffmpeg, segStartMs, fromMs, toMs, mask, sens, state, onFrame }
 * A state a szegmensek között megmarad (előző képkocka, nyitott esemény).
 */
function analyzeSegment(source, o) {
  return new Promise((resolve, reject) => {
    const ff = spawn(o.ffmpeg, ['-hide_banner', '-loglevel', 'info', '-nostats', '-skip_frame', 'nokey',
      '-f', 'mpeg', '-i', 'pipe:0', '-an', '-vf', `scale=${W}:${H}:flags=area,showinfo`,
      '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const times = [];        // a showinfo által kiírt időbélyegek, képkocka-sorrendben
    let firstPts = null;
    let errBuf = '';
    let pending = Buffer.alloc(0);
    let frameIndex = 0;
    let finished = false;
    const waiting = [];      // képkockák, amelyek időbélyege még nem érkezett meg

    const finish = (err) => {
      if (finished) return;
      finished = true;
      source.unpipe(ff.stdin);
      source.destroy();
      ff.kill('SIGKILL');
      if (err) reject(err); else resolve();
    };

    const drain = () => {
      while (waiting.length && times.length > waiting[0].index) {
        const { index, rgb } = waiting.shift();
        const t = o.segStartMs + Math.round((times[index] - firstPts) * 1000);
        if (t > o.toMs) { finish(); return; }
        if (o.onFrame(t, rgb) === false) { finish(); return; }
      }
    };

    ff.stderr.on('data', (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i);
        errBuf = errBuf.slice(i + 1);
        const m = /showinfo.*pts_time:\s*(-?[\d.]+)/.exec(line);
        if (m) {
          const pts = Number(m[1]);
          if (firstPts === null) firstPts = pts;
          times.push(pts);
        }
      }
      drain();
    });
    ff.stdout.on('data', (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= FRAME_BYTES) {
        waiting.push({ index: frameIndex++, rgb: Buffer.from(pending.subarray(0, FRAME_BYTES)) });
        pending = pending.subarray(FRAME_BYTES);
      }
      drain();
    });
    ff.on('close', () => { drain(); finish(); });
    ff.on('error', (e) => finish(e));
    ff.stdin.on('error', () => {});
    source.on('error', (e) => finish(e));
    source.pipe(ff.stdin);
    if (o.signal) o.signal.addEventListener('abort', () => finish(new Error('megszakítva')), { once: true });
  });
}

/**
 * Mozgáskeresés egy időszakban.
 * deps: { ffmpeg, findSegments(ch, startIso, endIso), openSegment(segment) -> Readable }
 * opts: { ch, start, end, sensitivity, region, signal, onProgress(fraction, iso), onEvent(event) }
 */
async function searchMotion(deps, opts) {
  const fromMs = toMs(opts.start);
  const endMs = toMs(opts.end);
  const sens = SENSITIVITY[opts.sensitivity] || SENSITIVITY.medium;
  const mask = regionMask(opts.region);
  const segments = (await deps.findSegments(opts.ch, opts.start, opts.end))
    .filter((s) => toMs(s.end) > fromMs && toMs(s.start) < endMs);
  if (!segments.length) return 0;

  const spanStart = Math.min(fromMs, toMs(segments[0].start));
  let prev = null;
  let prevT = 0;
  let open = null;   // { start, end, peak, rgb, box }
  let found = 0;
  const jobs = [];

  const close = () => {
    if (!open) return;
    const ev = open;
    open = null;
    found++;
    jobs.push(encodeJpeg(deps.ffmpeg, ev.rgb).then((jpg) => opts.onEvent({
      start: toIso(ev.start), end: toIso(ev.end), score: ev.peak, box: ev.box,
      thumb: jpg.length ? `data:image/jpeg;base64,${jpg.toString('base64')}` : null,
    })));
  };

  const activity = new Float32Array(BW * BH);
  const WARMUP = 40000;   // ennyivel a keresett időszak előtt kezdjük tanulni a nyugtalan blokkokat

  const onFrame = (t, rgb) => {
    if (opts.signal && opts.signal.aborted) return false;
    opts.onProgress(Math.max(0, Math.min(1, (t - spanStart) / (endMs - spanStart))), toIso(t));
    if (t < fromMs - WARMUP) return true;         // a keresett időszak előtti rész
    const cur = blockMeans(rgb);
    if (prev && t - prevT <= 10000) {
      const r = changedBlocks(prev, cur, mask, sens);
      const global = r.changed.length > r.total * 0.5;   // fényviszony-váltás (pl. éjszakai mód), nem mozgás
      const moving = global ? [] : filterRestless(r.changed, activity);
      if (t >= fromMs && moving.length >= sens.minBlocks) {
        if (open && t - open.end <= 6000) {
          open.end = t;
          if (moving.length > open.peak) { open.peak = moving.length; open.rgb = rgb; open.box = boundingBox(moving); }
        } else {
          close();
          open = { start: Math.max(fromMs, prevT), end: t, peak: moving.length, rgb, box: boundingBox(moving) };
        }
      } else if (open && t - open.end > 6000) {
        close();
      }
    }
    prev = cur;
    prevT = t;
    return true;
  };

  for (const seg of segments) {
    if (opts.signal && opts.signal.aborted) break;
    const source = await deps.openSegment(seg);
    await analyzeSegment(source, {
      ffmpeg: deps.ffmpeg, segStartMs: toMs(seg.start), toMs: endMs, onFrame, signal: opts.signal,
    });
  }
  close();
  await Promise.all(jobs);
  return found;
}

/**
 * Részlet mentése MP4-be (újrakódolás nélkül). A kész fájl útvonalát adja vissza;
 * a hívó feladata törölni.
 */
async function exportClip(deps, opts) {
  const fromMs = toMs(opts.start);
  const endMs = toMs(opts.end);
  const segments = (await deps.findSegments(opts.ch, opts.start, opts.end))
    .filter((s) => toMs(s.end) > fromMs && toMs(s.start) < endMs);
  if (!segments.length) throw new Error('Erre az időszakra nincs felvétel.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kamerak-clip-'));
  const run = (args, input) => new Promise((resolve, reject) => {
    const ff = spawn(deps.ffmpeg, args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (input) input.destroy();
      if (code === 0) resolve(); else reject(new Error(`A részlet mentése nem sikerült (${err.trim().split('\n').pop() || code})`));
    });
    if (input) {
      ff.stdin.on('error', () => {});
      input.on('error', () => ff.kill('SIGKILL'));
      input.pipe(ff.stdin);
    }
    if (opts.signal) opts.signal.addEventListener('abort', () => ff.kill('SIGKILL'), { once: true });
  });

  try {
    const parts = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segStart = toMs(seg.start);
      const ss = Math.max(0, (fromMs - segStart) / 1000);
      const dur = (Math.min(endMs, toMs(seg.end)) - Math.max(fromMs, segStart)) / 1000;
      const part = path.join(dir, `part${i}.ts`);
      const source = await deps.openSegment(seg);
      // A kimeneti -t elérésekor az ffmpeg kilép, a letöltés pedig megszakad.
      await run(['-v', 'error', '-y', '-f', 'mpeg', '-i', 'pipe:0', '-ss', ss.toFixed(3), '-t', dur.toFixed(3),
        '-an', '-c:v', 'copy', '-f', 'mpegts', part], source);
      parts.push(part);
    }
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
    const out = path.join(dir, 'clip.mp4');
    await run(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    for (const p of parts) fs.rmSync(p, { force: true });
    return { file: out, dir };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

module.exports = { searchMotion, exportClip, toMs, toIso };
