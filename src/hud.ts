import { AMMO, AMMO_BY_ID, PHYS, TARGETS, type AmmoId, type TargetKind } from './config';
import type { Block } from './game';
import { blockTip } from './screens';
import { $, S, icon } from './state';

/** short names for target kinds (TARGETS[].desc is a sentence for some kinds) */
const TARGET_NAME: Record<TargetKind, string> = {
  command: 'Command post', ammo: 'Munitions store', barracks: 'Barracks', artillery: 'Counter-battery gun',
  workshop: 'Engineers', flak: 'Flak battery', mast: 'Airship mast',
};
export const targetName = (k: TargetKind) => TARGET_NAME[k] ?? TARGETS[k].desc.split(' — ')[0];

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const labels = new Map<Block, HTMLElement>();
let fcpFor: AmmoId | null = null;

export function startBattle(cart: Partial<Record<AmmoId, number>>, spent: number, budget: number) {
  S.mode = 'battle';
  $('#screen').innerHTML = '';
  S.game.start(cart, spent, budget);
  buildHud();
}

export function buildHud() {
  const hud = $('#hud');
  hud.classList.remove('hidden');
  hud.innerHTML = `
    <div id="hud-left" class="plate"><div id="lvl-name"></div><div id="timer"></div><ul id="objectives"></ul></div>
    <div id="hud-right" class="plate">
      <div class="row"><span class="label">Wind</span><span class="windvane"><svg viewBox="0 0 38 14"><path id="windarrow" d="M2 7 H30 M24 2 L32 7 L24 12" stroke="#ffb347" stroke-width="2.4" fill="none"/></svg><span id="wind" class="readout"></span></span></div>
      <div class="row"><span class="label">Gun</span><div class="meter" id="hp"></div><span id="hpnum" class="readout"></span></div>
      <div class="row"><span class="label">Collateral</span><span id="collateral" class="readout">0</span></div>
      <div class="row"><span class="label">Garrison down</span><span id="garrison" class="readout">0</span></div>
      <div class="row" id="blind-row"><span class="label">Enemy guns</span><span id="blind" class="readout"></span></div>
    </div>
    <div id="rack" class="plate"></div>
    <div id="fcp" class="plate"></div>
    <canvas id="minimap" class="plate" width="520" height="84" title="Click to look there"></canvas>
    <div id="toasts"></div>
    <div id="dmgflash"></div>
    <div id="floaters"></div>
    <div id="help">mouse aims · click fires · wheel velocity (shift coarse) · ↑↓ elevation · ←→ velocity · space fire · 1-9 munitions · WASD scroll · ctrl+wheel / Q E zoom · drag pan · R reset view · T mouse aim · M mute</div>`;
  $('#lvl-name').textContent = S.game.level.name;
  $('#hp').innerHTML = '<i></i>'.repeat(12);
  buildRack();
  $('#fcp').addEventListener('pointerdown', (e) => e.stopPropagation());
  updateObjectives();
  const mm = $<HTMLCanvasElement>('#minimap');
  const look = (e: PointerEvent) => {
    const r = mm.getBoundingClientRect();
    const b = mapBounds();
    S.game.pan = b.x0 + ((e.clientX - r.left) / r.width) * (b.x1 - b.x0) - S.game.baseCx;
  };
  mm.addEventListener('pointerdown', (e) => { e.stopPropagation(); mm.setPointerCapture(e.pointerId); look(e); });
  mm.addEventListener('pointermove', (e) => { if (e.buttons) look(e); });
  buildLabels();
  fcpFor = null;
}

function buildRack() {
  const g = S.game;
  const ids = (Object.keys(g.inventory) as AmmoId[]).sort((a, b) => AMMO.findIndex((x) => x.id === a) - AMMO.findIndex((x) => x.id === b));
  const rack = $('#rack');
  rack.innerHTML = ids.map((id, i) => `<button class="slot" data-a="${id}" title="${AMMO_BY_ID[id].name}"><span class="key">${i < 9 ? i + 1 : ''}</span><img src="${icon(id)}" alt=""><div class="nm">${AMMO_BY_ID[id].name}</div><span class="ct"></span><div class="reload"></div></button>`).join('');
  rack.querySelectorAll<HTMLElement>('.slot').forEach((el) => {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', () => { g.selected = el.dataset.a as AmmoId; });
  });
}

