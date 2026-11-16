import './style.css';
import RAPIER from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { AMMO_BY_ID } from './config';
import { Game } from './game';
import { rackIds, toast, updateHud, updateLabels, updateObjectives, updateTooltip } from './hud';
import { writeSave } from './progress';
import { Renderer, loadTextures } from './render';
import { showMap, showResult } from './screens';
import { $, S } from './state';

THREE.ColorManagement.enabled = false;

const canvas = $<HTMLCanvasElement>('#view');

// ───────────────────────── input ─────────────────────────
let down: { x: number; y: number; btn: number; pan: number } | null = null;
let aiming = false;
let mouse = { x: 0, y: 0 };
const isTargeting = () => { const m = AMMO_BY_ID[S.game.selected].mode; return m === 'airstrike' || m === 'drone' || m === 'saboteur'; };

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  down = { x: e.clientX, y: e.clientY, btn: e.button, pan: S.game.pan };
  aiming = false;
});
canvas.addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (!down) return;
  const g = S.game, r = S.renderer;
  const dx = e.clientX - down.x, dy = e.clientY - down.y;
  if (down.btn !== 0 || S.mode !== 'battle' || isTargeting()) {
    if (down.btn !== 0 || S.mode !== 'battle' || Math.hypot(dx, dy) > 12) g.pan = down.pan - (dx / r.width) * r.viewW;
    return;
  }
  if (!aiming && Math.hypot(dx, dy) > 10) aiming = true;
  if (aiming) {
    g.setAngleDeg((Math.atan2(dy, -dx) * 180) / Math.PI); // pull back like a sling
    g.setSpeed(6 + (g.stats.maxSpeed - 6) * Math.min(1, Math.hypot(dx, dy) / Math.min(320, r.height * 0.4)));
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const d = down;
  down = null;
  if (S.mode !== 'battle' || d.btn !== 0) return;
  const g = S.game;
  if (aiming) { aiming = false; g.fire(); return; }
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
  if (g.triggerAbility()) return;
  // clicking the battlefield places the target for planned (non-gun) munitions
  const w = S.renderer.screenToWorld(e.clientX, e.clientY);
  const mode = AMMO_BY_ID[g.selected].mode;
  if (mode === 'airstrike') g.strike.x = w.x;
  else if (mode === 'drone') g.droneTarget = { x: w.x, y: Math.max(w.y, g.groundY(w.x) + 4) };
  else if (mode === 'saboteur') g.sabTarget = w.x;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  S.game.zoom = Math.max(0.5, Math.min(4, S.game.zoom * Math.exp(-e.deltaY * 0.0012)));
}, { passive: false });

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (S.mode !== 'battle' || (e.target as HTMLElement).tagName === 'INPUT') return;
  keys.add(e.key);
  const g = S.game;
  if (e.key === ' ') { e.preventDefault(); if (!g.triggerAbility()) g.fire(); }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9) { const ids = rackIds(); if (ids[n - 1]) g.selected = ids[n - 1]; }
  if (e.key === 'r' || e.key === 'R') { g.zoom = 1; g.pan = 0; }
});
window.addEventListener('keyup', (e) => keys.delete(e.key));

function handleKeys(dt: number) {
  const g = S.game;
  const fine = keys.has('Shift') ? 0.15 : 1;
  const deg = (g.angle * 180) / Math.PI;
  if (keys.has('ArrowUp')) g.setAngleDeg(deg + dt * 20 * fine);
  if (keys.has('ArrowDown')) g.setAngleDeg(deg - dt * 20 * fine);
  if (keys.has('ArrowRight')) g.setSpeed(g.speed + dt * 8 * fine);
  if (keys.has('ArrowLeft')) g.setSpeed(g.speed - dt * 8 * fine);
}

// ───────────────────────── loop ─────────────────────────
let last = performance.now();
let acc = 0;
let focusHold = 0;
let lastFocus: { x: number; y: number } | null = null;

function pickFocus(): { x: number; y: number } | null {
  const g = S.game;
  const own = g.projectiles.filter((p) => !p.enemy && !p.dead && !p.pellet);
  if (own.length) { const p = own[own.length - 1]; return { x: p.x, y: p.y }; }
  if (g.planes.length) return { x: g.planes[0].x, y: g.planes[0].y };
  if (g.drones.length) return { x: g.drones[0].x, y: g.drones[0].y };
  if (g.saboteurs.length) return { x: g.saboteurs[0].x + 4, y: g.saboteurs[0].y + 4 };
  return null;
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const g = S.game;
  const live = S.mode === 'battle' || S.mode === 'result';
  if (live) {
    if (S.mode === 'battle') handleKeys(dt);
    acc += dt;
    let steps = 0;
    while (acc >= 1 / 60 && steps < 4) { g.update(1 / 60); acc -= 1 / 60; steps++; }
    if (steps >= 4) acc = 0;
    for (const ev of g.events) {
      if (ev.type === 'toast') toast(ev.text, ev.tone);
      else if (ev.type === 'target') updateObjectives();
      else if (ev.type === 'end') showResult(ev.win, ev.reason);
    }
    g.events.length = 0;
    const f = pickFocus();
    if (f) { lastFocus = f; focusHold = 1.2; } else focusHold -= dt;
    g.focus = f ?? (focusHold > 0 ? lastFocus : null);
  } else {
    g.time += dt;
    g.focus = null;
    g.syncMeshes();
  }
  g.frameCamera(false, dt);
  const a = AMMO_BY_ID[g.selected];
  if (S.mode === 'battle') {
    g.updatePreview(aiming || (a.mode !== 'airstrike' && !g.focus));
    g.updateStrikePreview(a.mode === 'airstrike' && g.planes.length === 0);
    const tgt = a.mode === 'drone' ? g.droneTarget?.x : a.mode === 'saboteur' ? g.sabTarget : null;
    g.aimMarker.visible = tgt !== null && tgt !== undefined;
    if (g.aimMarker.visible) g.aimMarker.position.set(tgt!, a.mode === 'drone' ? g.droneTarget!.y : g.groundY(tgt!) + 0.5, 13);
    updateHud();
  } else {
    g.updatePreview(false);
    g.updateStrikePreview(false);
    g.aimMarker.visible = false;
  }
  if (live) updateLabels();
  if (S.mode === 'battle' || S.mode === 'armory') updateTooltip(mouse, !!down);
  S.renderer.render(dt, now / 1000);
  requestAnimationFrame(frame);
}

// ───────────────────────── boot ─────────────────────────
async function boot() {
  await Promise.all([RAPIER.init(), loadTextures()]);
  S.renderer = new Renderer(canvas, (x) => S.game?.groundY(x) ?? 0);
  S.renderer.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  S.game = new Game(S.renderer);
  if (new URLSearchParams(location.search).has('dev')) { S.save.dev = true; writeSave(S.save); }
  window.addEventListener('resize', () => S.renderer.resize());
  (window as unknown as { siege: unknown }).siege = S;
  showMap();
  requestAnimationFrame(frame);
}
boot();
