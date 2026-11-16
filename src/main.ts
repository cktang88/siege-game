import './style.css';
import RAPIER from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { audio } from './audio';
import { AMMO_BY_ID } from './config';
import { Game } from './game';
import { gunHit, hideTooltip, rackIds, toast, updateHud, updateLabels, updateObjectives, updateTooltip } from './hud';
import { writeSave } from './progress';
import { Renderer, loadTextures } from './render';
import { showMap, showResult } from './screens';
import { $, S } from './state';

THREE.ColorManagement.enabled = false;

const canvas = $<HTMLCanvasElement>('#view');

// ───────────────────────── input ─────────────────────────
let down: { x: number; y: number; btn: number; pan: number; dragged: boolean } | null = null;
let mouse = { x: 0, y: 0 };
/** the pointer is over the open battlefield (not over a HUD panel, which sits above the canvas) */
let overField = false;
const isTargeting = () => { const m = AMMO_BY_ID[S.game.selected].mode; return m === 'airstrike' || m === 'drone' || m === 'saboteur'; };
/** gun-type munitions are aimed by pointing the mouse */
const isGun = () => S.mode === 'battle' && !isTargeting();
const mouseAiming = () => isGun() && S.mouseAim && overField;
/** typing in a text field must never trigger shortcuts (range sliders and checkboxes don't count) */
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type);
};

/** point the barrel at the cursor */
function aimAtMouse() {
  const g = S.game;
  const w = S.renderer.screenToWorld(mouse.x, mouse.y);
  const p = g.barrel.position;
  const dx = w.x - p.x, dy = w.y - p.y;
  if (Math.hypot(dx, dy) < 0.6) return;
  // behind the gun: pin to the nearest stop instead of flipping across the arc
  const deg = dx >= 0 ? (Math.atan2(dy, dx) * 180) / Math.PI : dy >= 0 ? 90 : -90;
  g.setAngleDeg(deg);
}

// audio can only start from a gesture
const wake = () => { audio.unlock(); audio.startMusic(); };
window.addEventListener('pointerdown', wake, { capture: true });
window.addEventListener('keydown', wake, { capture: true });
document.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button, .node, .tnode')) audio.play('click'); });
window.addEventListener('keydown', (e) => { if ((e.key === 'm' || e.key === 'M') && !typing(e.target) && !e.ctrlKey && !e.metaKey) audio.toggleMute(); });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerenter', () => { overField = true; });
canvas.addEventListener('pointerleave', () => { overField = false; });
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  // clicking the field takes focus away from any HUD control, so keyboard shortcuts work again
  (document.activeElement as HTMLElement | null)?.blur?.();
  down = { x: e.clientX, y: e.clientY, btn: e.button, pan: S.game.pan, dragged: false };
});
canvas.addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  overField = true;
  if (mouseAiming() && (!down || !down.dragged)) aimAtMouse();
  if (!down) return;
  const g = S.game, r = S.renderer;
  const dx = e.clientX - down.x, dy = e.clientY - down.y;
  if (!down.dragged && (down.btn !== 0 || Math.hypot(dx, dy) > 12)) down.dragged = true;
  // any drag pans the view (left, middle or right button)
  if (down.dragged) g.pan = down.pan - (dx / r.width) * r.viewW;
});
const release = () => { down = null; };
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', release);
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const d = down;
  down = null;
  if (S.mode !== 'battle' || d.btn !== 0 || d.dragged) return;
  const g = S.game;
  // a click bursts a cluster shell in flight; otherwise it fires the gun or places a planned strike
  if (g.triggerAbility()) return;
  const mode = AMMO_BY_ID[g.selected].mode;
  if (!isTargeting()) {
    if (S.mouseAim) aimAtMouse();
    g.fire();
    return;
  }
  const w = S.renderer.screenToWorld(e.clientX, e.clientY);
  if (mode === 'airstrike') g.strike.x = w.x;
  else if (mode === 'drone') g.droneTarget = { x: w.x, y: Math.max(w.y, g.groundY(w.x) + 4) };
  else if (mode === 'saboteur') g.sabTarget = w.x;
});
const zoomBy = (f: number) => { S.game.zoom = Math.max(0.5, Math.min(4, S.game.zoom * f)); };
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const g = S.game;
  const delta = e.deltaY || e.deltaX; // shift+wheel scrolls sideways on some systems
  // over the battlefield with a gun selected the wheel sets muzzle velocity; Ctrl+wheel (or pinch) zooms
  if (isGun() && !e.ctrlKey && !e.metaKey) {
    const step = e.shiftKey ? 1 : 0.2;
    const notches = Math.max(-5, Math.min(5, -delta / (e.deltaMode === 1 ? 3 : 100)));
    g.setSpeed(Math.min(g.maxSpeedFor, Math.round((g.launchSpeed + notches * step) * 10) / 10));
    return;
  }
  zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.006 : 0.0012)));
}, { passive: false });