export function rackIds() { return Array.from(document.querySelectorAll<HTMLElement>('.slot')).map((el) => el.dataset.a as AmmoId); }

export function updateObjectives() {
  const g = S.game;
  const l = g.level;
  const kinds = Object.keys(g.targetsTotal) as TargetKind[];
  kinds.sort((a, b) => +l.objectives.includes(b) - +l.objectives.includes(a));
  $('#objectives').innerHTML = kinds.map((k) => {
    const tot = g.targetsTotal[k] ?? 0, d = g.targetsDestroyed[k] ?? 0;
    const obj = l.objectives.includes(k);
    return `<li class="${d >= tot ? 'done' : ''} ${obj ? '' : 'opt'}"><span class="dot" style="background:${TARGETS[k].color}"></span>${targetName(k)}${tot > 1 ? ` ${d}/${tot}` : ''}${obj ? '' : ' <span class="label">secondary</span>'}</li>`;
  }).join('');
}

export function toast(text: string, tone = 'info') {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild!.remove();
  setTimeout(() => { el.style.opacity = '0'; }, 2600);
  setTimeout(() => el.remove(), 3200);
}

// ───────────────────────── dials ─────────────────────────
const P = (cx: number, cy: number, r: number, deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy - r * Math.sin((deg * Math.PI) / 180)];

/** gunner's quadrant: the needle points the way the barrel does */
function quadrantSvg(min: number, max: number) {
  const cx = 16, cy = 78, r = 66;
  let s = `<svg viewBox="0 0 120 96" data-dial="angle"><path class="face" d="M${cx} ${cy} L${P(cx, cy, r + 6, min).join(' ')} A${r + 6} ${r + 6} 0 0 0 ${P(cx, cy, r + 6, max).join(' ')} Z"/>`;
  for (let a = -10; a <= 90; a += 5) {
    const major = a % 15 === 0;
    const [x1, y1] = P(cx, cy, r - (major ? 9 : 5), a), [x2, y2] = P(cx, cy, r, a);
    s += `<line class="tick ${major ? 'major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    if (a % 30 === 0) { const [tx, ty] = P(cx, cy, r - 16, a); s += `<text class="tl" x="${tx}" y="${ty + 3}">${a}°</text>`; }
  }
  const [ax, ay] = P(cx, cy, r + 3, min), [bx, by] = P(cx, cy, r + 3, max);
  s += `<path class="arc" d="M${ax} ${ay} A${r + 3} ${r + 3} 0 0 0 ${bx} ${by}"/>`;
  s += `<line class="needle" id="needle-a" x1="${cx}" y1="${cy}" x2="${cx + r}" y2="${cy}"/><circle class="hub" cx="${cx}" cy="${cy}" r="5"/></svg>`;
  return s;
}

/** velocity gauge, 240° sweep from 0 to the gun's cap; red arc past this round's cap */
function velocitySvg(maxV: number, cap: number) {
  const cx = 60, cy = 56, r = 44;
  const ang = (v: number) => 210 - (v / maxV) * 240;
  let s = `<svg viewBox="0 0 120 96" data-dial="speed"><circle class="face" cx="${cx}" cy="${cy}" r="${r + 6}"/>`;
  for (let v = 0; v <= maxV + 0.01; v += 2) {
    const major = v % 10 === 0;
    const [x1, y1] = P(cx, cy, r - (major ? 8 : 4), ang(v)), [x2, y2] = P(cx, cy, r, ang(v));
    s += `<line class="tick ${major ? 'major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    if (major) { const [tx, ty] = P(cx, cy, r - 15, ang(v)); s += `<text class="tl" x="${tx}" y="${ty + 3}">${v}</text>`; }
  }
  if (cap < maxV - 0.1) {
    const [ax, ay] = P(cx, cy, r + 3, ang(cap)), [bx, by] = P(cx, cy, r + 3, ang(maxV));
    s += `<path d="M${ax} ${ay} A${r + 3} ${r + 3} 0 0 1 ${bx} ${by}" fill="none" stroke="#e2503a" stroke-width="3"/>`;
  }
  s += `<text class="tl" x="${cx}" y="${cy + 28}">m/s</text><line class="needle" id="needle-v" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 4}"/><circle class="hub" cx="${cx}" cy="${cy}" r="5"/></svg>`;
  return s;
}

