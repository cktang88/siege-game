import type { MatId, TargetKind } from './config';
import type { BlockDef, HouseDef, LevelDef } from './levels';
import { cannonFor } from './fortgen';
import { concealRooms } from './conceal';
import { arch, beam, flare, polyBlock, roof, trap, wedge } from './shapes';

/*
  Real-structure archetypes for side-view sieges. Proportions follow docs/RESEARCH.md
  (talus/batter, hoardings, Vauban rampart profile, Regelbau casemates, flak towers,
  ishigaki bases and tiered tenshu, flying buttresses, refinery tank farms, airship hangars).
  Everything stands on real support; polygons give the sloped faces that make rounds glance.
*/

type Backdrop = NonNullable<LevelDef['backdrops']>[number];
interface Room { x0: number; x1: number; y0: number; y1: number; floor: number; deps: number[]; tag: string; floorIdx: number }

export class Site {
  blocks: BlockDef[] = [];
  backdrops: Backdrop[] = [];
  rooms: Room[] = [];
  ground: [number, number][] = [[-80, 0]];
  g = 0;
  x = 0;
  targets: TargetKind[] = [];
  intel: string[] = [];
  constructor(public R: () => number) {}

  pick<T>(xs: T[]) { return xs[Math.floor(this.R() * xs.length)]; }
  add(x: number, y: number, w: number, h: number, mat: MatId, extra: Partial<BlockDef> = {}) {
    this.blocks.push({ x: +x.toFixed(3), y: +y.toFixed(3), w: +w.toFixed(3), h: +h.toFixed(3), mat, ...extra });
    return this.blocks.length - 1;
  }
  push(...defs: BlockDef[]) { for (const d of defs) this.blocks.push(d); return this.blocks.length - 1; }
  /** terrain point (the polyline is built left to right as modules are laid down) */
  groundTo(x: number, y: number) { this.ground.push([+x.toFixed(2), +y.toFixed(2)]); }
  col(x: number, y: number, w: number, h: number, mat: MatId, seg = 1.2, extra: Partial<BlockDef> = {}) {
    const n = Math.max(1, Math.round(h / seg));
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(this.add(x, y + (i * h) / n, w, h / n, mat, extra));
    return ids;
  }
  battlements(x0: number, x1: number, y: number, mat: MatId, h = 0.9) {
    for (let x = x0; x + 0.7 <= x1 + 0.01; x += 1.5) this.add(x, y, 0.7, h, mat);
  }

  /**
   * Post-and-lintel grid frame (slabs meet at column centres). Returns the top and right edge.
   * Each room gets a cutaway back wall that disappears when its columns or ceiling fail.
   */
  frame(tag: string, x0: number, y0: number, cols: number, floors: number, roomW: number, floorH: number, colW: number,
    mats: (f: number) => { col: MatId; slab: MatId; back?: MatId; disguise?: MatId }, slabH = 0.5,
    /** per-storey taper: inset from each side and column thickness (walls thin as they rise) */
    shape?: (f: number) => { inset: number; colW: number }) {
    const W = cols * roomW + (cols + 1) * colW;
    let y = y0;
    let lx0 = x0, lx1 = x0 + W;
    let below: { a: number; b: number; idx: number }[] = [];
    for (let f = 0; f < floors; f++) {
      const m = mats(f);
      const sh = shape ? shape(f) : { inset: 0, colW };
      const cw = sh.colW;
      const fx0 = x0 + sh.inset;
      const fw = W - 2 * sh.inset;
      const rw = (fw - cw * (cols + 1)) / cols;
      const cx = (c: number) => fx0 + c * (rw + cw);
      const colIdx: number[][] = [];
      for (let c = 0; c <= cols; c++) colIdx.push(this.col(cx(c), y, cw, floorH, m.col, floorH > 2 ? floorH / 2 : floorH, m.disguise ? { disguise: m.disguise } : {}));
      const fy = y;
      y += floorH;
      const slabs: { a: number; b: number; idx: number }[] = [];
      for (let c = 0; c < cols; c++) {
        const a = c === 0 ? cx(0) - 0.15 : cx(c) + cw / 2;
        const b = c === cols - 1 ? cx(cols) + cw + 0.15 : cx(c + 1) + cw / 2;
        const slab = this.add(a, y, b - a, slabH, m.slab);
        slabs.push({ a, b, idx: slab });
        const deps = [...colIdx[c], ...colIdx[c + 1], slab];
        const rx0 = cx(c) + cw, rx1 = cx(c + 1);
        const mid = (rx0 + rx1) / 2;
        const floorIdx = below.find((q) => mid >= q.a && mid <= q.b)?.idx ?? -1;
        this.rooms.push({ x0: rx0, x1: rx1, y0: fy, y1: fy + floorH, floor: f, deps, tag, floorIdx });
        this.backdrops.push({ x: rx0, y: fy, w: rw, h: floorH + slabH * 0.5, mat: m.back ?? (m.col === 'steel' ? 'concrete' : m.col), deps });
      }
      below = slabs;
      lx0 = fx0; lx1 = fx0 + fw;
      y += slabH;
    }
    return { top: y, x1: x0 + W, topX0: lx0, topX1: lx1 };
  }

