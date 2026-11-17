import RAPIER from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import type { Block, Game } from './game';
import { makeLadder } from './render';
import type { Era } from './engrig';

/*
  Repair scaffolding (docs/RESEARCH.md, "Siege repair & scaffolding"). A visual, not a physics body:
  it rides the block it serves and is knocked down by blasts, fast rounds and falling masonry.

  Two layouts:
   - side: the classic section of a putlog scaffold standing beside the block's free face: an outer
     and an inner row of standards, putlogs (transoms) every lift running into the wall, a boarded
     working lift, a ladder up the outside, a diagonal brace;
   - front: an elevation across the face when neither side is clear (the block is hemmed in by its
     neighbours): standards every bay, ledgers every lift, boards on the working lifts.
  Era picks the kit: timber poles lashed with rope, plank platforms and a gin-pole hoist (medieval), or
  grey 48 mm steel tube with couplers, base plates, boards with toe boards and double guard rails (modern).

  Members go up one by one (standards first, then lift by lift) while an engineer is at the foot, and are
  struck in reverse when the job is done. Knocked down, each member becomes a tumbling stick that lands,
  slides and fades.
*/

type V2 = { x: number; y: number };
const INK = '#1c1f26';

type Kind = 'pole' | 'tube' | 'plank' | 'board' | 'lash' | 'coupler' | 'plate' | 'rope' | 'basket' | 'wheel' | 'stone' | 'sack' | 'tub';

interface Member {
  kind: Kind;
  mesh: THREE.Object3D;
  /** placed position (scaffold-local = world at creation) */
  x0: number; y0: number; x1: number; y1: number; th: number;
  /** 0..1: when in the erection sequence it goes up */
  order: number;
  /** once knocked down: a tumbling stick */
  fall?: { x: number; y: number; vx: number; vy: number; r: number; vr: number; rest: number };
}

export interface Station {
  /** platform height above the base (0 = the ground) */
  h: number;
  /** work spots (scaffold-local x) and which way the worker faces (-1 left, 1 right) */
  spots: { x: number; face: number }[];
}

export interface ScaffoldPlan {
  layout: 'side' | 'front';
  /** side layout: which face of the block it stands against (-1 = left face, 1 = right face) */
  side: number;
  /** footprint (world x) and base (world y) */
  x0: number; x1: number; base: number;
  /** top of the standards above the base */
  height: number;
  stations: Station[];
  ladderX: number;
  /** where the materials are stacked at the foot */
  pileX: number;
  /** which way the crew comes from the ladder to the spots, and back */
  wall: number;
  /** side layout: where the block's face really is at each height (a battered or sloped face recedes) */
  faces: { y: number; x: number }[];
}

/** x of the block's face at height y (side layout) */
export function faceX(p: ScaffoldPlan, y: number) {
  let best = p.faces[0], d = Infinity;
  for (const f of p.faces) { const q = Math.abs(f.y - y); if (q < d) { d = q; best = f; } }
  return best ? best.x : p.side < 0 ? p.x1 : p.x0;
}

const texCache = new Map<string, THREE.Texture>();
function tex(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}
const rgb = (c: number[], k = 1) => `rgb(${c.map((v) => Math.round(Math.min(255, v * k))).join(',')})`;

/** a stick seen side-on: ink edges top and bottom, a lit band above, shade below (u runs along the length) */
function stickTex(kind: Kind) {
  return tex(kind, 8, 32, (g, w, h) => {
    const col = kind === 'tube' ? [128, 134, 140] : kind === 'board' ? [150, 118, 78] : kind === 'plank' ? [164, 126, 82] : kind === 'rope' ? [96, 78, 56] : [158, 120, 78];
    g.fillStyle = INK; g.fillRect(0, 0, w, h);
    const e = kind === 'rope' ? 8 : 5;
    g.fillStyle = rgb(col); g.fillRect(0, e, w, h - 2 * e);
    g.fillStyle = rgb(col, kind === 'tube' ? 1.45 : 1.22); g.fillRect(0, e, w, kind === 'tube' ? 4 : 5);
    g.fillStyle = rgb(col, 0.68); g.fillRect(0, h - e - 6, w, 6);
    if (kind === 'pole') { g.fillStyle = rgb(col, 0.82); g.fillRect(0, 15, w, 2); } // grain
    if (kind === 'plank' || kind === 'board') { g.fillStyle = rgb(col, 0.78); g.fillRect(0, 17, w, 1); }
  });
}

