import RAPIER from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { MATERIALS, type AmmoId, type MatId } from './config';
import type { Block, Game } from './game';
import type { BlockDef } from './levels';
import { blockGeometry, makeBlockMaterial } from './render';
import { MAX_MARKS, MarkType, writeMarks, type Mark } from './decals';
import { audio } from './audio';

/*
  Block fracture. Damage paths in game.ts report each hit here (Fracture.hit: where, which way, how
  much, by what); at the end of the frame (outside the physics step and the event drain, so bodies can
  be created and removed safely) each struck block is resolved:

   - marks: every hit leaves a decal on the block (src/decals.ts): craters and chips from shot, soot
     from blasts, clean holes and a bore from penetrators, dents on steel, pockmarks from canister;
   - splits: a heavy hit cuts the block's convex outline with one or more lines (or Voronoi cells
     round the impact) and the pieces replace it as physics blocks with the matching share of HP and
     mass (Rapier convex hulls; the renderer draws convex outlines). Brittle materials crack and
     shatter, timber splinters along the grain, steel only tears under AP and buried charges, earth
     just loses mass off the struck face;
   - a block killed by a big hit (not by fire or attrition) bursts into short-lived rubble.

  Small pieces become non-colliding fragments that tumble and fade; mid-sized ones are rubble that
  collides for a few seconds and crumbles; large ones stay. Caps (MAX_LIVE, MAX_RUBBLE, MAX_FX, a
  per-frame budget) keep the big castles cheap.

  A piece inherits the original's material, disguise, fire, char, marks and texture (pattern space:
  uOff/uFull in the block shader), its target (the largest piece, if it keeps at least 40% of the
  block; otherwise an objective does not split at all) and its place in rooms, garrison floors,
  backdrops and stuck charges (heir links; Block.heir points from the old block to its successor).
*/

type P = [number, number];
type V2 = { x: number; y: number };

export type HitKind = 'shot' | 'glance' | 'blast' | 'ap' | 'apStop' | 'pellet' | 'charge' | 'impact';
export interface Hit {
  kind: HitKind;
  /** world point of the hit (surface point for blasts) */
  x: number; y: number;
  /** unit direction of travel (for blasts: away from the burst) */
  dx: number; dy: number;
  /** damage dealt (before HP clamping) */
  e: number;
  ammo?: AmmoId;
  /** projectile radius */
  r?: number;
  /** exit point (penetrators that went through) */
  ex?: number; ey?: number;
  /** incendiary blast: soot only */
  fire?: boolean;
  /** a solid shot's own little blast: counts toward the hit, leaves no soot */
  quiet?: boolean;
  /** impact speed (m/s) and cos(obliquity) of the blow: slow or oblique rounds scuff, square fast ones break */
  speed?: number;
  cosI?: number;
}

interface FracState { off: P; full: P; marks: Mark[]; gen: number; rubble: number; fade: number }
interface Snap { t: V2; rot: number; v: V2; av: number; hp: number }
interface Frag { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; x: number; y: number; vx: number; vy: number; rot: number; vr: number; life: number; max: number; r: number }

/** most blocks (live) the world may hold; past it, splits keep only the main piece */
const MAX_LIVE = 600;
/** collidable short-lived rubble pieces */
const MAX_RUBBLE = 40;
/** non-colliding fading fragments */
const MAX_FX = 80;
/** splits resolved per frame (the rest of that frame's hits just leave marks) */
const PER_FRAME = 4;
/** pieces smaller than this (m²), or thinner than MIN_THICK, are fragments */
const MIN_AREA = 0.07;
const MIN_THICK = 0.13;
/** pieces below this area (m²) are short-lived rubble */
const RUBBLE_AREA = 0.28;
/** fracture generations: a piece of a piece of a piece no longer splits */
const MAX_GEN = 3;

type Cls = 'brittle' | 'timber' | 'steel' | 'earth' | 'none';
const CLS: Partial<Record<MatId, Cls>> = {
  stone: 'brittle', concrete: 'brittle', fireproof: 'brittle', plaster: 'brittle', tile: 'brittle',
  wood: 'timber', crate: 'timber', steel: 'steel', fuel: 'steel', earth: 'earth',
};
/** how worn (share of HP gone) a block must be before an ordinary hit breaks it, relative to its class
 *  default: reinforced concrete holds together nearly to the end */
const WORN: Partial<Record<MatId, number>> = { concrete: 1.15 };
const clsOf = (b: Block): Cls => (b.mat.indestructible ? 'none' : CLS[b.matId] ?? 'none');

