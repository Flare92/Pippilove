// Scintille che fluttuano sullo sfondo + esplosione di cuori.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let ctx, W, H, dpr, motes = [], pops = [], raf = 0, running = false;

function resize() {
  const c = ctx.canvas;
  dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function mote() {
  return {
    x: Math.random() * W, y: H + Math.random() * H * 0.5,
    r: 0.6 + Math.random() * 1.8, vy: 0.12 + Math.random() * 0.35,
    sway: Math.random() * Math.PI * 2, hue: Math.random() < 0.7 ? 340 : 38,
    life: 0.25 + Math.random() * 0.55,
  };
}

function heartPath(x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.3);
  ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
  ctx.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.8, x, y + s);
  ctx.bezierCurveTo(x, y + s * 0.8, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
  ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.3);
  ctx.fill();
}

function frame(t) {
  ctx.clearRect(0, 0, W, H);
  for (const m of motes) {
    m.y -= m.vy; m.sway += 0.01;
    const x = m.x + Math.sin(m.sway) * 12;
    if (m.y < -10) Object.assign(m, mote(), { y: H + 10 });
    const fade = Math.min(1, (H - m.y) / 200) * Math.min(1, m.y / 200);
    ctx.fillStyle = `hsla(${m.hue}, 90%, 75%, ${m.life * fade})`;
    ctx.shadowColor = `hsla(${m.hue}, 90%, 70%, .9)`;
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0;
  pops = pops.filter(p => p.a > 0.02);
  for (const p of pops) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.vx *= 0.985; p.a *= 0.972; p.rot += p.vr;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = `hsla(${p.hue}, 90%, 68%, ${p.a})`;
    heartPath(0, -p.s / 2, p.s);
    ctx.restore();
  }
  raf = requestAnimationFrame(frame);
}

export function startSparks() {
  if (reduce || running) return;
  const c = document.getElementById('sparks');
  if (!c) return;
  ctx = c.getContext('2d');
  resize();
  addEventListener('resize', resize);
  motes = Array.from({ length: Math.round(Math.min(46, (W * H) / 16000)) }, () => Object.assign(mote(), { y: Math.random() * H }));
  running = true;
  raf = requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else raf = requestAnimationFrame(frame);
  });
}

export function burst(x, y, n = 28) {
  if (reduce || !ctx) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 5;
    pops.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3, s: 8 + Math.random() * 12, a: 1,
      rot: Math.random() - 0.5, vr: (Math.random() - 0.5) * 0.1, hue: Math.random() < 0.75 ? 345 : 35 });
  }
  if (navigator.vibrate) navigator.vibrate([10, 40, 10]);
}