  /** drop a target (or furniture) into a room of the given tag */
  place(tag: string, kind: TargetKind, pickRoom: (r: Room[]) => Room | undefined = (r) => r[0]) {
    const free = this.rooms.filter((r) => r.tag === tag && !this.blocks.some((b) => b.target && b.x >= r.x0 - 0.01 && b.x < r.x1 && Math.abs(b.y - r.y0) < 0.05));
    const r = pickRoom(free);
    if (!r) return false;
    const w = Math.min(2.4, r.x1 - r.x0 - 0.5);
    this.add((r.x0 + r.x1) / 2 - w / 2, r.y0, w, kind === 'ammo' ? 1.1 : 1.3, kind === 'ammo' ? 'crate' : kind === 'command' ? 'stone' : 'wood', { target: kind });
    this.targets.push(kind);
    return true;
  }
  /** gun/flak on a roof */
  roofGun(x: number, y: number, kind: 'artillery' | 'flak') { this.add(x - 1.1, y, 2.2, 1, 'steel', { target: kind }); this.targets.push(kind); }
  furnish(tag?: string) {
    for (const r of this.rooms) {
      if (tag && r.tag !== tag) continue;
      if (this.blocks.some((b) => b.target && b.x >= r.x0 - 0.01 && b.x < r.x1 && Math.abs(b.y - r.y0) < 0.05)) continue;
      const w = r.x1 - r.x0, roll = this.R();
      if (roll < 0.28) this.add(r.x0 + 0.3, r.y0, Math.min(1.3, w - 0.6), 0.85, 'crate');
      else if (roll < 0.45) this.add(r.x0 + w / 2 - 0.55, r.y0, 1.1, 1.1, 'stone');
    }
  }
}

// ───────────────────────── medieval ─────────────────────────

/** curtain wall with a talus (battered base) facing the attacker and a machicolated wall-head */
export function curtain(s: Site, h: number, thick = 2.2, mat: MatId = 'stone') {
  const th = h * 0.3;
  // the talus (and the machicolation's 0.7 m overhang) project in front of the wall: start clear of the last work
  const x = s.x + Math.max(th * 0.38, 0.7), g = s.g;
  // talus: bottom ~30% of the wall flares out at ~70°
  s.push(wedge(x - th * 0.38, g, th * 0.38, th, mat, 'right'));
  const courses = Math.round(h / 1.2);
  // walls are thickest at the base: the upper third steps back to ~65% (a wall-walk ledge behind)
  let tTop = thick;
  for (let i = 0; i < courses; i++) {
    const t = i < courses * 0.6 ? thick : thick * 0.65;
    tTop = t;
    if (i % 2 === 0) { s.add(x, g + i * 1.2, t / 2, 1.2, mat); s.add(x + t / 2, g + i * 1.2, t / 2, 1.2, mat); }
    else s.add(x, g + i * 1.2, t, 1.2, mat);
  }
  const top = g + courses * 1.2;
  // machicolation: a stone gallery cantilevered on corbels, merlons on top
  s.push(flare(x, top, tTop, 0.5, mat, 0.7, 0.2));
  s.battlements(x - 0.7, x + tTop + 0.2, top + 0.5, mat);
  s.x = x + thick;
  return top;
}

/** columns thin from `base` to `top` metres as the storeys rise; optional butter-churn step inward */
const taper = (floors: number, base: number, top: number, stepAt = -1, step = 0) => (f: number) => ({
  colW: +(base + (top - base) * (f / Math.max(1, floors - 1))).toFixed(2),
  inset: stepAt >= 0 && f >= stepAt ? step : 0,
});

/**
 * Tall tower keep: battered base, walls thinning with height, the upper storeys stepped in
 * (a butter-churn keep), timber hoarding at the wall head and a steep conical roof.
 */
export function towerKeep(s: Site, opts: { floors?: number; w?: number; cols?: number; roofMat?: MatId; hoarding?: boolean; roof?: boolean; tag?: string } = {}) {
  const R = s.R, g = s.g, x = s.x + 1.8; // clear of the battered foot on the near side
  const floors = opts.floors ?? 6 + Math.floor(R() * 3);
  const cols = opts.cols ?? 2;
  const w = opts.w ?? cols * 4.2 + 1.6;
  const tag = opts.tag ?? 'keep';
  const roomW = (w - 1.6 * (cols + 1)) / cols;
  const stepAt = cols > 1 ? Math.ceil(floors * 0.6) : -1;
  s.push(wedge(x - 1.8, g, 1.8, 3.6, 'stone', 'right'), wedge(x + w, g, 1.8, 3.6, 'stone', 'left'));
  const f = s.frame(tag, x, g, cols, floors, roomW, 2.6, 1.6,
    (k) => ({ col: k < floors - 2 ? 'stone' : 'wood', slab: k < 2 ? 'stone' : 'wood', back: k < floors - 2 ? 'stone' : 'plaster' }), 0.5,
    taper(floors, 1.6, 0.8, stepAt, 1.2));
  let top = f.top;
  const tw = f.topX1 - f.topX0;
  if (opts.hoarding ?? true) {
    s.push(flare(f.topX0, top, tw, 1.1, 'wood', 0.9, 0.9));
    top += 1.1;
  }
  if (opts.roof ?? true) s.push(roof(f.topX0 - 1.1, top, tw + 2.2, Math.min(12, (tw + 2.2) * 1.1), opts.roofMat ?? 'tile'));
  else s.battlements(f.topX0 - 0.9, f.topX1 + 0.2, top, 'wood');
  s.x = f.x1 + 1.8 + 1.2; // past the far batter
  return { x0: f.topX0, x1: f.topX1, top };
}