function numRow(id: string, unit: string) {
  return `<div class="numrow"><button data-n="${id}" data-d="-1">−1</button><button data-n="${id}" data-d="-0.1">−.1</button>
    <input id="in-${id}" inputmode="decimal"><span class="unit">${unit}</span>
    <button data-n="${id}" data-d="0.1">+.1</button><button data-n="${id}" data-d="1">+1</button></div>`;
}

const range = (id: string, label: string, min: number, max: number, step: number, val: number, enabled = true, title = '') =>
  `<div class="opt" title="${title}"><span class="label">${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" ${enabled ? '' : 'disabled'}><span class="readout" id="${id}-v"></span></div>`;

function buildFcp() {
  const g = S.game;
  const a = AMMO_BY_ID[g.selected];
  const st = g.stats;
  const fcp = $('#fcp');
  fcpFor = g.selected;
  let html = `<div class="head"><span class="stencil">${a.mode === 'airstrike' ? 'Bomb run' : a.mode === 'drone' ? 'Recon flight' : a.mode === 'saboteur' ? 'Demolition team' : 'Fire control'}</span><span class="label">${a.name}</span></div>`;
  if (a.mode === 'airstrike') {
    const types = st.bombTypes;
    html += `<div class="opts">
      <div class="opt"><span class="label">Approach</span><div class="seg" style="grid-column: span 2"><button data-dir="1" class="${g.strike.dir === 1 ? 'on' : ''}">From west →</button><button data-dir="-1" class="${g.strike.dir === -1 ? 'on' : ''}">← From east</button></div></div>
      ${range('s-alt', 'Release alt.', 8, 45, 0.5, g.strike.alt)}
      ${range('s-dive', 'Dive angle', 0, 70, 1, g.strike.dive, st.dive, st.dive ? '' : 'Research Dive Bombing (Air Wing)')}
      ${range('s-spc', 'Drop interval', 0.2, 8, 0.1, g.strike.spacing, true, 'metres flown between bomb releases')}
      <div class="opt"><span class="label">Ordnance</span><div class="seg" style="grid-column: span 2">
        <button data-ord="he" class="${g.strike.ordnance === 'he' ? 'on' : ''}">GP</button>
        <button data-ord="incendiary" class="${g.strike.ordnance === 'incendiary' ? 'on' : ''}" ${types.includes('incendiary') ? '' : 'disabled title="Research Firebombs"'}>Fire</button>
        <button data-ord="penetrator" class="${g.strike.ordnance === 'penetrator' ? 'on' : ''}" ${types.includes('penetrator') ? '' : 'disabled title="Research AP Bombs"'}>AP</button></div></div>
      <div class="opt"><span class="label">Aim point</span>${numRow('sx', 'm').replace('class="numrow"', 'class="numrow" style="grid-column: span 2;justify-content:flex-start"')}</div>
    </div>
    <div class="hint">${st.bombs} bombs. Click the battlefield to set the aim point. The dashed line is the flight path; rings are release points and impacts${st.dive ? '' : '. Dive angle needs research'}.</div>
    <div class="firerow"><button class="btn firebtn" id="fire">Commit strike</button></div>`;
  } else if (a.mode === 'drone') {
    html += `<div class="hint">Click the battlefield to choose where the drone loiters (${st.droneTime}s). It reveals disguised armor, true HP and load-bearing members.</div>
      <div class="opts"><div class="opt"><span class="label">Loiter x</span>${numRow('dx', 'm').replace('class="numrow"', 'class="numrow" style="grid-column: span 2;justify-content:flex-start"')}</div></div>
      <div class="firerow"><button class="btn firebtn" id="fire">Launch drone</button></div>`;
  } else if (a.mode === 'saboteur') {
    html += `<div class="hint">Click the battlefield to choose where to plant (or leave unset: first wall in the way). Infantry within 13 m will shoot the team. ${st.saboteurs > 1 ? `${st.saboteurs} commandos.` : ''}</div>
      <div class="opts"><div class="opt"><span class="label">Plant at x</span>${numRow('px', 'm').replace('class="numrow"', 'class="numrow" style="grid-column: span 2;justify-content:flex-start"')}</div></div>
      <div class="firerow"><button class="btn firebtn" id="fire">Send team</button><button class="btn ghost small" id="clear-sab">First wall</button></div>`;
  } else {
    html = html.replace('</div>', `<button class="aimtoggle ${S.mouseAim ? 'on' : ''}" id="aimtoggle" title="T: the barrel follows the mouse over the battlefield; the wheel sets muzzle velocity">Mouse aim ${S.mouseAim ? 'on' : 'off'}</button></div>`);
    html += `<div class="dials"><div class="dial">${quadrantSvg(st.minAngle, st.maxAngle)}<div class="label">Elevation</div>${numRow('ang', '°')}</div>
      <div class="dial">${velocitySvg(st.maxSpeed, g.maxSpeedFor)}<div class="label">Muzzle velocity</div>${numRow('vel', 'm/s')}</div></div>
      <div class="opts">
        ${a.id === 'delayed' ? range('o-fuse', 'Fuse delay', 0.5, 8, 0.1, g.fuseSetting) : ''}
        ${a.id === 'cluster' ? range('o-burst', 'Airburst', 0, 5, 0.1, g.airburst, true, '0 = burst manually with tap/space') : ''}
        ${a.id === 'flak' ? range('o-flak', 'Burst time', 0.5, 6, 0.1, g.flakFuse, true, 'bursts on this timer if no aircraft comes within range of the proximity fuze') : ''}
      </div>
      <div class="firerow"><button class="btn firebtn" id="fire">Fire</button></div>`;
  }
  fcp.innerHTML = html;
  fcp.querySelector('#fire')?.addEventListener('click', () => { if (!g.triggerAbility()) g.fire(); });
  fcp.querySelector('#aimtoggle')?.addEventListener('click', () => { S.mouseAim = !S.mouseAim; });
  fcp.querySelector('#clear-sab')?.addEventListener('click', () => { g.sabTarget = null; });
  fcp.querySelectorAll<HTMLElement>('[data-dir]').forEach((b) => b.addEventListener('click', () => { g.strike.dir = +b.dataset.dir! as 1 | -1; buildFcp(); }));
  fcp.querySelectorAll<HTMLElement>('[data-ord]').forEach((b) => b.addEventListener('click', () => { g.strike.ordnance = b.dataset.ord as 'he'; buildFcp(); }));
  const bindRange = (id: string, set: (v: number) => void) => {
    const el = fcp.querySelector<HTMLInputElement>(`#${id}`);
    el?.addEventListener('input', () => set(+el.value));
    el?.addEventListener('change', () => el.blur());
  };
  bindRange('s-alt', (v) => { g.strike.alt = v; });
  bindRange('s-dive', (v) => { g.strike.dive = v; });
  bindRange('s-spc', (v) => { g.strike.spacing = v; });
  bindRange('o-fuse', (v) => { g.fuseSetting = v; });
  bindRange('o-burst', (v) => { g.airburst = v; });
  bindRange('o-flak', (v) => { g.flakFuse = v; });
  const setters: Record<string, (v: number) => void> = {
    ang: (v) => g.setAngleDeg(v),
    vel: (v) => g.setSpeed(v),
    sx: (v) => { g.strike.x = v; },
    dx: (v) => { g.droneTarget = { x: v, y: g.droneTarget?.y ?? g.fortressBounds.y1 + 6 }; },
    px: (v) => { g.sabTarget = v; },
  };
  const getters: Record<string, () => number> = {
    ang: () => (g.angle * 180) / Math.PI, vel: () => g.launchSpeed, sx: () => g.strike.x,
    dx: () => g.droneTarget?.x ?? 0, px: () => g.sabTarget ?? 0,
  };
  fcp.querySelectorAll<HTMLElement>('.numrow button').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.n!;
    setters[k](Math.round((getters[k]() + +b.dataset.d!) * 10) / 10);
  }));
  fcp.querySelectorAll<HTMLInputElement>('.numrow input').forEach((inp) => {
    const k = inp.id.slice(3);
    const commit = () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) setters[k](v); inp.blur(); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); if (e.key === 'Escape') inp.blur(); });
    inp.addEventListener('change', commit);
  });
  // drag the dials directly
  fcp.querySelectorAll<SVGSVGElement>('svg[data-dial]').forEach((svg) => {
    const apply = (e: PointerEvent) => {
      const m = svg.getScreenCTM();
      if (!m) return;
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      const sx = pt.x, sy = pt.y;
      if (svg.dataset.dial === 'angle') g.setAngleDeg((Math.atan2(78 - sy, sx - 16) * 180) / Math.PI);
      else {
        let deg = (Math.atan2(56 - sy, sx - 60) * 180) / Math.PI;
        if (deg < -90) deg += 360;
        g.setSpeed(Math.min(g.maxSpeedFor, ((210 - deg) / 240) * g.stats.maxSpeed));
      }
    };
    svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); apply(e); });
    svg.addEventListener('pointermove', (e) => { if (e.buttons) apply(e); });
  });
}

