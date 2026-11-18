import { S } from './state';

/*
  Where the attackers are. Enemy troops, vehicles and aircraft that are off the view, or hidden under a
  HUD plate (the fire-control panel, the rack), get a small marker: on the screen edge pointing their way,
  or just above the plate that covers them, with a count when several are together. The fire-control
  panel turns see-through while the gun or an attacker is behind it, and the camera's cue (troops at the
  gun, aircraft inbound) shows under the minimap while the auto camera frames them.
*/

type Kind = 'inf' | 'veh' | 'air';
const LABEL: Record<Kind, string> = { inf: 'INF', veh: 'ARM', air: 'AIR' };
const pool: HTMLElement[] = [];
let box: HTMLElement | null = null;
let cue: HTMLElement | null = null;
let cueText = '';

function ensure() {
  const hud = document.getElementById('hud');
  if (!hud) return false;
  if (!box || !box.isConnected) {
    box = document.createElement('div');
    box.id = 'watch';
    hud.appendChild(box);
    pool.length = 0;
    cue = document.createElement('div');
    cue.id = 'camcue';
    hud.appendChild(cue);
    cueText = '';
  }
  return true;
}

export function updateWatch() {
  if (!ensure()) return;
  const g = S.game, r = S.renderer;
  const W = r.width, H = r.height;
  const plates = g.cam.plates;
  const fcp = document.getElementById('fcp');
  const fr = plates.find((p) => p.left < W * 0.1);
  const under = (x: number, y: number) => plates.find((p) => x > p.left && x < p.right && y > p.top - 4 && y < p.bottom);
  const behind = (x: number, y: number) => g.cam.tops.find((p) => x > p.left && x < p.right && y > p.top && y < p.bottom + 4);
  const groups = new Map<string, { kind: Kind; x: number; y: number; n: number; dir: string }>();
  let behindFcp = false;
  const add = (kind: Kind, wx: number, wy: number) => {
    const s = r.worldToScreen(wx, wy);
    let x = s.x, y = s.y, dir = '';
    const pl = under(x, y);
    if (pl && pl === fr) behindFcp = true;
    if (x > W - 4) { dir = '▶'; x = W - 46; } else if (x < 4) { dir = '◀'; x = 46; }
    if (y < 4) { dir = dir || '▲'; y = 150; } else if (y > H - 4) { dir = dir || '▼'; y = H - 140; }
    if (dir) y = Math.max(150, Math.min(H - 140, y));
    else if (pl) { dir = '▼'; y = pl.top - 16; }
    else { const tp = behind(x, y); if (tp) { dir = '▲'; y = tp.bottom + 16; } }
    if (!dir) return;
    // one marker per kind and side, gathered in 140 px bins along the edge
    const key = `${kind}${dir}${dir === '▶' || dir === '◀' ? Math.round(y / 140) : Math.round(x / 140)}`;
    const gr = groups.get(key);
    if (gr) { gr.n++; gr.x += (x - gr.x) / gr.n; gr.y += (y - gr.y) / gr.n; } else groups.set(key, { kind, x, y, n: 1, dir });
  };
  for (const s of g.soldiers) if (!s.dead && !s.eng && s.x > g.level.cannonX - 20) add('inf', s.x, s.y + 0.7);
  for (const u of g.motor.units) if (u.wreckT < 0) add('veh', u.x, u.y + 1);
  for (const u of g.air.units) if (!u.down && !u.dead) add('air', u.x, u.y);
  // the gun itself behind the panel
  if (fr) { const gp = r.worldToScreen(g.barrel.position.x, g.barrel.position.y); if (under(gp.x, gp.y) === fr) behindFcp = true; }
  if (fcp) fcp.classList.toggle('seethru', behindFcp);

  let i = 0;
  for (const gr of groups.values()) {
    let el = pool[i];
    if (!el) { el = document.createElement('div'); el.className = 'wmark'; box!.appendChild(el); pool.push(el); }
    el.style.display = '';
    el.className = `wmark ${gr.kind}`;
    const txt = `${gr.dir === '◀' || gr.dir === '▲' ? gr.dir + ' ' : ''}${LABEL[gr.kind]}${gr.n > 1 ? ` ×${gr.n}` : ''}${gr.dir === '▶' || gr.dir === '▼' ? ' ' + gr.dir : ''}`;
    if (el.textContent !== txt) el.textContent = txt;
    el.style.left = `${Math.round(gr.x)}px`;
    el.style.top = `${Math.round(gr.y)}px`;
    i++;
  }
  for (; i < pool.length; i++) pool[i].style.display = 'none';

  const c = g.cam.cue;
  if (c !== cueText && cue) { cueText = c; cue.textContent = c; cue.classList.toggle('on', !!c); }
}