/** bergfried: a slender main tower 25–35 m tall, very thick at the foot, stepped narrower above */
export function bergfried(s: Site, opts: { floors?: number; gun?: 'artillery' | 'flak'; tag?: string } = {}) {
  const x = s.x + 1.4, g = s.g; // clear of the battered foot on the near side
  const floors = opts.floors ?? 9;
  const tag = opts.tag ?? `berg${Math.round(x)}`;
  s.push(wedge(x - 1.4, g, 1.4, 4, 'stone', 'right'), wedge(x + 6.4, g, 1.4, 4, 'stone', 'left'));
  const f = s.frame(tag, x, g, 1, floors, 2.6, 2.5, 1.9,
    (k) => ({ col: k < floors - 2 ? 'stone' : 'wood', slab: k < 3 ? 'stone' : 'wood', back: 'stone' }), 0.45,
    taper(floors, 1.9, 0.8, Math.ceil(floors * 0.65), 0.6));
  const tw = f.topX1 - f.topX0;
  s.push(flare(f.topX0, f.top, tw, 0.9, 'wood', 0.8, 0.8));
  const top = f.top + 0.9;
  if (opts.gun) s.roofGun((f.topX0 + f.topX1) / 2, top, opts.gun);
  else s.push(roof(f.topX0 - 1, top, tw + 2, (tw + 2) * 1.8, 'tile'));
  s.x = x + 6.4 + 1.4 + 1.2; // past the far batter
  return { tag, top };
}

/** twin-towered gatehouse: arched passage, portcullis bars, conical roofs */
export function gatehouse(s: Site) {
  const g = s.g, x = s.x;
  const tw = 3.6, pass = 3.4;
  const t1 = s.frame('gate', x, g, 1, 3, tw - 1.6, 2.5, 0.8, () => ({ col: 'stone', slab: 'stone' }));
  const px = t1.x1;
  // arched passage on two springer piers between the towers
  s.col(px, g, 0.7, 2.8, 'stone', 1.4);
  s.col(px + pass - 0.7, g, 0.7, 2.8, 'stone', 1.4);
  for (const v of arch(px + pass / 2, g + 2.8, pass / 2 - 0.7, pass / 2, 7, 'stone')) s.push(v);
  // portcullis: steel bars in the passage
  for (let i = 0; i < 3; i++) s.add(px + 0.9 + i * 0.55, g, 0.16, 2.6, 'steel');
  const t2 = s.frame('gate', px + pass, g, 1, 3, tw - 1.6, 2.5, 0.8, () => ({ col: 'stone', slab: 'stone' }));
  s.push(roof(x - 0.5, t1.top, tw + 1, 3.6, 'tile'), roof(px + pass - 0.5, t2.top, tw + 1, 3.6, 'tile'));
  s.x = t2.x1 + 2.5;
}

/** a moat: the terrain dips in front of the next work */
export function moat(s: Site, w = 6, depth = 3) {
  const x = s.x;
  s.groundTo(x, s.g); s.groundTo(x + 1, s.g - depth); s.groundTo(x + w - 1, s.g - depth); s.groundTo(x + w, s.g);
  s.x = x + w + 0.5;
}

/** great hall with a pitched roof */
export function hall(s: Site, tag = 'hall', target?: TargetKind) {
  const x = s.x, g = s.g;
  const f = s.frame(tag, x, g, 2, 1, 4.2, 3, 0.9, () => ({ col: 'stone', slab: 'wood', back: 'plaster' }));
  s.push(roof(x - 0.8, f.top, f.x1 - x + 1.6, 3.4, 'tile'));
  if (target) s.place(tag, target);
  s.x = f.x1 + 2.5;
}

// ───────────────────────── artillery era ─────────────────────────

/** trace-italienne front: glacis, ditch, masonry escarp, earth rampart with parapet, guns on the terreplein */
export function starFortFront(s: Site, guns = 2, glacis = 16) {
  const g = s.g;
  let x = s.x;
  // glacis: a long gentle earth slope (part of the terrain) rising to the covered way
  const crest = g + 2.2;
  s.groundTo(x, g); s.groundTo(x + glacis, crest);
  x += glacis;
  s.add(x, crest, 1.2, 0.9, 'earth'); // covered-way parapet
  x += 1.5;
  // ditch with counterscarp and escarp
  const floor = g - 2.5;
  s.groundTo(x, crest); s.groundTo(x + 0.3, floor); s.groundTo(x + 7, floor);
  x += 7;
  // escarp: coursed masonry revetment up to the rampart, earth rampart behind it
  const rampH = 7;
  for (let i = 0; i < Math.round(rampH / 1.2); i++) s.add(x, floor + i * 1.2, 1.4, 1.2, 'stone');
  const top = floor + Math.round(rampH / 1.2) * 1.2;
  const rx = x + 1.4;
  const rw = 10.5;
  // rampart core: big rammed-earth blocks
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) s.add(rx + i * (rw / 3), floor + j * ((top - floor) / 2), rw / 3, (top - floor) / 2, 'earth');
  s.groundTo(rx + rw, floor); s.groundTo(rx + rw + 0.01, g + 0.5);
  // parapet: earth wedge whose top falls outward at ~1/6, banquette step behind
  s.push(trap(rx, top, 4, 1.8, 'earth', 0.4, 2.2));
  s.add(rx + 4.2, top, 1.2, 0.5, 'earth');
  // guns on the terreplein behind the parapet
  for (let k = 0; k < guns; k++) s.roofGun(rx + 6.7 + k * 2.4, top, 'artillery'); // clear of the banquette step
  s.x = rx + rw + 3.2;
  s.g = g + 0.5;
  s.intel.push('Earthen ramparts soak up high explosive. Drills, bunker busters and plunging fire do better.');
}