function updateFcp() {
  const g = S.game;
  if (fcpFor !== g.selected) buildFcp();
  const fcp = $('#fcp');
  const setIn = (id: string, v: number, d = 1) => {
    const el = fcp.querySelector<HTMLInputElement>(`#in-${id}`);
    if (el && document.activeElement !== el) el.value = v.toFixed(d);
  };
  const deg = (g.angle * 180) / Math.PI;
  setIn('ang', deg);
  setIn('vel', g.launchSpeed);
  setIn('sx', g.strike.x);
  setIn('dx', g.droneTarget?.x ?? 0);
  const px = fcp.querySelector<HTMLInputElement>('#in-px');
  if (px && document.activeElement !== px) px.value = g.sabTarget === null ? 'auto' : g.sabTarget.toFixed(1);
  const na = fcp.querySelector('#needle-a');
  if (na) { const [x, y] = P(16, 78, 60, deg); na.setAttribute('x2', `${x}`); na.setAttribute('y2', `${y}`); }
  const nv = fcp.querySelector('#needle-v');
  if (nv) { const [x, y] = P(60, 56, 40, 210 - (g.launchSpeed / g.stats.maxSpeed) * 240); nv.setAttribute('x2', `${x}`); nv.setAttribute('y2', `${y}`); }
  const rv = (id: string, txt: string) => { const el = fcp.querySelector(`#${id}-v`); if (el) el.textContent = txt; };
  rv('s-alt', `${g.strike.alt.toFixed(1)}m`);
  rv('s-dive', `${g.stats.dive ? g.strike.dive.toFixed(0) : 0}°`);
  rv('s-spc', `${g.strike.spacing.toFixed(1)}m`);
  rv('o-fuse', `${g.fuseSetting.toFixed(1)}s`);
  rv('o-burst', g.airburst > 0 ? `${g.airburst.toFixed(1)}s` : 'manual');
  rv('o-flak', `${g.flakFuse.toFixed(1)}s`);
  const at = fcp.querySelector<HTMLElement>('#aimtoggle');
  if (at && at.classList.contains('on') !== S.mouseAim) { at.classList.toggle('on', S.mouseAim); at.textContent = `Mouse aim ${S.mouseAim ? 'on' : 'off'}`; }
  const fire = fcp.querySelector<HTMLButtonElement>('#fire');
  if (fire) {
    const ability = g.hasAbilityProjectile();
    fire.disabled = !ability && !g.canFire();
    const m = AMMO_BY_ID[g.selected].mode;
    const verb = m === 'airstrike' ? 'Commit strike' : m === 'drone' ? 'Launch drone' : m === 'saboteur' ? 'Send team' : 'Fire';
    const left = g.inventory[g.selected] ?? 0;
    const txt = ability ? 'Scatter!' : g.ended ? 'Ceasefire' : left <= 0 ? 'None left' : g.reload > 0 ? `Reloading ${g.reload.toFixed(1)}s` : verb;
    if (fire.textContent !== txt) fire.textContent = txt;
    fire.title = ability ? 'Burst the cluster shell in flight (Space)' : fire.disabled ? '' : `${verb} (Space) · ${left} left`;
  }
}