function blobTex(kind: Kind) {
  return tex(kind, 64, 64, (g, w, h) => {
    g.lineWidth = 4; g.strokeStyle = INK;
    if (kind === 'lash') {
      // rope wrapped round a joint: a dark knot with turns
      g.fillStyle = rgb([92, 74, 52]); g.beginPath(); g.ellipse(w / 2, h / 2, 22, 26, 0.6, 0, Math.PI * 2); g.fill(); g.stroke();
      g.strokeStyle = rgb([150, 124, 86]); g.lineWidth = 4;
      for (const o of [-10, 0, 10]) { g.beginPath(); g.moveTo(w / 2 - 16 + o, h / 2 - 16); g.lineTo(w / 2 + 10 + o, h / 2 + 18); g.stroke(); }
    } else if (kind === 'coupler') {
      g.fillStyle = rgb([70, 74, 80]); g.beginPath(); g.roundRect(12, 12, 40, 40, 8); g.fill(); g.stroke();
      g.fillStyle = rgb([150, 156, 164]); g.fillRect(20, 18, 8, 8); g.fillRect(36, 38, 8, 8);
    } else if (kind === 'plate') {
      g.fillStyle = rgb([70, 74, 80]); g.fillRect(4, 36, 56, 18); g.strokeRect(4, 36, 56, 18);
      g.fillStyle = rgb([110, 116, 122]); g.fillRect(8, 38, 48, 4);
    } else if (kind === 'wheel') {
      g.fillStyle = rgb([92, 96, 104]); g.beginPath(); g.arc(w / 2, h / 2, 26, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = INK; g.beginPath(); g.arc(w / 2, h / 2, 7, 0, Math.PI * 2); g.fill();
    } else if (kind === 'basket') {
      g.beginPath(); g.moveTo(6, 14); g.lineTo(w - 6, 14); g.lineTo(w - 14, h - 6); g.lineTo(14, h - 6); g.closePath();
      g.fillStyle = rgb([168, 132, 80]); g.fill();
      g.save(); g.clip(); g.strokeStyle = rgb([118, 88, 52]); g.lineWidth = 3;
      for (let y = 18; y < h; y += 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      g.fillStyle = rgb([150, 146, 136]); g.fillRect(0, 8, w, 12);
      g.restore(); g.strokeStyle = INK; g.lineWidth = 4; g.stroke();
    } else if (kind === 'stone') {
      g.fillStyle = rgb([170, 160, 140]); g.beginPath(); g.roundRect(4, 10, 56, 44, 6); g.fill();
      g.fillStyle = rgb([200, 192, 172]); g.fillRect(8, 12, 48, 8);
      g.fillStyle = rgb([130, 122, 106]); g.fillRect(8, 44, 48, 8);
      g.beginPath(); g.roundRect(4, 10, 56, 44, 6); g.stroke();
    } else if (kind === 'sack') {
      g.fillStyle = rgb([196, 182, 150]); g.beginPath(); g.roundRect(4, 14, 56, 40, 14); g.fill();
      g.fillStyle = rgb([150, 136, 108]); g.fillRect(8, 42, 48, 8);
      g.fillStyle = rgb([120, 60, 50]); g.fillRect(20, 26, 24, 7);
      g.beginPath(); g.roundRect(4, 14, 56, 40, 14); g.stroke();
    } else if (kind === 'tub') {
      g.beginPath(); g.moveTo(6, 20); g.lineTo(w - 6, 20); g.lineTo(w - 12, h - 6); g.lineTo(12, h - 6); g.closePath();
      g.fillStyle = rgb([132, 96, 60]); g.fill();
      g.save(); g.clip(); g.fillStyle = rgb([132, 96, 60], 0.7); g.fillRect(w - 22, 0, 22, h); g.fillStyle = rgb([80, 80, 84]); g.fillRect(0, 32, w, 4); g.fillRect(0, 48, w, 4); g.restore();
      g.stroke();
      g.fillStyle = rgb([180, 176, 166]); g.beginPath(); g.ellipse(w / 2, 21, 25, 6, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  });
}

const matCache = new Map<string, THREE.MeshBasicMaterial>();
function material(kind: Kind) {
  let m = matCache.get(kind);
  if (!m) {
    const stick = ['pole', 'tube', 'plank', 'board', 'rope'].includes(kind);
    m = new THREE.MeshBasicMaterial({ map: stick ? stickTex(kind) : blobTex(kind), transparent: true, depthWrite: false, alphaTest: 0.05 });
    m.userData.shared = true;
    matCache.set(kind, m);
  }
  return m;
}
const unitPlane = new THREE.PlaneGeometry(1, 1);
unitPlane.userData.shared = true;

const Z: Partial<Record<Kind, number>> = { plank: 4.52, board: 4.52, lash: 4.56, coupler: 4.56, plate: 4.5, stone: 4.62, sack: 4.62, tub: 4.62, rope: 4.49, basket: 4.5, wheel: 4.57 };

export class Scaffold {
  group = new THREE.Group();
  members: Member[] = [];
  /** erection progress 0..1 (counts down while being struck) */
  progress = 0;
  state: 'build' | 'up' | 'strike' | 'gone' | 'fallen' = 'build';
  /** offset from where it was built (rides the block) */
  ox = 0; oy = 0;
  /** world bounds when built */
  bx0: number; bx1: number; by0: number; by1: number;
  fallenT = 0;
  /** a timber scaffold caught by fire: seconds until it gives way */
  burnT = -1;
  private home: V2;
  private hoist: { basket: Member; rope: Member; x: number; y0: number; y1: number } | null = null;
  ladder: THREE.Mesh;

  constructor(private g: Game, public block: Block, public plan: ScaffoldPlan, public era: Era) {
    const t = block.body.translation();
    this.home = { x: t.x, y: t.y };
    this.bx0 = plan.x0 - 0.15; this.bx1 = plan.x1 + 0.15; this.by0 = plan.base; this.by1 = plan.base + plan.height + 0.2;
    this.build();
    this.ladder = makeLadder(0.1, era === 'modern' ? 'steel' : 'wood');
    g.root.add(this.group);
  }

  get timber() { return this.era !== 'modern'; }
  /** world position of a scaffold-local point */
  wx(x: number) { return x + this.ox; }
  wy(y: number) { return y + this.oy; }
  /** platform height above the base, in world y */
  stationY(i: number) { return this.plan.base + this.plan.stations[i].h + this.oy; }
  get built() { return this.state === 'up'; }
  get standing() { return this.state === 'build' || this.state === 'up' || this.state === 'strike'; }

  private add(kind: Kind, x0: number, y0: number, x1: number, y1: number, th: number, order: number) {
    const mesh = new THREE.Mesh(unitPlane, material(kind));
    mesh.visible = false;
    const m: Member = { kind, mesh, x0, y0, x1, y1, th, order };
    mesh.position.z = Z[kind] ?? 4.5;
    this.group.add(mesh);
    this.members.push(m);
    return m;
  }
  /** a blob (lashing, coupler, plate, load) centred at x, y */
  private blob(kind: Kind, x: number, y: number, s: number, order: number) { return this.add(kind, x - s / 2, y, x + s / 2, y, s, order); }

  private build() {
    const p = this.plan, T = this.timber;
    const base = p.base, top = base + p.height;
    const stick: Kind = T ? 'pole' : 'tube';
    const thS = T ? 0.12 : 0.075, thL = T ? 0.095 : 0.07;
    const joint: Kind = T ? 'lash' : 'coupler';
    const lift = T ? 1.5 : 1.8;
    // the standards: two rows (side) or one every bay (front)
    const xs: number[] = [];
    if (p.layout === 'side') {
      const wallX = p.side < 0 ? p.x1 : p.x0;
      xs.push(wallX + p.side * 0.16, wallX + p.side * (p.x1 - p.x0 - 0.1));
    } else {
      const n = Math.max(1, Math.ceil((p.x1 - p.x0) / (T ? 1.7 : 1.9)));
      for (let i = 0; i <= n; i++) xs.push(p.x0 + ((p.x1 - p.x0) * i) / n);
    }
    let rnd = 1;
    const R = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
    const lifts: number[] = [];
    for (let h = lift; h < p.height - 0.6; h += lift) lifts.push(h);
    const work = new Set(p.stations.filter((s) => s.h > 0).map((s) => s.h));
    if (!work.size && lifts.length) work.add(lifts[0]);
    for (const h of work) if (!lifts.some((q) => Math.abs(q - h) < 0.05)) lifts.push(h);
    lifts.sort((a, b) => a - b);
    const nOrder = lifts.length + 3;
    // standards (timber poles lean a touch and are of uneven length)
    xs.forEach((x, i) => {
      const lean = T ? (R() - 0.5) * 0.06 : 0;
      this.add(stick, x, base - (T ? 0.05 : 0), x + lean, top + (T ? R() * 0.25 : 0), thS, (i / xs.length) * (1 / nOrder));
      if (!T) this.blob('plate', x, base + 0.02, 0.2, (i / xs.length) * (1 / nOrder));
    });
    const xL = Math.min(...xs), xR = Math.max(...xs);
    const wallX = p.layout === 'side' ? (p.side < 0 ? p.x1 : p.x0) : 0;
    lifts.forEach((h, k) => {
      const o = (k + 1) / nOrder;
      const y = base + h;
      // ledger/putlog: in the side section it runs from the outer standard into the putlog hole in the wall
      const fx = p.layout === 'side' ? faceX(p, y) : wallX;
      const a = p.layout === 'side' ? (p.side < 0 ? xL - 0.1 : fx - 0.1) : xL - 0.15;
      const b = p.layout === 'side' ? (p.side < 0 ? fx + 0.1 : xR + 0.1) : xR + 0.15;
      this.add(stick, a, y, b, y, thL, o);
      for (const x of xs) this.blob(joint, x, y, T ? 0.17 : 0.13, o + 0.3 / nOrder);
      if (work.has(h)) {
        // the working lift: planks (boards) on the putlogs, toe board and rails on the open side
        this.add(T ? 'plank' : 'board', a + 0.04, y + 0.07, b - 0.04, y + 0.07, 0.09, o + 0.5 / nOrder);
        const rx = p.layout === 'side' ? (p.side < 0 ? xL : xR) : null;
        if (!T) {
          if (rx !== null) this.add('board', rx, y + 0.08, rx, y + 0.25, 0.05, o + 0.6 / nOrder);
          this.add(stick, a, y + 0.55, b, y + 0.55, 0.06, o + 0.7 / nOrder);
          this.add(stick, a, y + 1.0, b, y + 1.0, 0.06, o + 0.75 / nOrder);
        } else {
          this.add(stick, a, y + 0.95, b, y + 0.95, 0.07, o + 0.7 / nOrder);
        }
      }
    });
    // diagonal braces across the bays
    const o = (lifts.length + 1) / nOrder;
    if (p.layout === 'side') {
      const yTop = base + (lifts[lifts.length - 1] ?? p.height * 0.7);
      this.add(stick, xL, base + 0.15, xR, yTop, T ? 0.08 : 0.06, o);
    } else {
      for (let i = 0; i + 1 < xs.length; i += 2) this.add(stick, xs[i], base + 0.15, xs[i + 1], base + Math.min(p.height - 0.3, (lifts[1] ?? lifts[0] ?? 1.5)), T ? 0.08 : 0.06, o + i * 0.02);
    }
    // a gin-pole hoist on tall timber scaffolds, a gin wheel on steel ones
    if (p.height > 3.2) {
      // lashed (or clamped) to the outermost standard on the side of the material stack
      const out = p.pileX > p.ladderX ? 1 : -1;
      const hx = out > 0 ? xR : xL;
      const yTop = top + (T ? 0.6 : 0.3);
      if (T) this.add('pole', hx, top - 1.4, hx, yTop, 0.09, o + 1 / nOrder);
      const arm = hx + out * 0.6;
      this.add(stick, hx, yTop - 0.05, arm, yTop - 0.05, 0.07, o + 1.2 / nOrder);
      this.blob('wheel', arm, yTop - 0.18, 0.22, o + 1.3 / nOrder);
      const rope = this.add('rope', arm + 0.1, yTop - 0.2, arm + 0.1, base + 0.6, 0.035, o + 1.4 / nOrder);
      const basket = this.blob(T ? 'basket' : 'sack', arm + 0.1, base + 0.3, 0.36, o + 1.5 / nOrder);
      this.hoist = { basket, rope, x: arm + 0.1, y0: base + 0.3, y1: yTop - 0.7 };
    }
    // the stack of materials at the foot
    const px = p.pileX;
    if (T) { this.blob('stone', px - 0.2, base + 0.16, 0.34, 0.02); this.blob('stone', px + 0.16, base + 0.15, 0.3, 0.04); this.blob('tub', px + 0.05, base + 0.42, 0.34, 0.06); }
    else { this.blob('sack', px - 0.18, base + 0.14, 0.34, 0.02); this.blob('sack', px + 0.16, base + 0.14, 0.34, 0.04); this.blob('sack', px, base + 0.38, 0.32, 0.06); }
    // the ladder (its own mesh: rungs tile)
    const lh = (p.stations[p.stations.length - 1]?.h ?? 0) + 1.0;
    if (lh > 1.05) {
      const lad = makeLadder(lh, this.era === 'modern' ? 'steel' : 'wood');
      lad.position.set(p.ladderX, base, 4.55);
      lad.visible = false;
      this.group.add(lad);
      this.members.push({ kind: 'rope', mesh: lad, x0: p.ladderX, y0: base, x1: p.ladderX, y1: base + lh, th: 0, order: o + 0.5 / nOrder });
    }
    this.members.sort((a, b) => a.order - b.order);
  }

  /** seconds to put it up with one pair of hands */
  get buildTime() { return 2.2 + this.plan.height * 0.45; }

  /** follow the block; build/strike progress; tumbling members once knocked down */
  update(dt: number, crewAtFoot: number) {
    const b = this.block;
    if (this.standing && !b.dead) {
      const t = b.body.translation();
      this.ox = t.x - this.home.x; this.oy = t.y - this.home.y;
      this.group.position.set(this.ox, this.oy, 0);
    }
    const rate = crewAtFoot > 0 ? Math.min(1.8, 0.7 + crewAtFoot * 0.4) / this.buildTime : 0;
    if (this.state === 'build') { this.progress = Math.min(1, this.progress + rate * dt); if (this.progress >= 1) this.state = 'up'; }
    else if (this.state === 'strike') { this.progress = Math.max(0, this.progress - rate * 1.4 * dt); if (this.progress <= 0) { this.state = 'gone'; this.dispose(); return; } }
    if (this.state === 'fallen') { this.updateFall(dt); return; }
    // pole by pole: each member slides into place over a moment once its turn comes
    for (const m of this.members) {
      const k = Math.max(0, Math.min(1, (this.progress - m.order) / 0.06));
      m.mesh.visible = k > 0;
      if (k > 0) this.placeMember(m, k);
    }
    if (this.hoist && this.state === 'up') {
      // the hoist works materials up and down on its rope
      const h = this.hoist, c = 0.5 - 0.5 * Math.cos(this.g.time * 0.8);
      const y = h.y0 + (h.y1 - h.y0) * c;
      h.basket.y0 = h.basket.y1 = y;
      h.rope.y1 = y + 0.18;
      this.placeMember(h.basket, 1);
      this.placeMember(h.rope, 1);
    }
  }

  private placeMember(m: Member, k: number) {
    const mesh = m.mesh as THREE.Mesh;
    if (m.th === 0) { mesh.scale.y = k; mesh.position.x = m.x0; mesh.position.y = m.y0; return; } // ladder
    const dx = m.x1 - m.x0, dy = m.y1 - m.y0, len = Math.hypot(dx, dy);
    if (len < 1e-3 || m.kind === 'lash' || m.kind === 'coupler' || m.kind === 'plate' || m.kind === 'wheel' || m.kind === 'basket' || m.kind === 'stone' || m.kind === 'sack' || m.kind === 'tub') {
      // a blob pops on
      const s = m.th * (0.6 + 0.4 * k);
      mesh.position.set((m.x0 + m.x1) / 2, m.y0, mesh.position.z);
      mesh.scale.set(s, s, 1);
      mesh.rotation.z = 0;
      return;
    }
    // a stick grows from its first end
    const l = len * k;
    mesh.position.set(m.x0 + (dx / len) * l / 2, m.y0 + (dy / len) * l / 2, mesh.position.z);
    mesh.scale.set(l, m.th, 1);
    mesh.rotation.z = Math.atan2(dy, dx);
  }

  /** the block split: carry on with the piece that took its place */
  rebind(b: Block) { const t = b.body.translation(); this.home = { x: t.x - this.ox, y: t.y - this.oy }; this.block = b; }

  /** take it down in reverse (the crew does it from the foot) */
  strike() { if (this.state === 'build' || this.state === 'up') this.state = 'strike'; }

  /** world bounds of what is standing */
  bounds() { return { x0: this.bx0 + this.ox, x1: this.bx1 + this.ox, y0: this.by0 + this.oy, y1: this.by0 + (this.by1 - this.by0) * Math.max(0.3, this.progress) + this.oy }; }

  /** distance from a point to the standing scaffold */
  dist(x: number, y: number) {
    const r = this.bounds();
    const dx = Math.max(r.x0 - x, 0, x - r.x1), dy = Math.max(r.y0 - y, 0, y - r.y1);
    return Math.hypot(dx, dy);
  }

  /** knocked down: every member that was up becomes a tumbling stick, thrown away from `from` */
  collapse(from: V2 | null, k = 1, burning = false) {
    if (!this.standing) return;
    this.state = 'fallen';
    this.fallenT = 0;
    const r = this.bounds();
    const cx = from?.x ?? (r.x0 + r.x1) / 2, cy = from?.y ?? r.y0;
    for (const m of this.members) {
      if (!m.mesh.visible) { m.mesh.parent?.remove(m.mesh); continue; }
      const mesh = m.mesh;
      const x = mesh.position.x + this.ox, y = mesh.position.y + this.oy;
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
      const push = from ? Math.min(9, (4 * k) / (0.6 + d * 0.4)) : 0.6;
      m.fall = { x, y, vx: (dx / d) * push + (Math.random() - 0.5) * 1.2, vy: (dy / d) * push * 0.6 + Math.random() * 1.5 * k, r: mesh.rotation.z, vr: (Math.random() - 0.5) * (from ? 6 : 2.5), rest: 0 };
      // ladders (a separate mesh with its own origin) fall as one piece round their foot
      this.g.root.add(mesh);
      mesh.position.set(x, y, mesh.position.z);
      if (burning && Math.random() < 0.5) m.fall.vr *= 0.5;
    }
    this.burning = burning;
    this.g.root.remove(this.group);
  }
  burning = false;

  private updateFall(dt: number) {
    this.fallenT += dt;
    const g = this.g;
    const fade = Math.max(0, 1 - Math.max(0, this.fallenT - 4) / 1.5);
    for (const m of this.members) {
      const f = m.fall;
      if (!f) continue;
      const mesh = m.mesh as THREE.Mesh;
      if (f.rest < 1) {
        f.vy -= 9.81 * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.r += f.vr * dt;
        const half = m.th === 0 ? 0.1 : Math.abs(Math.sin(f.r)) * mesh.scale.x * 0.5 + m.th * 0.5;
        const gy = g.groundY(f.x) + half;
        if (f.y < gy) {
          f.y = gy; f.vy *= -0.25; f.vx *= 0.5; f.vr *= 0.4;
          // a stick lies down flat
          if (m.th > 0) f.r += (Math.round(f.r / Math.PI) * Math.PI - f.r) * Math.min(1, dt * 6);
          if (Math.abs(f.vy) < 0.4 && Math.abs(f.vx) < 0.3) f.rest += dt * 2;
        }
      }
      mesh.position.set(f.x, f.y, mesh.position.z);
      mesh.rotation.z = f.r;
      if (this.burning && this.fallenT < 3 && Math.random() < dt * 2 && m.kind === 'pole') {
        g.r.flame.spawn({ x: f.x, y: f.y, vx: g.wind * 0.3, vy: 1 + Math.random(), max: 0.5, size0: 0.35, size1: 0.1, c0: [1.4, 0.75, 0.15], c1: [0.75, 0.16, 0.03], a0: 0.9, a1: 0, drag: 1 });
      }
      if (fade < 1) {
        const mm = mesh.material as THREE.MeshBasicMaterial;
        if (!mesh.userData.own) { mesh.material = mm.clone(); mesh.userData.own = true; }
        (mesh.material as THREE.MeshBasicMaterial).opacity = fade;
      }
    }
    if (fade <= 0) this.dispose();
  }

  get done() { return this.state === 'gone' || (this.state === 'fallen' && this.fallenT > 5.6); }

  dispose() {
    for (const m of this.members) {
      m.mesh.parent?.remove(m.mesh);
      if (m.mesh.userData.own) ((m.mesh as THREE.Mesh).material as THREE.Material).dispose();
      if (m.th === 0) ((m.mesh as THREE.Mesh).geometry).dispose();
    }
    this.members = [];
    this.g.root.remove(this.group);
    if (this.state !== 'fallen') this.state = 'gone';
    else this.fallenT = 99;
  }
}

/**
 * Where a scaffold for block b can stand: beside its left face (the attacker's side, preferred) or its
 * right face if that strip is clear down to the ground; otherwise across the front of it. Work stations
 * are the lifts from which a man can reach part of the block (hands from 0.3 to 1.7 m above his feet).
 */
export function planScaffold(g: Game, b: Block, era: Era): ScaffoldPlan {
  const t = b.body.translation();
  const bx0 = t.x - b.w / 2, bx1 = t.x + b.w / 2, by0 = t.y - b.h / 2, by1 = t.y + b.h / 2;
  const depth = era === 'modern' ? 1.45 : 1.55;
  const lift = era === 'modern' ? 1.8 : 1.5;
  const stationsFor = (base: number) => {
    const lo = by0 - base, hi = by1 - base;
    const st: number[] = [];
    if (lo < 1.55) st.push(0);
    for (let h = lift; h + 0.3 < hi; h += lift) if (h + 0.35 < hi && h + 1.6 > lo) st.push(h);
    if (!st.length) st.push(Math.max(0, Math.floor((lo - 0.2) / lift) * lift));
    return st;
  };
  const clear = (x0: number, x1: number, y0: number, y1: number) => {
    let hit = false;
    for (const q of g.blocks) {
      if (q === b || q.dead) continue;
      const p = q.body.translation();
      if (p.x + q.w / 2 > x0 && p.x - q.w / 2 < x1 && p.y + q.h / 2 > y0 && p.y - q.h / 2 < y1) { hit = true; break; }
    }
    return !hit;
  };
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? bx0 - depth : bx1, x1 = side < 0 ? bx0 : bx1 + depth;
    const base = Math.max(g.groundY(x0), g.groundY(x1), g.groundY((x0 + x1) / 2));
    if (by0 < base - 0.6 || by1 - base > 16) continue;
    const st = stationsFor(base);
    const height = Math.max(lift + 0.9, st[st.length - 1] + 1.1, Math.min(by1 - base + 0.2, st[st.length - 1] + 1.6));
    // the strip must be free of other blocks (the wall the block stands in is on its inner edge)
    if (!clear(side < 0 ? x0 - 0.3 : x0 + 0.03, side < 0 ? x1 - 0.03 : x1 + 0.3, base + 0.08, base + height + 0.2)) continue;
    // sound the face every 0.25 m up: a horizontal ray from the scaffold side onto this block only
    const faces: { y: number; x: number }[] = [];
    const ox = side < 0 ? bx0 - 0.05 : bx1 + 0.05;
    let last = side < 0 ? bx0 : bx1;
    for (let y = base + 0.1; y < base + height + 1.2; y += 0.25) {
      const toi = b.collider.castRay(new RAPIER.Ray({ x: ox, y }, { x: -side, y: 0 }), b.w + 0.2, true);
      if (toi >= 0) last = ox - side * toi;
      faces.push({ y, x: last });
    }
    const partial = { side, x0, x1, faces } as ScaffoldPlan;
    // the man stands ~0.5 m off the face at hand height (a hammer blow reaches it), mates further out
    const stations: Station[] = st.map((h) => {
      const wall = faceX(partial, base + h + 1.1);
      return { h, spots: [{ x: wall + side * 0.48, face: -side }, { x: wall + side * 1.12, face: -side }] };
    });
    const outer = side < 0 ? x0 : x1;
    const ladderX = outer - side * 0.05;
    return { layout: 'side', side, x0, x1, base, height, stations, ladderX, pileX: outer + (side < 0 ? -0.75 : 0.75), wall: side, faces };
  }
  // across the front: the scaffold spans the block's face, from the ground at its centre
  const x0 = Math.min(bx0 - 0.3, t.x - 1.0), x1 = Math.max(bx1 + 0.3, t.x + 1.0);
  const base = g.groundY(t.x);
  const st = stationsFor(base);
  const height = Math.max(lift + 0.9, st[st.length - 1] + 1.1, Math.min(by1 - base + 0.2, st[st.length - 1] + 1.6));
  const spots = (n: number) => {
    const out: { x: number; face: number }[] = [];
    for (let i = 0; i < n; i++) { const x = t.x + (i % 2 ? 1 : -1) * (0.35 + Math.floor(i / 2) * 0.45) * Math.max(0.8, Math.min(1, b.w / 1.4)); out.push({ x, face: x < t.x ? 1 : -1 }); }
    return out;
  };
  const stations: Station[] = st.map((h) => ({ h, spots: spots(b.w > 2.4 ? 3 : 2) }));
  return { layout: 'front', side: 0, x0, x1, base, height, stations, ladderX: x0 - 0.2, pileX: x0 - 0.95, wall: 1, faces: [] };
}