// ───────────────────────── convex polygon helpers (CCW, block-local) ─────────────────────────
export function polyArea(p: P[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; a += x0 * y1 - x1 * y0; }
  return a / 2;
}
function centroid(p: P[]): P {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-9) return p.reduce((s, q) => [s[0] + q[0] / p.length, s[1] + q[1] / p.length], [0, 0] as P);
  return [cx / (3 * a), cy / (3 * a)];
}
/** keep the part with nx*x + ny*y <= c */
export function clipPoly(p: P[], nx: number, ny: number, c: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const da = nx * a[0] + ny * a[1] - c, db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
/** drop near-duplicate and collinear points, then trim to 8 vertices (the shader's edge budget) */
function simplify(p: P[]): P[] {
  let q = p.filter((v, i) => { const w = p[(i + 1) % p.length]; return Math.hypot(v[0] - w[0], v[1] - w[1]) > 0.015; });
  const cross = (a: P, b: P, c: P) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  let changed = true;
  while (changed && q.length > 3) {
    changed = false;
    for (let i = 0; i < q.length; i++) {
      const a = q[(i + q.length - 1) % q.length], b = q[i], c = q[(i + 1) % q.length];
      if (cross(a, b, c) < 1e-4) { q.splice(i, 1); changed = true; break; }
    }
  }
  while (q.length > 8) {
    let best = 0, bv = Infinity;
    for (let i = 0; i < q.length; i++) {
      const v = cross(q[(i + q.length - 1) % q.length], q[i], q[(i + 1) % q.length]);
      if (v < bv) { bv = v; best = i; }
    }
    q.splice(best, 1);
  }
  return q;
}
function bbox(p: P[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
function inside(p: P[], x: number, y: number) {
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return true;
}
/** the block's outline in its body frame (centred on the bounding box) */
export function localPoly(b: Block): P[] {
  const d = b.def, w = b.w, h = b.h;
  return d.poly ? d.poly.map(([x, y]) => [x - w / 2, y - h / 2] as P) : [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
}
/** cut along the line through q with direction (ux, uy), leaving a kerf */
function cutLine(p: P[], qx: number, qy: number, ux: number, uy: number, kerf: number): P[][] {
  const nx = -uy, ny = ux, c = nx * qx + ny * qy;
  return [clipPoly(p, nx, ny, c - kerf / 2), clipPoly(p, -nx, -ny, -(c + kerf / 2))].filter((q) => q.length >= 3);
}
/** Voronoi cells of the outline round these seeds */
function voronoi(p: P[], seeds: P[], kerf: number): P[][] {
  const out: P[][] = [];
  for (let i = 0; i < seeds.length; i++) {
    let cell = p;
    const [sx, sy] = seeds[i];
    for (let j = 0; j < seeds.length && cell.length >= 3; j++) {
      if (j === i) continue;
      const [tx, ty] = seeds[j];
      const nx = tx - sx, ny = ty - sy, len = Math.hypot(nx, ny);
      if (len < 1e-4) continue;
      const c = (tx * tx + ty * ty - sx * sx - sy * sy) / 2 / len;
      cell = clipPoly(cell, nx / len, ny / len, c - kerf / 2);
    }
    if (cell.length >= 3) out.push(cell);
  }
  return out;
}
const thick = (p: P[]) => { const b = bbox(p); return Math.abs(polyArea(p)) / Math.max(1e-6, Math.max(b.w, b.h)); };

export class Fracture {
  private st = new WeakMap<Block, FracState>();
  private hits = new Map<Block, Hit[]>();
  private snaps = new Map<Block, Snap>();
  private fx: Frag[] = [];
  private rubble: Block[] = [];
  private dirty = new Set<Block>();
  private live = 0;
  /** counters, for tests and tuning */
  stats = { splits: 0, pieces: 0, frags: 0, rubble: 0, marks: 0, shatters: 0 };

  constructor(private g: Game) {}

  clear() {
    for (const f of this.fx) { f.mesh.parent?.remove(f.mesh); f.mesh.geometry.dispose(); f.mat.dispose(); }
    this.fx = []; this.rubble = []; this.hits.clear(); this.snaps.clear(); this.dirty.clear();
    this.stats = { splits: 0, pieces: 0, frags: 0, rubble: 0, marks: 0, shatters: 0 };
  }

  state(b: Block): FracState {
    let s = this.st.get(b);
    if (!s) { s = { off: [0, 0], full: [b.w, b.h], marks: [], gen: 0, rubble: -1, fade: 1 }; this.st.set(b, s); }
    return s;
  }
  marks(b: Block): readonly Mark[] { return this.st.get(b)?.marks ?? []; }
  isRubble(b: Block) { return (this.st.get(b)?.rubble ?? -1) >= 0; }

  /** game time until which a block takes no fall/jolt ('impact') damage: just struck by a round (the
   *  round's own damage covers the blow; the solver's jolt would count it twice) or just split off */
  private graceT = new WeakMap<Block, number>();
  inGrace(b: Block) { return (this.graceT.get(b) ?? -1) > this.g.time; }
  /** collider handles each penetrator has already gone through (a bored block still stands) */
  private passed = new WeakMap<object, Set<number>>();
  passedBy(p: object): Set<number> { let s = this.passed.get(p); if (!s) { s = new Set(); this.passed.set(p, s); } return s; }

  /** report a hit on a block (call before the damage is applied) */
  hit(b: Block, h: Hit) {
    if (b.dead || b.mat.indestructible || !(h.e > 0)) return;
    if (h.kind !== 'blast' && h.kind !== 'impact') this.graceT.set(b, this.g.time + 0.25);
    const l = this.hits.get(b);
    if (l) l.push(h); else this.hits.set(b, [h]);
  }

  /** destroyBlock calls this before the body goes: a block killed by a big hit bursts into rubble */
  onDestroy(b: Block) {
    if (!this.hits.has(b) || this.isRubble(b) || b.w * b.h < 0.45) return;
    const c = clsOf(b);
    if (c !== 'brittle' && c !== 'timber') return;
    const t = b.body.translation(), v = b.body.linvel();
    this.snaps.set(b, { t: { x: t.x, y: t.y }, rot: b.body.rotation(), v: { x: v.x, y: v.y }, av: b.body.angvel(), hp: b.hp });
  }

  /**
   * An armour-piercing round goes right through block b (entry point, unit direction). A slender
   * member crossed side-on is cut in two along the shot line; a thick block is bored through and
   * survives (badly hurt). Returns where the round leaves the block, or null when the block should
   * simply be destroyed (the old rule).
   */
  apThrough(b: Block, x: number, y: number, dir: V2, ammo: AmmoId): V2 | null {
    if (b.dead || b.target) return null;
    const cls = clsOf(b);
    if (cls === 'none' || cls === 'earth') return null;
    // fused penetrators (bunker buster, AP bomb) wreck what they bore through on their way to the charge
    if (ammo === 'bunker' || ammo === 'bomb_pen') return null;
    // exit point: cast back at this block from beyond it
    const L = Math.hypot(b.w, b.h) + 1;
    const ray = new RAPIER.Ray({ x: x + dir.x * L, y: y + dir.y * L }, { x: -dir.x, y: -dir.y });
    const toi = b.collider.castRay(ray, L, true);
    if (toi === null || toi < 0) return null;
    const ex = x + dir.x * (L - toi), ey = y + dir.y * (L - toi);
    const rot = b.body.rotation();
    const lu = b.w >= b.h ? { x: Math.cos(rot), y: Math.sin(rot) } : { x: -Math.sin(rot), y: Math.cos(rot) };
    const aspect = Math.max(b.w, b.h) / Math.max(0.01, Math.min(b.w, b.h));
    const across = Math.abs(dir.x * lu.x + dir.y * lu.y) < 0.85;
    if (aspect >= 1.8 && across && this.state(b).gen < MAX_GEN) {
      this.hit(b, { kind: 'ap', x, y, dx: dir.x, dy: dir.y, ex, ey, e: b.maxHp * 0.3, ammo });
      this.g.damageBlock(b, b.maxHp * 0.3, 'ap');
      return { x: ex, y: ey };
    }
    if (Math.min(b.w, b.h) >= 1.1 && b.w * b.h >= 1.4) {
      this.hit(b, { kind: 'ap', x, y, dx: dir.x, dy: dir.y, ex, ey, e: b.maxHp * 0.5, ammo });
      this.g.damageBlock(b, b.maxHp * 0.5, 'ap');
      return { x: ex, y: ey };
    }
    return null;
  }

  // ───────────────────────── per frame ─────────────────────────
  update(dt: number) {
    const g = this.g;
    if (this.hits.size || this.snaps.size) {
      this.live = 0;
      for (const b of g.blocks) if (!b.dead) this.live++;
      let budget = PER_FRAME;
      for (const [b, hs] of this.hits) {
        if (b.dead) continue;
        budget -= this.resolve(b, hs, budget > 0) ? 1 : 0;
      }
      for (const [b, s] of this.snaps) {
        if (budget <= 0) break;
        const hs = this.hits.get(b);
        if (hs && this.burst(b, s, hs)) budget--;
      }
      this.hits.clear();
      this.snaps.clear();
    }
    // rubble crumbles away after a few seconds
    if (this.rubble.length) {
      for (const b of this.rubble) {
        if (b.dead) continue;
        const s = this.state(b);
        s.rubble -= dt;
        if (s.rubble > 0) continue;
        s.fade -= dt * 2;
        b.uni.uFade.value = Math.max(0, s.fade);
        if (s.fade <= 0) {
          const t = b.body.translation();
          const c = new THREE.Color(...MATERIALS[g.shownMat(b)].color);
          for (let i = 0; i < 3; i++) g.r.debris.spawn(t.x, t.y, (Math.random() - 0.5) * 1.5, Math.random() * 1.5, 0.08 + Math.random() * 0.1, c.clone().multiplyScalar(0.8 + Math.random() * 0.3));
          this.retire(b);
        }
      }
      this.rubble = this.rubble.filter((b) => !b.dead);
    }
    this.updateFx(dt);
    for (const b of this.dirty) if (!b.dead) writeMarks(b.uni, this.state(b).marks);
    this.dirty.clear();
  }

  /** marks for every hit, then perhaps a split. Returns true if the block split. */
  private resolve(b: Block, hs: Hit[], canSplit: boolean): boolean {
    let sum = 0, dom = hs[0];
    for (const h of hs) { sum += h.e; if (h.e > dom.e || (dom.quiet && !h.quiet)) dom = h; }
    for (const h of hs) this.markHit(b, h);
    if (!canSplit) return false;
    const s = this.state(b);
    if (s.gen >= MAX_GEN || s.rubble >= 0) return false;
    const f = sum / b.maxHp;
    const cls = clsOf(b);
    const area = Math.abs(polyArea(localPoly(b)));
    const minDim = Math.min(b.w, b.h);
    // the cut that an AP round made on its way through
    const ap = hs.find((h) => h.kind === 'ap');
    if (ap && ap.ex !== undefined) {
      const aspect = Math.max(b.w, b.h) / Math.max(0.01, minDim);
      if (aspect >= 1.8) return this.cut(b, ap, 0.09, 'ap');
      return false;
    }
    const k = dom.kind;
    // a glancing round only scores the face; a spent one (under ~9 m/s) only scuffs it
    if (k === 'glance' || k === 'pellet') return false;
    if (dom.speed !== undefined && dom.speed < 9 && k === 'shot') return false;
    // objectives never split while they stand: they die whole (and a dead one may burst, counted destroyed)
    if (b.target) return false;
    // accumulated damage: hit after hit, a block gives way well before its last HP goes
    const D = 1 - b.hp / b.maxHp;
    const worn = (lim: number) => D >= lim * (WORN[b.matId] ?? 1) && f >= 0.08;
    if (cls === 'brittle') {
      if (k === 'shot' && area >= 0.3 && minDim >= 0.3 && (f >= 0.5 || worn(0.8))) return this.crack(b, dom, f >= 0.75 && area >= 1.1 ? 3 : 2);
      if (k === 'impact' && f >= 0.45 && area >= 0.4 && s.gen < 2) return this.crack(b, dom, 2);
      if (k === 'apStop' && (dom.cosI ?? 1) >= 0.5 && (f >= 0.4 || worn(0.75)) && area >= 0.4) return this.crack(b, dom, 2);
      if (k === 'blast' && !dom.fire && (f >= 0.3 || worn(0.8)) && area >= 0.4) return this.shatter(b, dom, 3 + Math.min(3, Math.floor(f * 4)));
      if (k === 'charge' && f >= 0.2 && area >= 0.3) return this.shatter(b, dom, 4 + Math.min(2, Math.floor(f * 3)));
    } else if (cls === 'timber') {
      if ((k === 'shot' || k === 'blast' || k === 'charge' || (k === 'impact' && s.gen < 2)) && !dom.fire && (f >= 0.4 || worn(0.6)) && minDim >= 0.25 && area >= 0.25)
        return this.splinter(b, dom, f >= 0.7 && minDim >= 0.45 ? 3 : 2);
    } else if (cls === 'steel') {
      // plate tears only under a buried charge (bunker buster, AP bomb, drill)
      if (k === 'charge' && f >= 0.25 && area >= 0.3 && b.matId === 'steel') return this.crack(b, dom, 2);
    } else if (cls === 'earth') {
      // rammed earth soaks blast: only a buried charge, a solid shot or a penetrator digs it out
      if ((k === 'charge' || k === 'shot' || k === 'apStop') && f >= 0.08) return this.erode(b, dom, f);
    }
    return false;
  }

  // ───────────────────────── marks ─────────────────────────
  /** world point → the block's pattern space */
  private toPattern(b: Block, x: number, y: number): P {
    const s = this.state(b);
    const t = b.body.translation(), r = b.body.rotation();
    const c = Math.cos(-r), sn = Math.sin(-r);
    const dx = x - t.x, dy = y - t.y;
    return [dx * c - dy * sn + b.w / 2 + s.off[0], dx * sn + dy * c + b.h / 2 + s.off[1]];
  }

  addMark(b: Block, x: number, y: number, r: number, type: MarkType, world = true) {
    const s = this.state(b);
    const [px, py] = world ? this.toPattern(b, x, y) : [x, y];
    // a fresh hit on (nearly) the same spot deepens the old mark instead of taking a slot
    // pockmarks gather into a peppered patch rather than taking every slot
    const near = type === MarkType.POCK ? 0.14 : Math.max(r, 0.05) * 0.7;
    for (const m of s.marks) {
      if (m.type === type && type !== MarkType.BORE && type !== MarkType.BORE_END && type !== MarkType.GOUGE && Math.hypot(m.x - px, m.y - py) < Math.max(m.r * 0.7, near)) {
        if (type === MarkType.POCK) { m.r = Math.min(0.09, m.r + 0.004); this.dirty.add(b); return; }
        m.r = Math.min(Math.max(m.r, r) * 1.12, Math.max(m.r, r) + 0.08, 1.2);
        this.dirty.add(b);
        return;
      }
    }
    s.marks.push({ x: px, y: py, r, type, seed: Math.random() });
    this.trimMarks(s.marks);
    this.dirty.add(b);
    this.stats.marks++;
  }

  /** keep at most MAX_MARKS slots: pockmarks go first, then the oldest (a bore or gouge leaves as a pair) */
  private trimMarks(ms: Mark[]) {
    while (ms.length > MAX_MARKS) {
      const pock = ms.findIndex((m) => m.type === MarkType.POCK);
      const i = pock >= 0 && ms.filter((m) => m.type === MarkType.POCK).length > 1 ? pock : ms.findIndex((m) => m.type !== MarkType.BORE_END);
      ms.splice(i, ms[i].type === MarkType.BORE || ms[i].type === MarkType.GOUGE ? 2 : 1);
    }
    // a bore start must be followed by its end
    if (ms.length && (ms[ms.length - 1].type === MarkType.BORE || ms[ms.length - 1].type === MarkType.GOUGE)) ms.pop();
  }

  private markHit(b: Block, h0: Hit) {
    const cls = clsOf(b);
    if (cls === 'none') return;
    // hits land on the outline: set the pit a little into the face (along the blow) so it reads as a bite, not half a disc in the air
    const into = h0.kind === 'shot' ? (h0.r ?? 0.24) * 1.4 : h0.kind === 'blast' || h0.kind === 'apStop' ? 0.18 : 0;
    const h = into ? { ...h0, x: h0.x + h0.dx * into, y: h0.y + h0.dy * into } : h0;
    const fh = Math.min(1.5, h.e / b.maxHp);
    const steel = cls === 'steel';
    switch (h.kind) {
      case 'shot': {
        if (h.quiet) return;
        const base = (h.r ?? 0.24) * 0.6;
        const r = Math.min(0.5, base + 0.32 * Math.sqrt(fh));
        const cos = h.cosI ?? 1;
        // an oblique blow drags a gouge along the face before the pit; a square one just pits it
        if (cos < 0.75) this.addGouge(b, h, r * 0.7, 0.25 + (1 - cos) * 0.9);
        // soft-skinned rounds (incendiary, smoke) splash rather than pit
        if (h.ammo === 'incendiary' || h.ammo === 'bomb_inc' || h.ammo === 'smoke') break;
        if (h.speed !== undefined && h.speed < 9) { this.addMark(b, h.x, h.y, r * 0.55, MarkType.POCK); break; }
        this.addMark(b, h.x, h.y, (steel ? r * 0.85 : r) * (0.6 + 0.4 * cos), steel ? MarkType.DENT : MarkType.CRATER);
        break;
      }
      case 'glance':
        // a ricochet: a scraped streak along the face, nothing more
        this.addGouge(b, h, Math.min(0.2, (h.r ?? 0.2) * 0.7), 0.4 + 0.5 * (1 - (h.cosI ?? 0.5)));
        break;
      case 'blast': {
        if (h.quiet || fh < 0.04) return;
        const r = Math.min(h.fire ? 1.2 : 1.0, (h.fire ? 0.45 : 0.25) + 0.9 * fh);
        this.addMark(b, h.x, h.y, r, MarkType.SCORCH);
        if (!h.fire && fh >= 0.15) this.addMark(b, h.x, h.y, Math.min(0.4, 0.1 + 0.3 * fh), steel ? MarkType.DENT : MarkType.CRATER);
        break;
      }
      case 'apStop':
        if ((h.cosI ?? 1) < 0.5) { this.addGouge(b, h, 0.1, 0.35); this.addMark(b, h.x, h.y, 0.1, steel ? MarkType.DENT : MarkType.CRATER); break; }
        if (steel) { this.addMark(b, h.x, h.y, 0.17, MarkType.DENT); this.addMark(b, h.x, h.y, 0.06, MarkType.HOLE); }
        else this.addMark(b, h.x, h.y, 0.15, MarkType.HOLE);
        break;
      case 'ap':
        if (h.ex === undefined || h.ey === undefined) break;
        this.addMark(b, h.x, h.y, 0.16, MarkType.HOLE);
        this.addMark(b, h.ex, h.ey, 0.19, MarkType.HOLE);
        this.addBore(b, h.x, h.y, h.ex, h.ey, 0.13);
        break;
      case 'pellet':
        this.addMark(b, h.x, h.y, steel ? 0.035 : 0.05 + Math.random() * 0.02, MarkType.POCK);
        break;
      case 'charge':
        this.addMark(b, h.x, h.y, Math.min(0.8, 0.45 + 0.4 * fh), MarkType.SCORCH);
        this.addMark(b, h.x, h.y, Math.min(0.45, 0.2 + 0.25 * fh), steel ? MarkType.DENT : MarkType.CRATER);
        break;
      case 'impact':
        break;
    }
  }

  /** a gouge: a streak along the face in the direction of travel, ending at the hit */
  private addGouge(b: Block, h: Hit, r: number, len: number) {
    const s = this.state(b);
    // run the streak along the surface: travel direction minus its normal part is unknown here, so
    // project onto the face nearest the hit (block axes)
    const rot = b.body.rotation();
    const ax = { x: Math.cos(rot), y: Math.sin(rot) }, ay = { x: -Math.sin(rot), y: Math.cos(rot) };
    const [px, py] = this.toPattern(b, h.x, h.y);
    const fx = Math.min(px - s.off[0], s.off[0] + b.w - px), fy = Math.min(py - s.off[1], s.off[1] + b.h - py);
    const along = fx < fy ? ay : ax; // nearest face is a side (x) → streak runs along y
    const d = h.dx * along.x + h.dy * along.y;
    const sg = d >= 0 ? 1 : -1;
    const x0 = h.x - along.x * sg * len, y0 = h.y - along.y * sg * len;
    const a = this.toPattern(b, x0, y0);
    s.marks.push({ x: a[0], y: a[1], r, type: MarkType.GOUGE, seed: Math.random() }, { x: px, y: py, r, type: MarkType.BORE_END, seed: 0 });
    this.trimMarks(s.marks);
    this.dirty.add(b);
    this.stats.marks++;
  }

  private addBore(b: Block, x0: number, y0: number, x1: number, y1: number, r: number) {
    const s = this.state(b);
    const a = this.toPattern(b, x0, y0), c = this.toPattern(b, x1, y1);
    s.marks.push({ x: a[0], y: a[1], r, type: MarkType.BORE, seed: Math.random() }, { x: c[0], y: c[1], r, type: MarkType.BORE_END, seed: 0 });
    this.trimMarks(s.marks);
    this.dirty.add(b);
  }

  // ───────────────────────── fracture patterns ─────────────────────────
  private local(b: Block, x: number, y: number, dx: number, dy: number) {
    const t = b.body.translation(), r = b.body.rotation();
    const c = Math.cos(-r), s = Math.sin(-r);
    const lx = x - t.x, ly = y - t.y;
    return { qx: lx * c - ly * s, qy: lx * s + ly * c, ux: dx * c - dy * s, uy: dx * s + dy * c };
  }

  /** brittle crack: one or two lines through the impact, roughly along the blow */
  private crack(b: Block, h: Hit, n: number): boolean {
    const poly = localPoly(b);
    const A = Math.abs(polyArea(poly));
    let { qx, qy, ux, uy } = this.local(b, h.x, h.y, h.dx, h.dy);
    if (h.kind === 'impact' || Math.hypot(ux, uy) < 0.5) { const a = Math.random() * Math.PI; ux = Math.cos(a); uy = Math.sin(a); qx = (Math.random() - 0.5) * b.w * 0.4; qy = (Math.random() - 0.5) * b.h * 0.4; }
    // pull the crack in from the very edge so both halves are worth having
    qx = Math.max(-b.w * 0.32, Math.min(b.w * 0.32, qx)); qy = Math.max(-b.h * 0.32, Math.min(b.h * 0.32, qy));
    let best: P[][] | null = null;
    for (let tries = 0; tries < 4 && !best; tries++) {
      const a = Math.atan2(uy, ux) + (Math.random() - 0.5) * (0.6 + tries * 0.4);
      const parts = cutLine(poly, qx, qy, Math.cos(a), Math.sin(a), 0.02);
      if (parts.length === 2 && parts.every((q) => Math.abs(polyArea(q)) > A * 0.12)) best = parts;
    }
    if (!best) return false;
    if (n >= 3) {
      // a second crack across the bigger half
      best.sort((p, q) => Math.abs(polyArea(q)) - Math.abs(polyArea(p)));
      const big = best[0], [cx, cy] = centroid(big);
      const a = Math.atan2(uy, ux) + Math.PI / 2 + (Math.random() - 0.5) * 0.8;
      const more = cutLine(big, cx, cy, Math.cos(a), Math.sin(a), 0.02);
      if (more.length === 2 && more.every((q) => Math.abs(polyArea(q)) > A * 0.08)) best = [...more, best[1]];
    }
    return this.split(b, best, { from: { x: h.x, y: h.y }, kick: Math.min(3, 0.8 + h.e / b.maxHp * 2), dir: { x: h.dx, y: h.dy } }) > 0;
  }

  /** blast: Voronoi cells round the burst point (small ones near it, big ones away) */
  private shatter(b: Block, h: Hit, n: number): boolean {
    const poly = localPoly(b);
    const { qx, qy } = this.local(b, h.x, h.y, h.dx, h.dy);
    const seeds = this.seeds(poly, qx, qy, n);
    const cells = voronoi(poly, seeds, 0.02);
    if (cells.length < 2) return false;
    this.stats.shatters++;
    return this.split(b, cells, { from: { x: h.x, y: h.y }, kick: Math.min(5, 1.5 + (h.e / b.maxHp) * 3), dir: { x: h.dx, y: h.dy } }) > 0;
  }

  private seeds(poly: P[], qx: number, qy: number, n: number): P[] {
    const bb = bbox(poly);
    // the impact point, pulled just inside the outline
    const [cx, cy] = centroid(poly);
    let sx = qx, sy = qy;
    for (let i = 0; i < 6 && !inside(poly, sx, sy); i++) { sx = sx * 0.7 + cx * 0.3; sy = sy * 0.7 + cy * 0.3; }
    const seeds: P[] = [[sx, sy]];
    const near = Math.min(bb.w, bb.h) * 0.35;
    for (let tries = 0; seeds.length < 2 && tries < 20; tries++) {
      const a = Math.random() * Math.PI * 2, d = near * (0.5 + Math.random() * 0.5);
      const p: P = [sx + Math.cos(a) * d, sy + Math.sin(a) * d];
      if (inside(poly, p[0], p[1])) seeds.push(p);
    }
    for (let tries = 0; seeds.length < n && tries < 60; tries++) {
      const p: P = [bb.x0 + Math.random() * bb.w, bb.y0 + Math.random() * bb.h];
      if (!inside(poly, p[0], p[1])) continue;
      if (seeds.some((s) => Math.hypot(s[0] - p[0], s[1] - p[1]) < Math.min(bb.w, bb.h) * 0.3)) continue;
      seeds.push(p);
    }
    return seeds;
  }

  /** timber: long splinters along the grain */
  private splinter(b: Block, h: Hit, n: number): boolean {
    const poly = localPoly(b);
    const { qx, qy } = this.local(b, h.x, h.y, h.dx, h.dy);
    const horiz = this.grainHoriz(b);
    const across = horiz ? b.h : b.w;
    const q = horiz ? qy : qx;
    const offs: number[] = n >= 3 ? [-across / 6 + (Math.random() - 0.5) * across * 0.1, across / 6 + (Math.random() - 0.5) * across * 0.1]
      : [Math.max(-across * 0.2, Math.min(across * 0.2, q * 0.6 + (Math.random() - 0.5) * across * 0.15))];
    let parts: P[][] = [poly];
    for (const o of offs) {
      const next: P[][] = [];
      for (const part of parts) {
        const cs = horiz ? cutLine(part, 0, o, 1, 0.04 * (Math.random() - 0.5), 0.015) : cutLine(part, o, 0, 0.04 * (Math.random() - 0.5), 1, 0.015);
        next.push(...(cs.length ? cs : [part]));
      }
      parts = next;
    }
    if (parts.length < 2) return false;
    return this.split(b, parts, { from: { x: h.x, y: h.y }, kick: Math.min(3, 1 + (h.e / b.maxHp) * 2), dir: { x: h.dx, y: h.dy } }) > 0;
  }

  /** grain direction of a block (as the shader draws it: along the original's long side) */
  private grainHoriz(b: Block) { const s = this.state(b); return s.full[0] >= s.full[1]; }

  /** the penetrator's cut: along the shot line, a kerf as wide as the round */
  private cut(b: Block, h: Hit, kerf: number, _why: string): boolean {
    const poly = localPoly(b);
    const { qx, qy, ux, uy } = this.local(b, h.x, h.y, h.dx, h.dy);
    const parts = cutLine(poly, qx, qy, ux, uy, kerf);
    if (parts.length < 2) return false;
    return this.split(b, parts, { from: { x: h.x, y: h.y }, kick: 1.2, dir: { x: h.dx, y: h.dy }, shear: true }) > 0;
  }

  /** earth: the struck face slumps away; what is left is a smaller block */
  private erode(b: Block, h: Hit, f: number): boolean {
    const poly = localPoly(b);
    const { qx, qy, ux, uy } = this.local(b, h.x, h.y, h.dx, h.dy);
    const len = Math.hypot(ux, uy) || 1;
    // keep what lies beyond the struck surface by `depth`, measured along the blow
    const nx = -ux / len, ny = -uy / len;
    let face = -Infinity;
    for (const [x, y] of poly) face = Math.max(face, nx * x + ny * y);
    const c0 = Math.min(face, nx * qx + ny * qy);
    const depth = Math.min(0.6, 0.12 + 0.5 * f) * Math.min(b.w, b.h);
    const rest = clipPoly(poly, nx, ny, c0 - depth);
    if (rest.length < 3) return false;
    const A = Math.abs(polyArea(poly)), a = Math.abs(polyArea(rest));
    if (a < A * 0.35 || a > A * 0.97) return false;
    const c = new THREE.Color(...MATERIALS[this.g.shownMat(b)].color);
    for (let i = 0; i < 10; i++) this.g.r.debris.spawn(h.x + (Math.random() - 0.5) * 0.6, h.y + (Math.random() - 0.5) * 0.6, -h.dx * 2 + (Math.random() - 0.5) * 3, Math.random() * 3, 0.1 + Math.random() * 0.18, c.clone().multiplyScalar(0.75 + Math.random() * 0.4));
    for (let i = 0; i < 3; i++) this.g.r.smoke.spawn({ x: h.x, y: h.y, vx: (Math.random() - 0.5), vy: 0.6, max: 1.6, size0: 0.6, size1: 2, c0: [0.5, 0.42, 0.32], c1: [0.6, 0.55, 0.48], a0: 0.5, a1: 0, drag: 1.4 });
    return this.split(b, [rest], { keepHp: true }) > 0;
  }

  /** a block killed by a big hit bursts into rubble and fragments (no lasting pieces) */
  private burst(b: Block, s: Snap, hs: Hit[]): boolean {
    let sum = 0, dom = hs[0];
    for (const h of hs) { sum += h.e; if (h.e > dom.e) dom = h; }
    // a block finished off by shot, shell or charge breaks up; one that burns, is holed out by AP, or
    // is worn away by canister or a fall just goes
    if (dom.kind === 'ap' || dom.kind === 'pellet' || dom.kind === 'impact' || dom.kind === 'glance' || dom.fire || dom.quiet && hs.length === 1) return false;
    if (dom.speed !== undefined && dom.speed < 9) return false;
    if (sum < b.maxHp * 0.12) return false;
    const poly = localPoly(b);
    const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
    const lx = dom.x - s.t.x, ly = dom.y - s.t.y;
    const qx = lx * c - ly * sn, qy = lx * sn + ly * c;
    let parts: P[][];
    if (clsOf(b) === 'timber') {
      const horiz = this.grainHoriz(b);
      const across = horiz ? b.h : b.w;
      parts = [poly];
      for (const o of [-across / 6, across / 6]) {
        const next: P[][] = [];
        for (const part of parts) { const cs = horiz ? cutLine(part, 0, o, 1, 0, 0.02) : cutLine(part, o, 0, 0, 1, 0.02); next.push(...(cs.length ? cs : [part])); }
        parts = next;
      }
    } else parts = voronoi(poly, this.seeds(poly, qx, qy, 3 + Math.floor(Math.random() * 3)), 0.03);
    if (parts.length < 2) return false;
    return this.split(b, parts, { snap: s, from: { x: dom.x, y: dom.y }, kick: Math.min(7, 2 + (sum / b.maxHp) * 2), dir: { x: dom.dx, y: dom.dy }, dead: true }) > 0;
  }

  // ───────────────────────── the split itself ─────────────────────────
  /**
   * Replace block b with these pieces (polygons in b's body frame). Returns the number of physics
   * pieces made. opts.dead: b is already destroyed (snapshot in opts.snap): every piece is rubble.
   */
  split(b: Block, polys: P[][], opts: { from?: V2; kick?: number; dir?: V2; dead?: boolean; snap?: Snap; keepHp?: boolean; shear?: boolean } = {}): number {
    const g = this.g;
    const parent = this.state(b);
    const A = Math.abs(polyArea(localPoly(b)));
    const items = polys.map((p) => simplify(p)).filter((p) => p.length >= 3).map((p) => ({ p, a: Math.abs(polyArea(p)) })).filter((q) => q.a > 1e-4);
    if (!items.length || A <= 0) return 0;
    items.sort((x, y) => y.a - x.a);
    // an objective never splits while it stands (it dies whole and is counted destroyed)
    if (b.target && !opts.dead) return 0;
    if (!opts.dead && items.length < 2 && !opts.keepHp) return 0;
    const snap: Snap = opts.snap ?? (() => {
      const t = b.body.translation(), v = b.body.linvel();
      return { t: { x: t.x, y: t.y }, rot: b.body.rotation(), v: { x: v.x, y: v.y }, av: b.body.angvel(), hp: b.hp };
    })();
    const cr = Math.cos(snap.rot), sr = Math.sin(snap.rot);
    const toWorld = (x: number, y: number): V2 => ({ x: snap.t.x + x * cr - y * sr, y: snap.t.y + x * sr + y * cr });

    // tiers: physics (lasting or rubble) or a fading fragment
    type Tier = 'keep' | 'rubble' | 'fx';
    let live = this.live, rubbleN = this.rubble.filter((q) => !q.dead).length;
    const tiers: Tier[] = items.map((it, i) => {
      const small = it.a < MIN_AREA || thick(it.p) < MIN_THICK;
      if (small) return 'fx';
      if (opts.dead) {
        if (it.a < 0.1 || rubbleN >= MAX_RUBBLE || live >= MAX_LIVE) return 'fx';
        rubbleN++; live++;
        return 'rubble';
      }
      if (i === 0) return 'keep'; // replaces b
      if (live >= MAX_LIVE) return 'fx';
      if (it.a < RUBBLE_AREA || parent.gen + 1 >= MAX_GEN) {
        if (rubbleN >= MAX_RUBBLE) return 'fx';
        rubbleN++; live++;
        return 'rubble';
      }
      live++;
      return 'keep';
    });
    if (!opts.dead && tiers[0] === 'fx') return 0;

    if (!opts.dead) this.retire(b);
    this.live = live;
    const shown = MATERIALS[g.shownMat(b)];
    const hpLeft = Math.max(1, snap.hp);
    const pieces: Block[] = [];
    let heir: Block | null = null;
    items.forEach((it, i) => {
      const bb = bbox(it.p);
      const cx = bb.x0 + bb.w / 2, cy = bb.y0 + bb.h / 2;
      const wc = toWorld(cx, cy);
      const [gx, gy] = centroid(it.p);
      const gc = toWorld(gx, gy);
      const frac = it.a / A;
      // velocity: the parent's (incl. spin) plus a kick away from the hit
      let vx = snap.v.x - snap.av * (wc.y - snap.t.y), vy = snap.v.y + snap.av * (wc.x - snap.t.x);
      // the parent's velocity at the moment of the hit is the solver's jolt, not a real flight speed
      const vl = Math.hypot(vx, vy);
      if (vl > 5) { vx *= 5 / vl; vy *= 5 / vl; }
      if (opts.from && opts.kick) {
        let ox = gc.x - opts.from.x, oy = gc.y - opts.from.y;
        const ol = Math.hypot(ox, oy) || 1;
        ox /= ol; oy /= ol;
        const k = opts.kick * (i === 0 && !opts.dead ? 0.25 : 1) * (0.6 + Math.random() * 0.6) / Math.max(0.5, Math.sqrt(it.a));
        const d = opts.dir ?? { x: 0, y: 0 };
        if (opts.shear) {
          // a cut member: the far side of the cut slides on with the round
          const side = (gc.x - opts.from.x) * -d.y + (gc.y - opts.from.y) * d.x;
          vx += d.x * k * 0.5 + (side > 0 ? -d.y : d.y) * 0.3; vy += d.y * k * 0.5 + (side > 0 ? d.x : -d.x) * 0.3;
        } else { vx += (ox * 0.7 + d.x * 0.5) * k; vy += (oy * 0.7 + d.y * 0.5) * k + (opts.dead ? 1 : 0.3) * k; }
      }
      const tier = tiers[i];
      const rel: [number, number][] = it.p.map(([x, y]) => [x - bb.x0, y - bb.y0]);
      const off: P = [parent.off[0] + bb.x0 + b.w / 2, parent.off[1] + bb.y0 + b.h / 2];
      const marks = parent.marks.filter((m) => m.x > off[0] - m.r && m.x < off[0] + bb.w + m.r && m.y > off[1] - m.r && m.y < off[1] + bb.h + m.r);
      // a bore keeps both ends or neither
      const pair = (t?: number) => t === MarkType.BORE || t === MarkType.GOUGE;
      const kept = marks.filter((m, j) => (pair(m.type) ? marks[j + 1]?.type === MarkType.BORE_END : m.type === MarkType.BORE_END ? pair(marks[j - 1]?.type) : true));
      if (tier === 'fx') { this.spawnFx(b, rel, bb.w, bb.h, wc, snap.rot, vx, vy, snap.av + (Math.random() - 0.5) * 6, off, parent, kept, shown.color, shown.kind); return; }
      const def: BlockDef = { x: wc.x - bb.w / 2, y: wc.y - bb.h / 2, w: bb.w, h: bb.h, mat: b.def.mat, poly: rel };
      if (b.def.disguise) def.disguise = b.def.disguise;
      const nb = g.addBlock(def);
      nb.frag = true;
      nb.body.setTranslation(wc, true);
      nb.body.setRotation(snap.rot, true);
      nb.body.setLinvel({ x: vx, y: vy }, true);
      nb.body.setAngvel(snap.av + (tier === 'keep' && i === 0 ? 0 : (Math.random() - 0.5) * (opts.dead ? 4 : 1.5)), true);
      nb.lastVel = { x: vx, y: vy };
      this.graceT.set(nb, g.time + 0.35);
      nb.mesh.position.set(wc.x, wc.y, 4);
      nb.mesh.rotation.z = snap.rot;
      // HP and fire carry over by share
      nb.maxHp = b.maxHp * frac;
      nb.hp = opts.dead ? nb.maxHp * 0.6 : opts.keepHp ? Math.min(hpLeft, nb.maxHp) : Math.max(1, hpLeft * frac);
      nb.burning = b.burning; nb.burnAmt = b.burnAmt; nb.fireT = b.fireT; nb.fuelMax = b.fuelMax; nb.fuel = b.fuel; nb.cookoff = b.cookoff > 0 && i === 0 ? b.cookoff : -1;
      nb.spreadT = b.spreadT; nb.flash = Math.max(b.flash, 0.3); nb.rebuilt = 1;
      const ns = this.state(nb);
      ns.off = off; ns.full = [parent.full[0], parent.full[1]]; ns.gen = parent.gen + 1; ns.marks = kept.map((m) => ({ ...m }));
      nb.uni.uSeed.value = b.uni.uSeed.value;
      (nb.uni.uOff.value as THREE.Vector2).set(off[0], off[1]);
      (nb.uni.uFull.value as THREE.Vector2).set(ns.full[0], ns.full[1]);
      nb.uni.uBurn.value = nb.burnAmt;
      this.dirty.add(nb);
      if (tier === 'rubble') { ns.rubble = 3 + Math.random() * 5; this.rubble.push(nb); this.stats.rubble++; }
      if (!heir && tier === 'keep' && !opts.dead) heir = nb;
      pieces.push(nb);
      this.stats.pieces++;
    });
    if (!opts.dead) {
      this.stats.splits++;
      const h = heir ?? pieces[0] ?? null;
      if (h) b.heir = h;
      if (pieces.length) this.relink(b, pieces.filter((q) => !this.isRubble(q)), h, snap.t);
      audio.play(b.matId === 'wood' || b.matId === 'crate' ? 'splinter' : b.matId === 'steel' ? 'clang' : 'crumble', snap.t.x, 0.45);
    }
    return pieces.length + (opts.dead ? 1 : 0);
  }

  /** remove a block without the destroy effects (it lives on as its pieces) */
  retire(b: Block) {
    if (b.dead) return;
    const g = this.g;
    b.dead = true;
    g.owners.delete(b.collider.handle);
    g.world.removeRigidBody(b.body);
    g.root.remove(b.mesh);
    b.mesh.geometry.dispose();
    (b.mesh.material as THREE.Material).dispose();
  }

  /** rooms, the garrison's floors, backdrops and stuck charges follow the pieces */
  private relink(old: Block, pieces: Block[], heir: Block | null, ot: V2) {
    const g = this.g;
    g.garrison.relink(old, pieces, heir, ot);
    for (const bd of g.backdrops) {
      const i = bd.deps.indexOf(old);
      if (i < 0) continue;
      const home = bd.home[i];
      bd.deps.splice(i, 1); bd.home.splice(i, 1);
      for (const p of pieces) { const t = p.body.translation(); bd.deps.push(p); bd.home.push({ x: t.x - (ot.x - home.x), y: t.y - (ot.y - home.y) }); }
    }
    for (const p of g.projectiles) {
      if (p.dead || p.stuck?.block !== old) continue;
      let best: Block | null = null, bd = Infinity;
      for (const q of pieces) { const t = q.body.translation(); const d = Math.hypot(t.x - p.x, t.y - p.y); if (d < bd) { bd = d; best = q; } }
      if (!best) { p.stuck = { lx: p.x, ly: p.y, rot: 0 }; continue; }
      const bt = best.body.translation(), br = best.body.rotation();
      const dx = p.x - bt.x, dy = p.y - bt.y, c = Math.cos(-br), s = Math.sin(-br);
      p.stuck = { block: best, lx: dx * c - dy * s, ly: dx * s + dy * c, rot: 0 };
    }
  }

  // ───────────────────────── fragments ─────────────────────────
  private spawnFx(b: Block, rel: [number, number][], w: number, h: number, wc: V2, rot: number, vx: number, vy: number, vr: number, off: P, parent: FracState, marks: Mark[], color: [number, number, number], kind: number) {
    const g = this.g;
    this.stats.frags++;
    if (this.fx.length >= MAX_FX) {
      // too many in the air: a puff of debris instead
      const c = new THREE.Color(...color);
      g.r.debris.spawn(wc.x, wc.y, vx, vy, Math.min(0.35, Math.sqrt(w * h)), c.multiplyScalar(0.8 + Math.random() * 0.3));
      return;
    }
    const geo = blockGeometry(w, h, rel);
    const mat = makeBlockMaterial(color, w, h, kind, geo);
    mat.uniforms.uSeed.value = b.uni.uSeed.value;
    (mat.uniforms.uOff.value as THREE.Vector2).set(off[0], off[1]);
    (mat.uniforms.uFull.value as THREE.Vector2).set(parent.full[0], parent.full[1]);
    mat.uniforms.uCrackK.value = b.uni.uCrackK?.value ?? 1;
    mat.uniforms.uBurn.value = b.burnAmt;
    mat.uniforms.uDamage.value = 0.5;
    writeMarks(mat.uniforms, marks);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(wc.x, wc.y, 4.4);
    mesh.rotation.z = rot;
    g.root.add(mesh);
    const life = 1.2 + Math.random() * 1.6;
    this.fx.push({ mesh, mat, x: wc.x, y: wc.y, vx, vy: vy + 1.5, rot, vr, life, max: life, r: Math.min(w, h) / 2 });
  }

  private updateFx(dt: number) {
    if (!this.fx.length) return;
    const g = this.g;
    for (const f of this.fx) {
      f.life -= dt;
      f.vy -= 9.81 * dt;
      f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.vr * dt;
      const gy = g.groundY(f.x) + f.r;
      if (f.y < gy) { f.y = gy; f.vy *= -0.25; f.vx *= 0.55; f.vr *= 0.5; }
      f.mesh.position.set(f.x, f.y, 4.4);
      f.mesh.rotation.z = f.rot;
      f.mat.uniforms.uFade.value = Math.min(1, f.life / Math.min(0.6, f.max));
      f.mat.uniforms.uTime.value = g.time;
      if (f.life <= 0) { g.root.remove(f.mesh); f.mesh.geometry.dispose(); f.mat.dispose(); }
    }
    this.fx = this.fx.filter((f) => f.life > 0);
  }
}