/** gun hit: shake the meter, pulse the screen edge, float the damage over the gun */
export function gunHit(dmg: number) {
  const hp = document.querySelector<HTMLElement>('#hp');
  if (hp) { hp.classList.remove('hit'); void hp.offsetWidth; hp.classList.add('hit'); }
  const fl = document.querySelector<HTMLElement>('#dmgflash');
  if (fl) { fl.style.opacity = String(Math.min(0.7, 0.2 + dmg / 30)); fl.classList.remove('fade'); void fl.offsetWidth; fl.classList.add('fade'); }
  const box = document.querySelector<HTMLElement>('#floaters');
  if (!box || dmg < 0.5) return;
  const g = S.game;
  const p = S.renderer.worldToScreen(g.barrel.position.x, g.barrel.position.y + 2.3);
  // merge rapid small hits (machine guns) into one rising number
  const last = box.lastElementChild as HTMLElement | null;
  if (last && performance.now() - +(last.dataset.t ?? 0) < 350) {
    const v = +(last.dataset.v ?? 0) + dmg;
    last.dataset.v = String(v); last.dataset.t = String(performance.now());
    last.textContent = `−${Math.round(v)}`;
    return;
  }
  const el = document.createElement('div');
  el.className = `floater ${dmg >= 8 ? 'big' : ''}`;
  el.dataset.v = String(dmg); el.dataset.t = String(performance.now());
  el.textContent = `−${Math.round(dmg)}`;
  el.style.left = `${p.x + (Math.random() - 0.5) * 30}px`;
  el.style.top = `${p.y}px`;
  box.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

export function updateHud() {
  const g = S.game;
  $('#timer').textContent = `T+${fmtTime(g.battleTime)}  ·  par ${fmtTime(g.level.parTime)}`;
  const w = g.wind;
  $('#wind').textContent = g.stats.windReadout ? `${Math.abs(w).toFixed(1)} m/s` : Math.abs(w) < 1.5 ? 'light' : Math.abs(w) < 3 ? 'moderate' : 'strong';
  $('#windarrow').setAttribute('transform', w < 0 ? 'translate(38 0) scale(-1 1)' : '');
  const frac = g.cannonHp / g.stats.cannonHp;
  const hp = $('#hp');
  hp.className = `meter ${frac < 0.25 ? 'crit' : frac < 0.5 ? 'warn' : ''}`;
  hp.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i < Math.ceil(frac * 12)));
  $('#hpnum').textContent = `${Math.ceil(g.cannonHp)}`;
  $('#collateral').textContent = String(Math.round(g.collateral));
  $('#garrison').textContent = `${g.garrison.casualties}/${g.garrison.total}`;
  $('#collateral').style.color = g.collateral > 0 ? 'var(--bad)' : '';
  const hasGuns = g.liveTargets('artillery').length > 0;
  $('#blind-row').classList.toggle('hidden', !hasGuns);
  $('#blind').textContent = g.enemyBlind > 0 ? `blind ${Math.ceil(g.enemyBlind)}s` : `fires in ${Math.max(0, Math.ceil(g.artT))}s`;
  document.querySelectorAll<HTMLElement>('.slot').forEach((el) => {
    const id = el.dataset.a as AmmoId;
    const n = g.inventory[id] ?? 0;
    el.querySelector('.ct')!.textContent = String(n);
    el.classList.toggle('sel', g.selected === id);
    el.classList.toggle('empty', n <= 0);
    (el.querySelector('.reload') as HTMLElement).style.width = g.selected === id ? `${(g.reload / g.stats.reload) * 100}%` : '0';
  });
  updateFcp();
  drawMinimap();
}