/** bombproof magazine: a masonry barrel vault buried under earth */
export function magazine(s: Site) {
  const x = s.x + 2.5, g = s.g; // clear of the near berm
  s.add(x, g, 1.2, 2.2, 'stone');
  s.add(x + 5.2, g, 1.2, 2.2, 'stone');
  for (const v of arch(x + 3.2, g + 2.2, 2, 3.0, 7, 'stone')) s.push(v);
  s.add(x + 2.2, g, 2, 1.1, 'crate', { target: 'ammo' });
  s.targets.push('ammo');
  // earth berms banked against the vault walls
  s.push(wedge(x - 2.5, g, 2.5, 2.2, 'earth', 'right'), wedge(x + 6.4, g, 2.5, 2.2, 'earth', 'left'));
  s.x = x + 6.4 + 2.5 + 1.2;
}

// ───────────────────────── 20th century ─────────────────────────

/** Regelbau-style casemate: 2 m concrete, sloped front, earth piled on the flanks, gun inside */
export function casemate(s: Site, target: TargetKind = 'artillery') {
  const x = s.x + 3, g = s.g; // room for the front berm
  s.push(wedge(x - 3, g, 3, 2.6, 'earth', 'right'));
  s.push(trap(x, g, 2.2, 3.2, 'concrete', 1.4, 0)); // sloped face toward the attacker
  s.add(x + 2.2, g, 3.6, 0.6, 'concrete');
  // the gun is armour plate; a munitions store or a guard room inside is not
  s.add(x + 3.0, g + 0.6, 2.2, 1.2, target === 'artillery' ? 'steel' : target === 'ammo' ? 'crate' : 'wood', { target }); s.targets.push(target);
  s.add(x + 5.8, g, 1.8, 3.2, 'concrete');
  s.push(trap(x + 0.8, g + 3.2, 6.8, 1.6, 'concrete', 1.2, 0.3)); // thick roof, chamfered to the front
  s.push(wedge(x + 7.6, g, 3, 3.4, 'earth', 'left'));
  s.x = x + 11;
}

/** sloped steel glacis plates leaning against a concrete command bunker: shells glance off */
export function armoredBunker(s: Site) {
  const x = s.x + 4.6, g = s.g; // the glacis runs 4.6 m out in front
  // a shallow glacis (~30° from horizontal, like a tank's upper plate): flat fire skips off, plunging fire bites
  s.push(wedge(x - 4.6, g, 6.9, 4.0, 'steel', 'right'));
  const f = s.frame('bunker', x + 2.3, g, 2, 1, 2.8, 2.8, 1.4, () => ({ col: 'concrete', slab: 'concrete', back: 'concrete' }), 1.2);
  s.place('bunker', 'command', (r) => r[r.length - 1]);
  // the roof is plain concrete: plunging fire, bunker busters and AP bombs are the way in
  s.push(trap(x + 2.0, f.top, f.x1 - x - 1.7, 1.2, 'concrete', 1.6, 0.4));
  s.x = f.x1 + 2;
  s.intel.push('The command bunker is faced with sloped armour plate. Flat shots will ricochet; plunge from above.');
}

/** dragon's teeth: staggered rows of truncated concrete pyramids */
export function dragonsTeeth(s: Site, rows = 3) {
  for (let i = 0; i < rows; i++) {
    const h = 1.0 + i * 0.3;
    s.push(trap(s.x, s.g, 1.3, h, 'concrete', 0.4, 0.4));
    s.x += 2.0;
  }
  s.x += 1;
}

/** steel anti-tank tetrahedra (side view of a hedgehog) */
export function hedgehogs(s: Site, n = 3) {
  for (let i = 0; i < n; i++) { s.push(roof(s.x, s.g, 1.4, 1.2, 'steel')); s.x += 2.2; }
}

/** flak tower: a concrete block house with 2.5 m walls, corner gun platforms on cantilevers */
export function flakTower(s: Site, floors = 4, cols = 3) {
  const x = s.x, g = s.g;
  // G-towers were squat: the Zoo tower is ~70 m square and ~39 m tall, so give it width as well as height
  const f = s.frame('flak', x, g, cols, floors, 3.4, 2.8, 2.2, () => ({ col: 'concrete', slab: 'concrete', back: 'concrete' }), 0.9, taper(floors, 2.2, 1.4));
  // corner gun tubs: cantilevered on flared corbels
  s.push(flare(x - 0.4, f.top, 3.4, 1.1, 'concrete', 1.4, 0));
  s.push(flare(f.x1 - 3.0, f.top, 3.4, 1.1, 'concrete', 0, 1.4));
  s.roofGun(x + 0.9, f.top + 1.1, 'flak');
  s.roofGun(f.x1 - 0.9, f.top + 1.1, 'flak');
  s.roofGun((x + f.x1) / 2, f.top, 'artillery');
  s.place('flak', 'command', (r) => r.find((q) => q.floor === 1));
  s.place('flak', 'ammo', (r) => r.find((q) => q.floor === 0));
  s.x = f.x1 + 3;
  s.intel.push('Flak tower: 2 m concrete all round. Bring bunker busters or AP bombs.');
}

// ───────────────────────── Japan ─────────────────────────