const keys = new Set<string>();
const keyName = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
window.addEventListener('keydown', (e) => {
  if (S.mode !== 'battle' || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const g = S.game;
  const k = keyName(e);
  // Space must not also "click" a focused HUD button
  if (k === ' ') { e.preventDefault(); if (!e.repeat && !g.triggerAbility()) g.fire(); return; }
  // arrows on a focused slider move the slider only
  if ((e.target as HTMLInputElement).type === 'range' && k.startsWith('Arrow')) return;
  if (k.startsWith('Arrow')) e.preventDefault();
  keys.add(k);
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9) { const ids = rackIds(); if (ids[n - 1]) g.selected = ids[n - 1]; }
  if (k === 'r') { g.zoom = 1; g.pan = 0; g.panY = 0; }
  if (k === 't') { S.mouseAim = !S.mouseAim; toast(S.mouseAim ? 'Mouse aim on' : 'Mouse aim off: dials, keys and typed values only'); }
});
window.addEventListener('keyup', (e) => { keys.delete(keyName(e)); keys.delete(e.key); });
// keys held while the window loses focus would otherwise stay "down" forever
window.addEventListener('blur', () => { keys.clear(); down = null; });

function handleKeys(dt: number) {
  const g = S.game;
  const fine = keys.has('Shift') ? 0.15 : 1;
  const deg = (g.angle * 180) / Math.PI;
  if (keys.has('ArrowUp')) g.setAngleDeg(deg + dt * 20 * fine);
  if (keys.has('ArrowDown')) g.setAngleDeg(deg - dt * 20 * fine);
  if (keys.has('ArrowRight')) g.setSpeed(Math.min(g.maxSpeedFor, g.launchSpeed + dt * 8 * fine));
  if (keys.has('ArrowLeft')) g.setSpeed(g.launchSpeed - dt * 8 * fine);
  if (keys.has('e')) zoomBy(Math.exp(dt * 1.5));
  if (keys.has('q')) zoomBy(Math.exp(-dt * 1.5));
  // WASD scrolls the camera (pan speed scales with how much is in view; Shift faster)
  const span = S.renderer.viewW;
  const fast = keys.has('Shift') ? 2.2 : 1;
  if (keys.has('a')) g.pan -= span * 0.6 * dt * fast;
  if (keys.has('d')) g.pan += span * 0.6 * dt * fast;
  if (keys.has('w')) g.panY += S.renderer.viewH * 0.6 * dt * fast;
  if (keys.has('s')) g.panY = Math.max(-S.renderer.viewH * 0.25, g.panY - S.renderer.viewH * 0.6 * dt * fast);
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
      else if (ev.type === 'gunhit') gunHit(ev.dmg);
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
  // (the camera lifts the ground line above the fire-control panel itself: Game.viewGroundFrac)
  g.frameCamera(false, dt);
  const a = AMMO_BY_ID[g.selected];
  if (S.mode === 'battle') {
    g.updatePreview(a.mode !== 'airstrike' && a.mode !== 'drone' && a.mode !== 'saboteur' && (mouseAiming() || !g.focus));
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
  if (S.mode === 'battle' || (S.mode === 'armory' && S.survey)) updateTooltip(mouse, !!down?.dragged || !overField);
  else hideTooltip();
  audio.lx = S.renderer.cx;
  audio.half = S.renderer.viewW / 2;
  audio.intensity = S.mode !== 'battle' ? 0 : g.soldiers.some((x) => !x.dead) || g.liveTargets('artillery').length ? 2 : 1;
  S.renderer.render(dt, now / 1000);
  requestAnimationFrame(frame);
}

// ───────────────────────── boot ─────────────────────────
async function boot() {
  await Promise.all([RAPIER.init(), loadTextures()]);
  S.renderer = new Renderer(canvas, (x) => S.game?.groundY(x) ?? 0);
  S.renderer.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  S.game = new Game(S.renderer);
  // ?dev turns dev mode on for this browser session only; it is never written into the save
  if (new URLSearchParams(location.search).has('dev')) { S.save.dev = true; writeSave(S.save); }
  window.addEventListener('resize', () => S.renderer.resize());
  (window as unknown as { siege: unknown }).siege = S;
  showMap();
  requestAnimationFrame(frame);
}
boot();