// ───────────────────────── minimap ─────────────────────────
function mapBounds() {
  const g = S.game;
  const fb = g.fortressBounds;
  return { x0: g.level.cannonX - 8, x1: Math.max(fb.x1, ...g.level.houses.map((h) => h.x + h.w)) + 6, y1: fb.y1 + 8 };
}
const MAT_COL: Record<string, string> = { earth: '#7a6646', tile: '#8c4434', plaster: '#d8d4c6', fuel: '#9c9a80', wood: '#9a6b3c', stone: '#9b978c', concrete: '#8f969d', steel: '#6b7684', reactive: '#717d58', fireproof: '#a7613f', crate: '#7a7240', rock: '#555' };
let mmTick = 0;
export function drawMinimap() {
  if (mmTick++ % 3) return;
  const c = document.querySelector<HTMLCanvasElement>('#minimap');
  if (!c) return;
  const g = S.game, r = S.renderer;
  const ctx = c.getContext('2d')!;
  const W = c.width, H = c.height;
  const b = mapBounds();
  const sx = W / (b.x1 - b.x0);
  const sy = Math.min(sx * 1.6, (H - 8) / b.y1);
  const X = (x: number) => (x - b.x0) * sx, Y = (y: number) => H - 4 - y * sy;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(10,12,15,0.55)'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#3d3a2c';
  ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = b.x0; x <= b.x1; x += 2) ctx.lineTo(X(x), Y(g.groundY(x)));
  ctx.lineTo(W, H); ctx.fill();
  for (const bl of g.blocks) {
    if (bl.dead) continue;
    const t = bl.body.translation();
    ctx.fillStyle = bl.target ? TARGETS[bl.target].color : MAT_COL[g.shownMat(bl)] ?? '#888';
    ctx.fillRect(X(t.x - bl.w / 2), Y(t.y + bl.h / 2), Math.max(1, bl.w * sx), Math.max(1, bl.h * sy));
  }
  ctx.fillStyle = '#d8c9a8';
  for (const h of g.houses) if (!h.dead) ctx.fillRect(X(h.def.x), Y(g.groundY(h.def.x) + h.def.h), h.def.w * sx, h.def.h * sy);
  ctx.fillStyle = '#ff5a1f';
  ctx.fillRect(X(g.level.cannonX) - 2, Y(g.groundY(g.level.cannonX) + 1.5), 5, 5);
  for (const p of g.projectiles) if (!p.dead) { ctx.fillStyle = p.enemy ? '#e2503a' : '#ffd34d'; ctx.fillRect(X(p.x) - 1, Y(p.y) - 1, 3, 3); }
  for (const p of g.planes) { ctx.fillStyle = '#ffb347'; ctx.fillRect(X(p.x) - 3, Y(p.y) - 1, 7, 3); }
  for (const u of g.air.units) { ctx.fillStyle = u.down ? '#777' : '#e2503a'; const w = u.kind === 'airship' ? 9 : 4; ctx.fillRect(X(u.x) - w / 2, Y(u.y) - 1.5, w, 3); }
  for (const s of g.soldiers) if (!s.dead) { ctx.fillStyle = '#c9d6a0'; ctx.fillRect(X(s.x), Y(s.y + 1.3), 1.5, 3); }
  ctx.strokeStyle = 'rgba(255,179,71,0.9)'; ctx.lineWidth = 1.5;
  ctx.strokeRect(X(r.cx - r.viewW / 2), Y(r.cy + r.viewH / 2), r.viewW * sx, r.viewH * sy);
}