/** ishigaki base (concave fan slope, ~45° at the foot to near-vertical at the top) and a tiered tenshu */
export function japaneseCastle(s: Site, tiers = 4) {
  const x = s.x, g = s.g;
  const baseW = 16;
  const insets = [1.4, 0.9, 0.55, 0.3, 0.15];
  let y = g, l = x, r = x + baseW;
  for (const ins of insets) {
    // split each course in two so the base can be breached
    const mid = (l + r) / 2;
    s.push(trap(l, y, mid - l, 1.3, 'stone', ins, 0));
    s.push(trap(mid, y, r - mid, 1.3, 'stone', 0, ins));
    l += ins; r -= ins; y += 1.3;
  }
  let w = r - l - 1;
  let tx = l + 0.5;
  for (let t = 0; t < tiers; t++) {
    const cols = w > 9 ? 3 : w > 5.5 ? 2 : 1;
    const colW = 0.6;
    const roomW = (w - colW * (cols + 1)) / cols;
    const f = s.frame(`tenshu${t}`, tx, y, cols, 1, roomW, 2.9, colW, () => ({ col: 'wood', slab: 'wood', back: 'plaster' }), 0.35);
    // flared tile eaves: the next tier stands on top of them
    const eave = t === tiers - 1 ? 0 : 0.9;
    if (t < tiers - 1) {
      s.push(flare(tx, f.top, w, 0.7, 'tile', eave, eave));
      y = f.top + 0.7;
      // each tier ~80% of the one below (Himeji's tiers shrink all the way up)
      const nw = Math.max(3.8, w * 0.8);
      tx += (w - nw) / 2; w = nw;
    } else {
      s.push(roof(tx - 1.2, f.top, w + 2.4, 3.2, 'tile'));
    }
  }
  s.place(`tenshu${tiers - 1}`, 'command');
  s.place('tenshu0', 'ammo');
  s.x = x + baseW + 3;
  s.intel.push('Plaster over timber on a stone base. The upper tiers will burn.');
}

/** a yagura (corner turret) on a small stone base */
export function yagura(s: Site, target?: TargetKind) {
  const x = s.x, g = s.g;
  s.push(trap(x, g, 6, 1.6, 'stone', 0.6, 0.6));
  const tag = `yagura${x}`;
  const f = s.frame(tag, x + 0.8, g + 1.6, 1, 2, 3.2, 2.4, 0.6, () => ({ col: 'wood', slab: 'wood', back: 'plaster' }), 0.35);
  s.push(roof(x - 0.4, f.top, 6.8, 2.4, 'tile'));
  if (target) s.place(tag, target);
  s.x = x + 8;
}

// ───────────────────────── church ─────────────────────────

/** fortified abbey: arcaded nave, flying buttresses onto outer piers, bell tower with spire */
export function abbey(s: Site) {
  const x = s.x, g = s.g;
  // bell tower first (facing the attacker)
  const bt = s.frame('belltower', x, g, 1, 7, 2.6, 2.6, 1.3, () => ({ col: 'stone', slab: 'wood', back: 'stone' }), 0.45, taper(7, 1.3, 0.7, 4, 0.4));
  s.push(roof(bt.topX0 - 0.3, bt.top, bt.topX1 - bt.topX0 + 0.6, 9, 'tile'));
  const px = bt.x1 + 1.5;
  const naveX = px + 3.4;
  // nave: tall arcade of pointed-ish arches on piers, clerestory wall, timber roof
  const bays = 3, bayW = 4.2, pierW = 1.2;
  const ax = naveX;
  for (let i = 0; i <= bays; i++) {
    s.col(ax + i * (bayW + pierW), g, pierW, 6, 'stone', 1.5);
  }
  for (let i = 0; i < bays; i++) {
    const c = ax + pierW + i * (bayW + pierW) + bayW / 2;
    for (const v of arch(c, g + 6, bayW / 2, bayW / 2 + 0.6, 5, 'stone')) s.push(v);
  }
  const navW = bays * (bayW + pierW) + pierW;
  const wallTop = g + 6 + bayW / 2 + 0.6;
  // outer piers carrying flying buttresses that lean on the clerestory
  // the pinnacle's weight is what keeps a pier from being pushed over by the flyer's thrust
  const pier = (xp: number, endX: number) => {
    s.col(xp, g, 1.4, 6, 'stone', 1.5);
    const towardRight = endX > xp;
    const bx = towardRight ? xp + 1.05 : xp + 0.35;
    s.push(beam(bx, g + 6.3, endX, wallTop + 1.8, 0.45, 'stone'));
    const px0 = towardRight ? xp : xp + 0.8;
    s.add(px0, g + 6, 0.6, 1.6, 'stone');
    s.push(roof(px0 - 0.05, g + 7.6, 0.7, 1.4, 'stone'));
  };
  pier(px - 1.2, ax - 1.7);
  // end buttresses take the arcade's outward thrust; the clerestory slab pins them down
  s.col(ax - 1.4, g, 1.4, wallTop - g, 'stone', 1.45);
  s.col(ax + navW, g, 1.4, wallTop - g, 'stone', 1.45);
  s.add(ax - 1.5, wallTop, navW + 3.0, 0.6, 'stone');
  s.col(ax - 1.4, wallTop + 0.6, 1.4, 2.4, 'stone'); s.col(ax + navW, wallTop + 0.6, 1.4, 2.4, 'stone');
  // clerestory: a pier over every arcade pier, windows between them
  for (let i = 0; i <= bays; i++) s.col(ax + i * (bayW + pierW) + 0.2, wallTop + 0.6, pierW - 0.4, 2.4, 'stone');
  s.add(ax - 1.6, wallTop + 3, navW + 3.2, 0.4, 'wood');
  s.push(roof(ax - 2.2, wallTop + 3.4, navW + 4.4, 5.4, 'tile'));
  // altar end: the treasury/command in the choir
  const choir = ax + navW;
  pier(choir + 3.4, choir + 1.7);
  s.add(ax + pierW + 0.6, g, 2.2, 1.3, 'stone', { target: 'command' }); s.targets.push('command');
  s.add(ax + navW - pierW - 2.6, g, 2, 1.1, 'crate', { target: 'ammo' }); s.targets.push('ammo');
  s.x = choir + 7;
  s.intel.push('Flying buttresses hold the nave walls up. Cut a flyer and the wall leans out.');
}

