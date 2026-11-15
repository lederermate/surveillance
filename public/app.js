import { StreamPlayer } from './player.js';
import { attachZoom } from './zoom.js';

const main = document.getElementById('main');
let cleanup = null;
let routeToken = 0;
let config = null;
let configAt = 0;

// ---------------------------------------------------------------- segédek

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

const pad = (n) => String(n).padStart(2, '0');
const hms = (sec) => {
  const s = Math.max(0, Math.min(86399, Math.floor(sec)));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
const parseHms = (text) => {
  const [h, m, s = 0] = text.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Hiba (HTTP ${res.status})`);
  return data;
}

async function getConfig() {
  if (!config || Date.now() - configAt > 10000) {
    config = await getJson('/api/config');
    configAt = Date.now();
  }
  return config;
}

function download(href, name) {
  const a = el('a', { href, download: name || '' });
  document.body.append(a);
  a.click();
  a.remove();
}

function saveFrame(video, baseName) {
  if (!video.videoWidth) return;
  const canvas = document.createElement('canvas');
  // A kis felbontású folyam torzított (4:3) képpontokkal jön, ezért 16:9-re igazítjuk.
  canvas.width = video.videoWidth;
  canvas.height = Math.round(video.videoWidth * 9 / 16);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    download(url, `${baseName}.jpg`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/jpeg', 0.92);
}

/**
 * Videócsempe. tools: true esetén zoom-, képmentés- és teljesképernyő-gombokkal.
 * snapshotName: függvény, amely a mentett kép fájlnevét adja.
 */
function videoTile(label, path, { live = true, tools = false, snapshotName = () => 'kamera' } = {}) {
  const video = el('video', { playsinline: true, autoplay: true });
  video.muted = true;
  const layer = el('div', { class: 'layer' }, video);
  const state = el('div', { class: 'state' });
  const tile = el('div', { class: 'tile' }, layer, state, label ? el('div', { class: 'label' }, label) : null);
  const onState = (s, text) => { state.textContent = s === 'playing' ? '' : text; };
  const player = path ? new StreamPlayer(video, path, { live, onState }) : null;
  const t = { tile, layer, video, state, player, onState, locked: false, zoom: null };
  if (tools) {
    t.zoom = attachZoom(tile, layer, { isLocked: () => t.locked });
    const btn = (text, title, fn) => el('button', { type: 'button', title, 'aria-label': title, onclick: fn }, text);
    tile.append(el('div', { class: 'tools' },
      btn('−', 'Kicsinyítés', () => t.zoom.zoomOut()),
      btn('+', 'Nagyítás', () => t.zoom.zoomIn()),
      btn('1:1', 'Eredeti méret', () => t.zoom.reset()),
      btn('Kép', 'Pillanatkép mentése', () => saveFrame(video, snapshotName())),
      btn('⛶', 'Teljes képernyő', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (tile.requestFullscreen) tile.requestFullscreen();
      })));
  }
  return t;
}

const stamp = () => {
  const d = new Date();
  return `${today().replace(/-/g, '')}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const slug = (name) => name.normalize('NFD').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'kamera';

// ---------------------------------------------------------------- élő kép

function viewLive(cfg, arg) {
  const cams = cfg.cameras.filter((c) => c.online);
  const tiles = [];
  const selected = cams.find((c) => String(c.id) === arg);

  if (selected) {
    const t = videoTile(selected.name, `/ws/live?ch=${selected.id}&stream=main`, {
      tools: true, snapshotName: () => `${slug(selected.name)}_${stamp()}`,
    });
    tiles.push(t);
    main.append(
      el('div', { class: 'head' },
        el('button', { onclick: () => { location.hash = '#/elo'; } }, '← Összes kamera'),
        el('h1', {}, selected.name),
        el('span', { class: 'muted hint' }, 'Görgővel nagyíthatsz, húzással mozgathatod a képet.')),
      el('div', { class: 'single' }, t.tile),
    );
  } else {
    const grid = el('div', { class: 'grid' });
    for (const cam of cams) {
      const t = videoTile(cam.name, `/ws/live?ch=${cam.id}&stream=sub`);
      t.tile.classList.add('clickable');
      t.tile.title = 'Kattints a nagy felbontású képhez';
      t.tile.addEventListener('click', () => { location.hash = `#/elo/${cam.id}`; });
      tiles.push(t);
      grid.append(t.tile);
    }
    main.append(el('h1', {}, 'Élő kép'));
    main.append(cams.length ? grid : el('div', { class: 'notice' }, 'Nincs elérhető kamera a rögzítőn.'));
  }
  return () => tiles.forEach((t) => { t.player.destroy(); if (t.zoom) t.zoom.destroy(); });
}

// ---------------------------------------------------------------- kaputelefon

function viewIntercom(cfg) {
  const t = videoTile('Kaputelefon', cfg.intercom.video ? '/ws/intercom' : null, {
    tools: true, snapshotName: () => `kaputelefon_${stamp()}`,
  });
  if (!cfg.intercom.video) t.state.textContent = 'A kaputelefon nincs beállítva (.env: INTERCOM_HOST, INTERCOM_USER, INTERCOM_PASSWORD)';

  const msg = el('div', { class: 'door-msg' });
  const btn = el('button', { class: 'primary big', disabled: !cfg.intercom.door }, 'Kapu nyitása');
  let armTimer = null;
  const disarm = () => { clearTimeout(armTimer); btn.classList.remove('confirm'); btn.textContent = 'Kapu nyitása'; };
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = 'Biztosan nyitod?';
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    btn.disabled = true;
    msg.className = 'door-msg';
    msg.textContent = 'Nyitás…';
    try {
      await getJson('/api/door/open', { method: 'POST' });
      msg.className = 'door-msg ok';
      msg.textContent = 'A kapu nyitva.';
    } catch (e) {
      msg.className = 'door-msg err';
      msg.textContent = e.message;
    }
    btn.disabled = false;
  });

  main.append(
    el('h1', {}, 'Kaputelefon'),
    el('div', { class: 'intercom' },
      t.tile,
      el('div', { class: 'door-panel' },
        btn, msg,
        cfg.intercom.door ? null : el('div', { class: 'muted' }, cfg.intercom.doorNote || 'A kapunyitás nem érhető el.'))),
  );
  return () => { clearTimeout(armTimer); if (t.player) t.player.destroy(); t.zoom.destroy(); };
}