export function buildLabels() {
  clearLabels();
  const box = $('#labels');
  for (const b of S.game.blocks) {
    if (!b.target) continue;
    const el = document.createElement('div');
    const t = TARGETS[b.target];
    el.className = `tlabel ${S.game.level.objectives.includes(b.target) ? 'obj' : ''}`;
    el.style.color = t.color;
    el.style.borderColor = t.color;
    el.innerHTML = `${t.label}<div class="hp"><i></i></div>`;
    box.appendChild(el);
    labels.set(b, el);
  }
}
export function clearLabels() { labels.forEach((el) => el.remove()); labels.clear(); }
export function updateLabels() {
  labels.forEach((el, b) => {
    if (b.dead) { el.remove(); labels.delete(b); return; }
    const t = b.body.translation();
    const s = S.renderer.worldToScreen(t.x, t.y + b.h / 2 + 0.25);
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    (el.querySelector('.hp i') as HTMLElement).style.width = `${Math.max(0, (b.hp / b.maxHp) * 100)}%`;
  });
}

export function hideTooltip() { document.querySelector('#tooltip')?.classList.add('hidden'); }

export function updateTooltip(mouse: { x: number; y: number }, hide: boolean) {
  const tip = document.querySelector<HTMLElement>('#tooltip');
  if (!tip) return;
  if (hide) { tip.classList.add('hidden'); return; }
  const w = S.renderer.screenToWorld(mouse.x, mouse.y);
  const b = S.game.pickBlock(w.x, w.y);
  if (!b) { tip.classList.add('hidden'); return; }
  const known = S.game.revealed || !b.def.disguise;
  tip.innerHTML = blockTip(S.game.shownMat(b), known, b.hp, b.maxHp, b.target ? TARGETS[b.target].label : undefined, !!b.highlight, b.burning > 0);
  tip.classList.remove('hidden');
  tip.style.left = `${Math.min(mouse.x + 16, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${mouse.y + 18 + tip.offsetHeight > window.innerHeight - 8 ? mouse.y - tip.offsetHeight - 10 : mouse.y + 18}px`;
}

export const MIN_SPEED = PHYS.minSpeed;