// ───────────────────────── industry ─────────────────────────

/** refinery: fuel tanks, a cracking column, a brick stack and pipe racks. Tanks chain-explode. */
export function refinery(s: Site, tanks = 3) {
  const g = s.g;
  for (let i = 0; i < tanks; i++) {
    const w = 3.6 + s.R() * 1.4, h = 3 + s.R() * 2;
    s.add(s.x, g, w, h, 'fuel');
    s.push(trap(s.x - 0.1, g + h, w + 0.2, 0.7, 'steel', 1.2, 1.2));
    // pipe rack to the next unit
    if (i < tanks - 1) {
      s.col(s.x + w + 0.4, g, 0.3, 2.6, 'steel', 1.3);
      s.col(s.x + w + 2.0, g, 0.3, 2.6, 'steel', 1.3);
      s.add(s.x + w + 0.2, g + 2.6, 2.3, 0.25, 'steel');
    }
    s.x += w + 2.6;
  }
  // cracking column: tall, thin, with platforms (topples spectacularly)
  const cx = s.x;
  for (let i = 0; i < 6; i++) s.add(cx, g + i * 2, 1.4, 2, 'steel');
  s.push(roof(cx - 0.1, g + 12, 1.6, 1, 'steel'));
  s.x += 3;
  // control house (command) and pump shed (ammo = solvent store)
  const f = s.frame('control', s.x, g, 2, 2, 3.2, 2.6, 0.7, () => ({ col: 'concrete', slab: 'concrete', back: 'concrete' }));
  s.place('control', 'command', (r) => r.find((q) => q.floor === 1));
  s.place('control', 'workshop');
  s.x = f.x1 + 2;
  // brick chimney stack
  for (let i = 0; i < 8; i++) s.add(s.x, g + i * 1.8, 1.5 - i * 0.06, 1.8, 'stone');
  s.x += 3.5;
  s.intel.push('Fuel tanks explode when breached and set each other off.');
}

/** airship hangar: a steel arch shell over a moored airship */
export function hangar(s: Site) {
  const x = s.x, g = s.g;
  // a semicircular arch needs thickness ≳ 0.11 × radius to stand (Heyman); this one has margin
  const r = 6.5;
  s.add(x, g, 1.1, 2.2, 'concrete'); s.add(x + 2 * r - 1.1, g, 1.1, 2.2, 'concrete');
  for (const v of arch(x + r, g + 2.2, r - 1.1, r, 9, 'concrete')) s.push(v);
  // the airship (a gasbag: flammable), moored on trestles
  // a cigar-shaped envelope, flat along its keel where it rests on the trestles
  const ea = r - 1.7, eb = 1.6, ecx = x + r, ecy = g + 2 + 1.35;
  const env: [number, number][] = [];
  for (let i = 0; i < 16; i++) {
    const a = Math.PI + (i / 16) * Math.PI * 2;
    env.push([ecx + Math.cos(a) * ea, Math.max(g + 2, ecy + Math.sin(a) * eb)]);
  }
  const keel = Math.sqrt(1 - (1.35 / eb) ** 2) * ea;
  s.add(ecx - keel + 0.3, g, 0.5, 2, 'wood'); s.add(ecx + keel - 0.8, g, 0.5, 2, 'wood');
  s.push(polyBlock(env.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 0.05), 'plaster'));
  s.add(x + r - 1.2, g, 2.4, 1.2, 'crate', { target: 'ammo' }); s.targets.push('ammo');
  s.x = x + 2 * r + 3;
  s.intel.push('Hydrogen airship in the hangar. It burns.');
}

/** airship mooring mast on a concrete footing: launches gyrocopters and airships until it falls */
export function mooringMast(s: Site) {
  const x = s.x + 1.5, g = s.g; // clear of neighbouring berms
  s.push(trap(x - 0.6, g, 2.6, 0.8, 'concrete', 0.4, 0.4));
  s.add(x + 0.25, g + 0.8, 0.9, 8, 'wood', { target: 'mast' });
  s.targets.push('mast');
  s.x = x + 4.5;
  s.intel.push('A mooring mast launches gyrocopters and airships at your gun. Flak Burst shells (Proximity Fuzes) bring them down.');
}

/** a barracks block with a pitched roof */
export function barracksBlock(s: Site, kind: TargetKind = 'barracks') {
  const x = s.x, g = s.g;
  const f = s.frame(`b${x}`, x, g, 1, 1, 4.4, 2.4, 0.7, () => ({ col: 'wood', slab: 'wood', back: 'plaster' }), 0.35);
  s.push(roof(x - 0.5, f.top, f.x1 - x + 1, 2, 'tile'));
  s.place(`b${x}`, kind);
  s.x = f.x1 + 2.2;
}

