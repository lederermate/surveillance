// Digitális zoom egy videócsempén: görgő / csípés a nagyításhoz, húzás a mozgatáshoz,
// dupla kattintás a visszaállításhoz. A "layer" elem kapja a transzformációt.

export function attachZoom(tile, layer, { isLocked = () => false } = {}) {
  let s = 1;
  let tx = 0;
  let ty = 0;
  const MAX = 8;

  const apply = () => {
    const w = tile.clientWidth;
    const h = tile.clientHeight;
    tx = Math.min(0, Math.max(w - w * s, tx));
    ty = Math.min(0, Math.max(h - h * s, ty));
    layer.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
    tile.classList.toggle('zoomed', s > 1);
  };

  const zoomAt = (px, py, factor) => {
    const ns = Math.min(MAX, Math.max(1, s * factor));
    const k = ns / s;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    s = ns;
    apply();
  };

  const local = (ev) => {
    const r = tile.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  tile.addEventListener('wheel', (ev) => {
    if (isLocked()) return;
    ev.preventDefault();
    const p = local(ev);
    zoomAt(p.x, p.y, ev.deltaY < 0 ? 1.25 : 0.8);
  }, { passive: false });

  const pointers = new Map();
  let pinchDist = 0;
  let moved = false;

  tile.addEventListener('pointerdown', (ev) => {
    if (isLocked() || ev.target.closest('.tools')) return;
    pointers.set(ev.pointerId, local(ev));
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    if (s > 1 || pointers.size === 2) tile.setPointerCapture(ev.pointerId);
  });
  tile.addEventListener('pointermove', (ev) => {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    const cur = local(ev);
    pointers.set(ev.pointerId, cur);
    if (pointers.size === 1 && s > 1) {
      tx += cur.x - prev.x;
      ty += cur.y - prev.y;
      if (Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) > 1) moved = true;
      apply();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinchDist);
      pinchDist = dist;
      moved = true;
    }
  });
  const release = (ev) => { pointers.delete(ev.pointerId); pinchDist = 0; };
  tile.addEventListener('pointerup', release);
  tile.addEventListener('pointercancel', release);
  // Húzás után ne számítson kattintásnak (pl. a rácsnézet csempéin).
  tile.addEventListener('click', (ev) => { if (moved) { ev.stopPropagation(); moved = false; } }, true);
  tile.addEventListener('dblclick', (ev) => {
    if (isLocked() || ev.target.closest('.tools')) return;
    if (s > 1) { s = 1; tx = 0; ty = 0; apply(); } else { const p = local(ev); zoomAt(p.x, p.y, 2.5); }
  });
  window.addEventListener('resize', apply);

  return {
    zoomIn() { zoomAt(tile.clientWidth / 2, tile.clientHeight / 2, 1.5); },
    zoomOut() { zoomAt(tile.clientWidth / 2, tile.clientHeight / 2, 1 / 1.5); },
    reset() { s = 1; tx = 0; ty = 0; apply(); },
    /** Képernyő-koordináta → a (nagyítatlan) kép 0..1 közötti koordinátája. */
    toNorm(ev) {
      const p = local(ev);
      return {
        x: Math.min(1, Math.max(0, (p.x - tx) / s / tile.clientWidth)),
        y: Math.min(1, Math.max(0, (p.y - ty) / s / tile.clientHeight)),
      };
    },
    destroy() { window.removeEventListener('resize', apply); },
  };
}
