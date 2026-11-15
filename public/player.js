// WebSocketen érkező fMP4 (H.264) lejátszása Media Source Extensions segítségével.

function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Az init szegmens avcC dobozából kiolvassa a kodek-azonosítót (pl. avc1.4d4028).
function findAvcCodec(buf) {
  for (let i = 0; i + 8 <= buf.length; i++) {
    if (buf[i] === 0x61 && buf[i + 1] === 0x76 && buf[i + 2] === 0x63 && buf[i + 3] === 0x43) {
      const hex = (n) => n.toString(16).padStart(2, '0');
      return `avc1.${hex(buf[i + 5])}${hex(buf[i + 6])}${hex(buf[i + 7])}`;
    }
  }
  return null;
}

const ERRORS = {
  auth: 'Az eszköz elutasította a belépést. Javítsd a jelszót a .env fájlban, majd indítsd újra az alkalmazást.',
  unreachable: 'Az eszköz nem érhető el',
  failed: 'A videó nem indítható',
  unsupported: 'Ez a böngésző nem tudja lejátszani a videót',
};

export class StreamPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {string} path  WebSocket útvonal, pl. /ws/live?ch=1
   * @param {{live?: boolean, onState?: (state: string, text: string) => void}} opts
   */
  constructor(video, path, { live = true, onState = () => {} } = {}) {
    this.video = video;
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
    this.live = live;
    this.onState = onState;
    this.destroyed = false;
    this.base = null;      // az első pufferelt időbélyeg
    this.fatal = false;
    this.timer = setInterval(() => this.tick(), 500);
    this.open();
  }

  setState(state, text = '') { if (!this.destroyed) this.onState(state, text); }

  open() {
    this.queue = [];
    this.head = [];
    this.sb = null;
    this.base = null;
    this.gotData = false;
    const MS = window.ManagedMediaSource || window.MediaSource;
    if (!MS) { this.fatal = true; this.setState('error', ERRORS.unsupported); return; }
    this.setState('loading', 'Kapcsolódás…');
    this.ms = new MS();
    this.video.disableRemotePlayback = true;
    this.objectUrl = URL.createObjectURL(this.ms);
    this.video.src = this.objectUrl;
    this.ms.addEventListener('sourceopen', () => this.connect(), { once: true });
  }

  connect() {
    if (this.destroyed) return;
    const ws = this.ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.error) {
            // Hitelesítési hibánál nem próbálkozunk újra, nehogy az eszköz letiltson.
            this.fatal = msg.error === 'auth';
            this.setState('error', ERRORS[msg.error] || ERRORS.failed);
            this.reported = true;
          }
        } catch { /* nem JSON */ }
        return;
      }
      this.onData(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (this.destroyed || ws !== this.ws) return;
      if (!this.reported) this.setState(this.live ? 'error' : 'ended', this.live ? 'A kapcsolat megszakadt' : 'A felvétel véget ért');
      if (this.live && !this.fatal) this.retry = setTimeout(() => this.reopen(), 3000);
    };
  }

  reopen() {
    if (this.destroyed) return;
    this.reported = false;
    this.teardownSource();
    this.open();
  }

  onData(chunk) {
    this.gotData = true;
    if (!this.sb) {
      this.head.push(chunk);
      const all = concat(this.head);
      const codec = findAvcCodec(all);
      if (!codec) {
        if (all.length > 2 * 1024 * 1024) { this.fatal = true; this.setState('error', ERRORS.unsupported); this.ws.close(); }
        return;
      }
      const mime = `video/mp4; codecs="${codec}"`;
      const MS = window.ManagedMediaSource || window.MediaSource;
      if (!MS.isTypeSupported(mime)) { this.fatal = true; this.setState('error', ERRORS.unsupported); this.ws.close(); return; }
      this.sb = this.ms.addSourceBuffer(mime);
      this.sb.mode = 'segments';
      this.sb.addEventListener('updateend', () => this.pump());
      this.queue.push(all);
      this.head = null;
    } else {
      this.queue.push(chunk);
    }
    this.pump();
  }

  pump() {
    if (this.destroyed || !this.sb || this.sb.updating || this.ms.readyState !== 'open' || !this.queue.length) return;
    const data = concat(this.queue);
    this.queue = [];
    try {
      this.sb.appendBuffer(data);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        this.queue.unshift(data);
        this.trim(2);
      } else {
        this.setState('error', ERRORS.failed);
      }
    }
  }

  trim(keepBehind) {
    const b = this.video.buffered;
    if (!this.sb || this.sb.updating || !b.length) return;
    const start = b.start(0);
    const cut = this.video.currentTime - keepBehind;
    if (cut - start > 1) {
      try { this.sb.remove(start, cut); } catch { /* következő körben */ }
    }
  }

  tick() {
    if (this.destroyed || !this.sb) return;
    const v = this.video;
    const b = v.buffered;
    if (!b.length) return;
    const start = b.start(0);
    const end = b.end(b.length - 1);
    if (this.base === null) {
      this.base = start;
      if (v.currentTime < start) v.currentTime = start;
      v.play().catch(() => {});
    }
    if (this.live) {
      const lag = end - v.currentTime;
      if (lag > 4 || v.currentTime < start) v.currentTime = Math.max(start, end - 0.4);
      else v.playbackRate = lag > 1.2 ? 1.15 : 1;
    } else if (v.currentTime < start) {
      v.currentTime = start;
    }
    if (!v.paused && v.readyState >= 3) this.setState('playing');
    if (v.currentTime - start > 30) this.trim(10);
  }

  /** A folyam indulása óta lejátszott másodpercek (felvételnél az időpont számításához). */
  position() {
    return this.base === null ? 0 : Math.max(0, this.video.currentTime - this.base);
  }

  teardownSource() {
    clearTimeout(this.retry);
    if (this.ws) { const ws = this.ws; this.ws = null; ws.onclose = null; ws.onmessage = null; ws.close(); }
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    this.sb = null;
  }

  /** Leállítja a folyamot; keepFrame esetén az utolsó képkocka látható marad. */
  destroy({ keepFrame = false } = {}) {
    this.destroyed = true;
    clearInterval(this.timer);
    this.video.pause();
    this.teardownSource();
    if (!keepFrame) { this.video.removeAttribute('src'); this.video.load(); }
  }
}