/** motor pool: a low concrete vehicle shed with a fuel tank beside it; sends armoured cars (and light tanks later) at the gun */
export function motorPool(s: Site, tanks = false) {
  const x = s.x + 0.5, g = s.g;
  const f = s.frame(`m${x}`, x, g, 1, 1, 4.6, 2.5, 0.8, () => ({ col: 'concrete', slab: 'concrete', back: 'concrete' }), 0.45);
  s.place(`m${x}`, 'depot');
  s.add(f.x1 + 0.4, g, 1.1, 1.4, 'fuel');
  s.x = f.x1 + 2.6;
  s.intel.push(tanks
    ? 'A motor pool sends armoured cars and light tanks at your gun. Canister and round shot bounce off them: use AP, sticky charges, bunker busters or bombs, and hit a tank\'s sloped glacis from above.'
    : 'A motor pool sends armoured cars at your gun. Canister and round shot bounce off: use AP, direct HE hits, sticky charges, drills or bombs.');
}

// ───────────────────────── composer ─────────────────────────

export interface Composition {
  id: string; name: string; seed: number; difficulty: number; brief: string;
  build: (s: Site) => void;
  objectives?: TargetKind[];
  village?: boolean;
  era?: 'medieval' | 'modern';
  /** muzzle velocity the player is expected to have by this point of the campaign (30 base, 36, 44) */
  gun?: 30 | 36 | 44;
  /** hill height override (default 6 + 0.6 × difficulty) */
  elevation?: number;
}

export function compose(c: Composition): LevelDef {
  let seed = c.seed >>> 0;
  const R = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const s = new Site(R);
  const x0 = 60;
  s.g = c.difficulty >= 3 ? 1.5 : 0.5;
  s.groundTo(x0 - 12, 0); s.groundTo(x0 - 5, s.g);
  s.x = x0;
  c.build(s);
  if (c.difficulty >= 4 && s.targets.includes('barracks')) s.intel.push('Some of the infantry carry big shields that stop canister and round shot from the front. Burst shells over them, drop HE among them, or plunge fire from above.');
  s.groundTo(s.x + 4, s.g); s.groundTo(s.x + 10, 0); s.groundTo(400, 0);
  s.furnish();
  const houses: HouseDef[] = [];
  if (c.village ?? true) { let hx = s.x + 14; for (let i = 0; i < 2; i++) { houses.push({ x: hx, w: 4.2, h: 3.8 }); hx += 6.5; } }
  const d = c.difficulty;
  const objectives = c.objectives ?? (['command', ...(s.targets.includes('ammo') ? ['ammo'] : [])] as TargetKind[]);
  const width = s.x - x0;
  const wind: [number, number] = [-1 - d * 0.5, 1 + d * 0.5];
  // big castles take more rounds: pay for the masonry (and ask for more score, since unspent money scores)
  const mass = s.blocks.length * 5;
  // everything must be in range of the gun the player can have by now: move the gun up if it is not
  const firstX = Math.min(...s.blocks.map((b) => b.x));
  const gunCap = c.gun ?? (d <= 3 ? 30 : d <= 5 ? 36 : 44);
  const cannonX = cannonFor(s.blocks, s.ground, objectives, wind, gunCap, x0 - 32 - d * 2, Math.min(x0 - 16, firstX - 24));
  return concealRooms({
    id: c.id, name: c.name, brief: c.brief,
    // the castle stands on a hill: the gun fires level or upward at it
    elevation: c.elevation ?? 5.4 + d * 0.5, siteX: x0 - 12, gunCap,
    intel: [...new Set(s.intel)],
    budget: Math.round((900 + d * 300 + width * 12 + mass) / 50) * 50,
    wind, parTime: 60 + d * 20 + Math.round(width),
    ground: s.ground, cannonX, blocks: s.blocks, houses, objectives,
    stars: [3000, Math.round((6000 + d * 600 + mass * 0.6) / 100) * 100, Math.round((9000 + d * 900 + mass * 1.2) / 100) * 100], collateralMult: 1,
    backdrops: s.backdrops,
    rooms: s.rooms.map((r) => ({ x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, floorIdx: r.floorIdx, deps: r.deps })),
    era: c.era ?? 'medieval',
    difficulty: d,
  }, c.seed);
}

