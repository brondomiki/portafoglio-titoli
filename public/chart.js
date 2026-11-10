// Grafico a linee su canvas: verde dove il valore è sopra la base, rosso dove è sotto.
// points: [{t, v, b}]  — b = valore di base (es. capitale investito o prezzo iniziale)

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function drawChart(canvas, points, opts = {}) {
  const { interactive = false, format = (v) => v.toFixed(2), padTop = 8, padBottom = 4, showBase = true } = opts;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!points || points.length < 2) {
    ctx.fillStyle = css('--muted') || '#888';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Dati non sufficienti', W / 2, H / 2);
    return;
  }
  const pos = css('--pos') || '#16a34a', neg = css('--neg') || '#dc2626', grid = css('--grid') || '#8883';
  const vals = points.flatMap((p) => [p.v, p.b]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const n = points.length;
  const X = (i) => (i / (n - 1)) * W;
  const Y = (v) => padTop + (1 - (v - lo) / (hi - lo)) * (H - padTop - padBottom);

  const linePath = (key) => { const p = new Path2D(); points.forEach((pt, i) => (i ? p.lineTo(X(i), Y(pt[key])) : p.moveTo(X(i), Y(pt[key])))); return p; };
  const vPath = linePath('v');
  // area tra valore e base
  const area = new Path2D();
  points.forEach((pt, i) => (i ? area.lineTo(X(i), Y(pt.v)) : area.moveTo(X(i), Y(pt.v))));
  for (let i = n - 1; i >= 0; i--) area.lineTo(X(i), Y(points[i].b));
  area.closePath();
  // regione sopra la base
  const above = new Path2D();
  above.moveTo(0, 0);
  points.forEach((pt, i) => above.lineTo(X(i), Y(pt.b)));
  above.lineTo(W, 0); above.closePath();
  const below = new Path2D();
  below.moveTo(0, H);
  points.forEach((pt, i) => below.lineTo(X(i), Y(pt.b)));
  below.lineTo(W, H); below.closePath();

  for (const [clip, color] of [[above, pos], [below, neg]]) {
    ctx.save();
    ctx.clip(clip);
    ctx.globalAlpha = 0.16; ctx.fillStyle = color; ctx.fill(area);
    ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = opts.lineWidth || 2; ctx.lineJoin = 'round';
    ctx.stroke(vPath);
    ctx.restore();
  }
  if (showBase) {
    ctx.save();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.stroke(linePath('b'));
    ctx.restore();
  }

  if (interactive && !canvas._bound) {
    canvas._bound = true;
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    canvas.parentElement.appendChild(tip);
    const move = (ev) => {
      const st = canvas._state; if (!st) return;
      const r = canvas.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const i = Math.max(0, Math.min(st.points.length - 1, Math.round((x / r.width) * (st.points.length - 1))));
      const pt = st.points[i];
      drawChart(canvas, st.points, { ...st.opts, _cursor: i });
      tip.style.display = 'block';
      tip.innerHTML = `<b>${new Date(pt.t).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' })}</b><br>${st.opts.format(pt.v)}${st.opts.tipExtra ? st.opts.tipExtra(pt) : ''}`;
      const tx = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, x - tip.offsetWidth / 2));
      tip.style.left = tx + 'px';
    };
    const leave = () => { tip.style.display = 'none'; const st = canvas._state; if (st) drawChart(canvas, st.points, st.opts); };
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('touchmove', move, { passive: true });
    canvas.addEventListener('mouseleave', leave);
    canvas.addEventListener('touchend', leave);
  }
  if (interactive) {
    const { _cursor, ...rest } = opts;
    canvas._state = { points, opts: { ...rest, format } };
    if (_cursor != null) {
      const x = X(_cursor), y = Y(points[_cursor].v);
      ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = points[_cursor].v >= points[_cursor].b ? pos : neg;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// Sparkline: base = primo valore
export function sparkline(canvas, history) {
  const pts = history.map(([t, v]) => ({ t, v, b: history[0][1] }));
  drawChart(canvas, pts, { lineWidth: 1.5, padTop: 2, padBottom: 2, showBase: false });
}