// ---------------------------------------------------------------- felvételek

const ZOOMS = [
  { label: '24 óra', len: 86400, tick: 10800 },
  { label: '6 óra', len: 21600, tick: 3600 },
  { label: '2 óra', len: 7200, tick: 900 },
  { label: '30 perc', len: 1800, tick: 300 },
];

function viewRecordings(cfg) {
  const cams = cfg.cameras.filter((c) => c.online);
  const camName = () => (cams.find((c) => String(c.id) === camSel.value) || {}).name || 'kamera';
  const camSel = el('select', { 'aria-label': 'Kamera' }, ...cams.map((c) => el('option', { value: c.id }, c.name)));
  const dateIn = el('input', { type: 'date', value: today(), max: today(), 'aria-label': 'Dátum' });
  const timeIn = el('input', { type: 'time', step: 1, 'aria-label': 'Ugrás időpontra', title: 'Ugrás időpontra' });
  const clock = el('span', { class: 'clock' }, '--:--:--');
  const playBtn = el('button', { class: 'primary' }, 'Lejátszás');
  const info = el('span', { class: 'muted' });

  const t = videoTile(null, null, {
    tools: true,
    snapshotName: () => `${slug(camName())}_${dateIn.value.replace(/-/g, '')}_${hms(current() ?? 0).replace(/:/g, '')}`,
  });
  t.state.textContent = 'Válassz időpontot az idővonalon';
  const regionBox = el('div', { class: 'region' });
  t.layer.append(regionBox);

  // ---- idővonal (nagyítható)
  const cursor = el('div', { class: 'cursor' });
  const hover = el('div', { class: 'hover' });
  const selBox = el('div', { class: 'selection' });
  const timeline = el('div', { class: 'timeline' }, selBox, cursor, hover);
  const hours = el('div', { class: 'hours' });
  const zoomSel = el('select', { 'aria-label': 'Idővonal léptéke', title: 'Idővonal léptéke' },
    ...ZOOMS.map((z, i) => el('option', { value: i }, z.label)));
  let win = { start: 0, len: 86400 };
  const pct = (sec) => `${((sec - win.start) / win.len) * 100}%`;

  let player = null;
  let startSec = 0;
  let lastSec = null;
  let segments = [];
  let events = [];
  let loadToken = 0;
  let mark = { from: null, to: null };

  const current = () => (player ? startSec + player.position() : lastSec);

  function drawTimeline() {
    timeline.querySelectorAll('.seg, .ev').forEach((n) => n.remove());
    for (const s of segments) {
      timeline.prepend(el('div', { class: 'seg', style: `left:${pct(s.from)};width:${(Math.max(1, s.to - s.from) / win.len) * 100}%` }));
    }
    for (const e of events) {
      timeline.append(el('div', { class: 'ev', style: `left:${pct(e.from)};width:max(3px, ${((e.to - e.from) / win.len) * 100}%)`, title: `Mozgás ${hms(e.from)}` }));
    }
    if (mark.from != null && mark.to != null) {
      selBox.style.display = 'block';
      selBox.style.left = pct(mark.from);
      selBox.style.width = `${((mark.to - mark.from) / win.len) * 100}%`;
    } else selBox.style.display = 'none';
    hours.replaceChildren();
    const z = ZOOMS[zoomSel.value];
    for (let s = Math.ceil(win.start / z.tick) * z.tick; s <= win.start + win.len; s += z.tick) {
      hours.append(el('span', { style: `left:${pct(s)}` }, s >= 86400 ? '24:00' : hms(s).slice(0, 5)));
    }
  }

  function setWindow(centerSec) {
    const z = ZOOMS[zoomSel.value];
    const start = Math.max(0, Math.min(86400 - z.len, (centerSec ?? 0) - z.len / 2));
    win = { start: Math.floor(start / 60) * 60, len: z.len };
    drawTimeline();
  }

  function stop({ keepFrame = true } = {}) {
    if (!player) return;
    lastSec = current();
    player.destroy({ keepFrame });
    player = null;
    playBtn.textContent = 'Lejátszás';
  }

  function playAt(sec) {
    stop();
    startSec = Math.max(0, Math.min(86399, Math.floor(sec)));
    lastSec = startSec;
    const path = `/ws/playback?ch=${camSel.value}&start=${dateIn.value}T${hms(startSec)}`;
    const mine = player = new StreamPlayer(t.video, path, {
      live: false,
      onState: (s, text) => {
        t.onState(s, text);
        if ((s === 'ended' || s === 'error') && player === mine) stop();
      },
    });
    playBtn.textContent = 'Szünet';
    if (startSec < win.start || startSec > win.start + win.len) setWindow(startSec);
  }

  function defaultStart() {
    if (dateIn.value === today()) {
      const d = new Date();
      return Math.max(0, d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() - 300);
    }
    return segments.length ? segments[0].from : 0;
  }

  async function load() {
    const token = ++loadToken;
    stop({ keepFrame: false });
    cancelSearch();
    lastSec = null;
    segments = [];
    events = [];
    mark = { from: null, to: null };
    updateMark();
    results.replaceChildren();
    drawTimeline();
    cursor.style.display = 'none';
    clock.textContent = '--:--:--';
    t.state.textContent = 'Válassz időpontot az idővonalon';
    info.textContent = 'Felvételek keresése…';
    try {
      const date = dateIn.value;
      const data = await getJson(`/api/recordings?ch=${camSel.value}&date=${date}`);
      if (token !== loadToken) return;
      const secOf = (iso, edge) => (iso.slice(0, 10) !== date ? edge : parseHms(iso.slice(11)));
      segments = data.segments.map((s) => ({ from: secOf(s.start, 0), to: secOf(s.end, 86400) }));
      drawTimeline();
      info.textContent = segments.length ? '' : 'Erre a napra nincs felvétel.';
    } catch (e) {
      if (token === loadToken) info.textContent = e.message;
    }
  }

  const secAt = (ev) => {
    const r = timeline.getBoundingClientRect();
    return Math.max(0, Math.min(86399, win.start + ((ev.clientX - r.left) / r.width) * win.len));
  };
  timeline.addEventListener('click', (ev) => playAt(secAt(ev)));
  timeline.addEventListener('mousemove', (ev) => {
    const sec = secAt(ev);
    hover.style.display = 'block';
    hover.style.left = pct(sec);
    hover.textContent = hms(sec);
  });
  timeline.addEventListener('mouseleave', () => { hover.style.display = 'none'; });
  zoomSel.addEventListener('change', () => setWindow(current() ?? defaultStart()));
  const pan = (dir) => () => { const z = ZOOMS[zoomSel.value]; setWindow(win.start + z.len / 2 + dir * z.len * 0.8); };

  playBtn.addEventListener('click', () => { if (player) stop(); else playAt(lastSec ?? defaultStart()); });
  timeIn.addEventListener('change', () => { if (timeIn.value) playAt(parseHms(timeIn.value)); });
  camSel.addEventListener('change', load);
  dateIn.addEventListener('change', () => { if (dateIn.value) load(); });
  const skip = (d) => () => playAt((current() ?? defaultStart()) + d);

  // ---- részlet mentése
  const markInfo = el('span', { class: 'muted' }, 'Jelöld ki a részlet elejét és végét lejátszás közben.');
  const saveBtn = el('button', { disabled: true }, 'Részlet mentése');
  function updateMark() {
    const ok = mark.from != null && mark.to != null && mark.to > mark.from;
    saveBtn.disabled = !ok;
    if (mark.from == null && mark.to == null) markInfo.textContent = 'Jelöld ki a részlet elejét és végét lejátszás közben.';
    else if (mark.from != null && mark.to != null && mark.to <= mark.from) markInfo.textContent = 'A vége legyen később, mint az eleje.';
    else markInfo.textContent = `${mark.from != null ? hms(mark.from) : '…'} – ${mark.to != null ? hms(mark.to) : '…'}${ok ? ` (${Math.round(mark.to - mark.from)} mp)` : ''}`;
    drawTimeline();
  }
  const setMark = (key) => () => { const sec = current(); if (sec == null) return; mark[key] = Math.floor(sec); updateMark(); };
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const label = markInfo.textContent;
    markInfo.textContent = 'Mentés folyamatban… (a rögzítőről le kell tölteni a felvételt, ez akár egy percig is tarthat)';
    try {
      const d = dateIn.value;
      const clip = await getJson(`/api/clip?ch=${camSel.value}&start=${d}T${hms(mark.from)}&end=${d}T${hms(mark.to)}`);
      download(`/api/clip/download?id=${clip.id}`, `${slug(camName())}_${d.replace(/-/g, '')}_${hms(mark.from).replace(/:/g, '')}.mp4`);
      markInfo.textContent = `${label} – elmentve (${(clip.size / 1e6).toFixed(1)} MB)`;
    } catch (e) {
      markInfo.textContent = e.message;
    }
    saveBtn.disabled = false;
  });

  // ---- mozgáskeresés
  const fromIn = el('input', { type: 'time', step: 1, value: '00:00:00', 'aria-label': 'Keresés kezdete' });
  const toIn = el('input', { type: 'time', step: 1, value: '03:00:00', 'aria-label': 'Keresés vége' });
  const sensSel = el('select', { 'aria-label': 'Érzékenység' },
    el('option', { value: 'low' }, 'Csak nagy mozgás'),
    el('option', { value: 'medium', selected: true }, 'Közepes érzékenység'),
    el('option', { value: 'high' }, 'Kis mozgás is'));
  const regionBtn = el('button', {}, 'Terület kijelölése');
  const searchBtn = el('button', { class: 'primary' }, 'Mozgás keresése');
  const bar = el('div', { class: 'bar' }, el('div', {}));
  const searchInfo = el('span', { class: 'muted' });
  const results = el('div', { class: 'results' });
  let region = null;
  let searchAbort = null;

  function showRegion() {
    if (!region) { regionBox.style.display = 'none'; regionBtn.textContent = 'Terület kijelölése'; return; }
    regionBox.style.display = 'block';
    Object.assign(regionBox.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` });
    regionBtn.textContent = 'Terület törlése';
  }
  regionBtn.addEventListener('click', () => {
    if (region || t.locked) { region = null; t.locked = false; t.tile.classList.remove('picking'); showRegion(); return; }
    t.locked = true;
    t.tile.classList.add('picking');
    regionBtn.textContent = 'Húzz egy téglalapot a képen…';
  });
  let dragFrom = null;
  t.tile.addEventListener('pointerdown', (ev) => {
    if (!t.locked || ev.target.closest('.tools')) return;
    dragFrom = t.zoom.toNorm(ev);
    t.tile.setPointerCapture(ev.pointerId);
  });
  t.tile.addEventListener('pointermove', (ev) => {
    if (!dragFrom) return;
    const p = t.zoom.toNorm(ev);
    region = { x: Math.min(dragFrom.x, p.x), y: Math.min(dragFrom.y, p.y), w: Math.abs(p.x - dragFrom.x), h: Math.abs(p.y - dragFrom.y) };
    showRegion();
    regionBtn.textContent = 'Húzz egy téglalapot a képen…';
  });
  t.tile.addEventListener('pointerup', () => {
    if (!dragFrom) return;
    dragFrom = null;
    t.locked = false;
    t.tile.classList.remove('picking');
    if (region && (region.w < 0.02 || region.h < 0.02)) region = null;
    showRegion();
  });

  function cancelSearch() {
    if (searchAbort) { searchAbort.abort(); searchAbort = null; }
    searchBtn.textContent = 'Mozgás keresése';
    bar.style.display = 'none';
  }

  function addResult(ev) {
    const from = parseHms(ev.start.slice(11));
    const to = parseHms(ev.end.slice(11));
    events.push({ from, to });
    const thumb = el('div', { class: 'thumb' }, ev.thumb ? el('img', { src: ev.thumb, alt: '' }) : null);
    if (ev.box) {
      thumb.append(el('div', { class: 'box', style: `left:${ev.box.x * 100}%;top:${ev.box.y * 100}%;width:${ev.box.w * 100}%;height:${ev.box.h * 100}%` }));
    }
    const card = el('button', { class: 'result', title: 'Lejátszás innen' }, thumb,
      el('span', {}, `${hms(from)}${to - from > 2 ? ` – ${hms(to)}` : ''}`));
    card.dataset.from = from;
    card.addEventListener('click', () => { playAt(from - 3); t.tile.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    // időrendben tartjuk a listát
    const after = [...results.children].find((c) => Number(c.dataset.from) > from);
    results.insertBefore(card, after || null);
    drawTimeline();
  }

  searchBtn.addEventListener('click', async () => {
    if (searchAbort) { cancelSearch(); searchInfo.textContent = 'A keresés megszakítva.'; return; }
    if (!fromIn.value || !toIn.value || parseHms(toIn.value) <= parseHms(fromIn.value)) {
      searchInfo.textContent = 'Adj meg egy érvényes időszakot (a vége legyen később, mint az eleje).';
      return;
    }
    const d = dateIn.value;
    const params = new URLSearchParams({
      ch: camSel.value, start: `${d}T${hms(parseHms(fromIn.value))}`, end: `${d}T${hms(parseHms(toIn.value))}`, sens: sensSel.value,
    });
    if (region) params.set('region', [region.x, region.y, region.w, region.h].map((n) => n.toFixed(3)).join(','));
    events = [];
    results.replaceChildren();
    drawTimeline();
    const abort = searchAbort = new AbortController();
    searchBtn.textContent = 'Megszakítás';
    bar.style.display = 'block';
    bar.firstChild.style.width = '0%';
    searchInfo.textContent = 'Keresés indul…';
    let found = 0;
    try {
      const res = await fetch(`/api/motion?${params}`, { signal: abort.signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Hiba (HTTP ${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (msg.event) { found++; addResult(msg.event); }
          if (msg.progress != null) {
            bar.firstChild.style.width = `${Math.round(msg.progress * 100)}%`;
            searchInfo.textContent = `Keresés… ${msg.at.slice(11)} (${found} találat)`;
          }
          if (msg.error) throw new Error(msg.error);
          if (msg.done) searchInfo.textContent = found ? `${found} találat. Kattints egy képre a lejátszáshoz.` : 'Nem találtam mozgást ebben az időszakban.';
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) searchInfo.textContent = e.message;
    }
    if (searchAbort === abort) cancelSearch();
  });

  const ticker = setInterval(() => {
    const sec = current();
    if (sec == null) return;
    clock.textContent = hms(sec);
    cursor.style.display = 'block';
    cursor.style.left = pct(Math.min(86400, sec));
    // nagyított idővonalnál a kurzorral együtt lapozunk
    if (player && win.len < 86400 && sec > win.start + win.len) setWindow(sec + win.len * 0.4);
  }, 300);

  main.append(
    el('h1', {}, 'Felvételek'),
    el('div', { class: 'controls' }, camSel, dateIn, timeIn, info),
    el('div', { class: 'single' }, t.tile),
    el('div', { class: 'timeline-wrap' },
      el('div', { class: 'timeline-row' },
        el('button', { onclick: pan(-1), title: 'Korábbra', 'aria-label': 'Korábbra' }, '◀'),
        el('div', { class: 'timeline-col' }, timeline, hours),
        el('button', { onclick: pan(1), title: 'Későbbre', 'aria-label': 'Későbbre' }, '▶'),
        zoomSel)),
    el('div', { class: 'controls' },
      el('button', { onclick: skip(-600) }, '−10 perc'),
      el('button', { onclick: skip(-60) }, '−1 perc'),
      el('button', { onclick: skip(-10) }, '−10 mp'),
      playBtn,
      el('button', { onclick: skip(10) }, '+10 mp'),
      el('button', { onclick: skip(60) }, '+1 perc'),
      el('button', { onclick: skip(600) }, '+10 perc'),
      clock),
    el('section', { class: 'panel' },
      el('h2', {}, 'Részlet mentése'),
      el('div', { class: 'controls' },
        el('button', { onclick: setMark('from') }, 'Eleje itt'),
        el('button', { onclick: setMark('to') }, 'Vége itt'),
        saveBtn, markInfo)),
    el('section', { class: 'panel' },
      el('h2', {}, 'Mozgáskeresés'),
      el('div', { class: 'controls' }, fromIn, el('span', { class: 'muted' }, '–'), toIn, sensSel, regionBtn, searchBtn),
      bar, searchInfo, results),
  );
  bar.style.display = 'none';
  drawTimeline();
  if (cams.length) load();
  else info.textContent = 'Nincs elérhető kamera a rögzítőn.';

  return () => { clearInterval(ticker); loadToken++; cancelSearch(); if (player) player.destroy(); t.zoom.destroy(); };
}

// ---------------------------------------------------------------- rendszer

function viewSystem() {
  const body = el('div', { class: 'notice' }, 'Állapot lekérdezése…');
  main.append(el('h1', {}, 'Rendszer'), body);
  let alive = true;
  getJson('/api/status').then((s) => {
    if (!alive) return;
    const gb = (mb) => `${(mb / 1024).toFixed(0)} GB`;
    const row = (k, v) => el('tr', {}, el('th', {}, k), el('td', {}, v));
    body.replaceWith(el('div', { class: 'system' },
      el('table', {},
        row('Rögzítő', s.model),
        row('Firmware', s.firmware),
        row('A rögzítő órája', s.time.replace('T', ' ').slice(0, 19)),
        ...s.disks.map((d) => row(`Lemez (${d.name})`, `${d.status === 'ok' ? 'rendben' : d.status}, ${gb(d.capacityMb)}${d.freeMb ? `, szabad: ${gb(d.freeMb)}` : ', megtelt – a legrégebbi felvételeket írja felül'}`))),
      el('h2', {}, 'Kamerák'),
      el('table', {}, ...s.cameras.map((c) => el('tr', {},
        el('th', {}, `${c.id}. ${c.name}`),
        el('td', { class: c.online ? 'ok' : 'muted' }, c.online ? 'elérhető' : 'nincs csatlakoztatva'))))));
  }).catch((e) => { if (alive) { body.className = 'notice error'; body.textContent = e.message; } });
  return () => { alive = false; };
}

// ---------------------------------------------------------------- útválasztás

const VIEWS = { elo: viewLive, kaputelefon: viewIntercom, felvetelek: viewRecordings, rendszer: viewSystem };

async function route() {
  const token = ++routeToken;
  if (cleanup) { cleanup(); cleanup = null; }
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const view = VIEWS[name];
  if (!view) { location.hash = '#/elo'; return; }
  document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  main.replaceChildren();
  try {
    const cfg = await getConfig();
    if (token !== routeToken) return;
    cleanup = view(cfg, arg);
  } catch (e) {
    if (token !== routeToken) return;
    main.replaceChildren(
      el('h1', {}, 'Nem érhető el a rögzítő'),
      el('div', { class: 'notice error' }, e.message),
      el('p', {}, el('button', { onclick: route }, 'Újrapróbálás')),
    );
  }
}

window.addEventListener('hashchange', route);
route();