/** the themed operations */
export const THEMED: Composition[] = [
  { id: 'kurogane', gun: 30, name: 'Kurogane-jō', seed: 41, difficulty: 2, brief: 'A five-tier castle on a fan-sloped stone base. Timber and plaster above the stones.',
    build: (s) => { yagura(s, 'barracks'); yagura(s, 'workshop'); s.x += 2; japaneseCastle(s, 5); } },
  { id: 'saltworks', gun: 30, era: 'modern', name: 'Saltworks Refinery', seed: 37, difficulty: 2, brief: 'A refinery turned strongpoint. The control house directs the garrison; the solvent store is in the hangar.',
    build: (s) => { barracksBlock(s); refinery(s, 3); hangar(s); mooringMast(s); } },
  { id: 'sainte-barbe', gun: 30, elevation: 3.5, name: 'Fort Sainte-Barbe', seed: 53, difficulty: 3, brief: 'A Vauban fort: glacis, ditch, masonry escarp and an earthen rampart with guns on the terreplein.',
    build: (s) => { starFortFront(s, 2); magazine(s); hall(s, 'hall', 'command'); barracksBlock(s); } },
  { id: 'abbey', gun: 36, name: 'St. Aldric\'s Abbey', seed: 61, difficulty: 3, brief: 'A fortified abbey. The command post sits in the nave behind the arcade; the flying buttresses hold it all up.',
    build: (s) => { curtain(s, 6); s.x += 3; abbey(s); barracksBlock(s); } },
  { id: 'greywater', gun: 36, era: 'modern', name: 'Battery Greywater', seed: 83, difficulty: 4, brief: 'Coastal battery: dragon\'s teeth, hedgehogs, Regelbau casemates and an armour-faced command bunker.',
    build: (s) => { dragonsTeeth(s, 3); hedgehogs(s, 2); s.x += 2; casemate(s, 'artillery'); casemate(s, 'artillery'); armoredBunker(s); barracksBlock(s); motorPool(s); casemate(s, 'ammo'); } },
  { id: 'harrowgate', gun: 36, name: 'Harrowgate Castle', seed: 97, difficulty: 4, brief: 'A concentric castle: moat, battered curtains, a twin-towered gatehouse, a gun tower and a tall hoarded keep at the back of the ward.',
    build: (s) => {
      moat(s, 6, 2.5); curtain(s, 7, 2); s.x += 2.5; gatehouse(s); barracksBlock(s); hall(s, 'hall', 'workshop');
      curtain(s, 10, 2.4); s.x += 3; bergfried(s, { floors: 8, gun: 'artillery' });
      towerKeep(s, { floors: 7, cols: 2 });
      s.place('keep', 'command', (r) => r.find((q) => q.floor === 3));
      s.place('keep', 'ammo', (r) => r.find((q) => q.floor === 0));
    } },
  { id: 'zooflak', gun: 36, era: 'modern', name: 'Zoo Flak Tower', seed: 131, difficulty: 5, brief: 'A concrete flak tower with gun tubs at every corner, ringed by casemates.',
    build: (s) => { hedgehogs(s, 3); casemate(s, 'barracks'); motorPool(s, true); mooringMast(s); casemate(s, 'artillery'); s.x += 2; flakTower(s, 7, 4); } },
  // ── great fortresses: outer works to the keep, built tall rather than deep ──
  { id: 'kestrel', gun: 36, elevation: 5.2, name: 'Kestrel Bastille', seed: 211, difficulty: 5,
    brief: 'A concentric castle: moat, battered outer curtain, gatehouse, bailey, a towering inner curtain, a gun bergfried and an eight-storey great keep.',
    build: (s) => {
      moat(s, 7, 3); curtain(s, 9, 2.4); s.x += 3; gatehouse(s); bergfried(s, { floors: 7, gun: 'flak' });
      barracksBlock(s); barracksBlock(s, 'workshop'); mooringMast(s);
      curtain(s, 12, 2.6); s.x += 3; bergfried(s, { floors: 10, gun: 'artillery' });
      towerKeep(s, { floors: 8, cols: 3, tag: 'great' });
      s.place('great', 'command', (r) => r.find((q) => q.floor === 4));
      s.place('great', 'ammo', (r) => r.find((q) => q.floor === 0));
    } },
  { id: 'ironcrown', gun: 44, name: 'Castle Ironcrown', seed: 307, difficulty: 6,
    brief: 'A mountain castle in iron and stone: armoured outer gate, a magazine in the bailey, twin bergfrieds and a nine-storey keep.',
    build: (s) => {
      curtain(s, 9, 2.4, 'stone'); s.x += 3; gatehouse(s); barracksBlock(s); motorPool(s, true); mooringMast(s); magazine(s); bergfried(s, { floors: 8, gun: 'flak' });
      curtain(s, 13, 2.8); s.x += 3; bergfried(s, { floors: 11, gun: 'artillery' });
      towerKeep(s, { floors: 9, cols: 3, tag: 'iron' });
      s.place('iron', 'command', (r) => r.find((q) => q.floor === 5));
      s.place('iron', 'ammo', (r) => r.find((q) => q.floor === 1));
      s.place('iron', 'workshop', (r) => r.find((q) => q.floor === 0));
    } },
  { id: 'warden', gun: 44, era: 'modern', name: 'Wardenhold', seed: 419, difficulty: 7,
    brief: 'A modern fortress line: obstacle belts, casemates under earth, an earth rampart, an armour-faced command bunker and a seven-storey flak tower.',
    build: (s) => {
      // kept short enough that a Cordite-charged gun reaches the flak tower roof
      dragonsTeeth(s, 3); hedgehogs(s, 2); casemate(s, 'artillery'); casemate(s, 'barracks'); motorPool(s, true);
      starFortFront(s, 2, 10); magazine(s); armoredBunker(s); mooringMast(s); flakTower(s, 7);
    } },
  { id: 'blackcitadel', elevation: 8.5, gun: 44, name: 'The Black Citadel', seed: 523, difficulty: 8,
    brief: 'The capital\'s citadel: moat, double curtain, gatehouse, a lesser keep, a thirteen-metre inner curtain, two gun bergfrieds and a ten-storey keep. End the war here.',
    build: (s) => {
      moat(s, 8, 3.5); curtain(s, 10, 2.6); s.x += 2.2; curtain(s, 8, 2.0); s.x += 3; gatehouse(s); bergfried(s, { floors: 8, gun: 'flak' });
      barracksBlock(s); barracksBlock(s, 'workshop'); motorPool(s, true); mooringMast(s); magazine(s); mooringMast(s);
      towerKeep(s, { floors: 6, cols: 2, tag: 'lesser' });
      s.place('lesser', 'command', (r) => r.find((q) => q.floor === 2));
      curtain(s, 14, 3); s.x += 3; bergfried(s, { floors: 12, gun: 'artillery' });
      towerKeep(s, { floors: 10, cols: 3, tag: 'black' });
      s.place('black', 'command', (r) => r.find((q) => q.floor === 6));
      s.place('black', 'ammo', (r) => r.find((q) => q.floor === 0));
    } },
];
