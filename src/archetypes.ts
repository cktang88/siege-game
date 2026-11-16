import type { MatId, TargetKind } from './config';
import type { BlockDef, HouseDef, LevelDef } from './levels';
import { arch, beam, flare, roof, trap, wedge } from './shapes';

/*
  Real-structure archetypes for side-view sieges. Proportions follow docs/RESEARCH.md
  (talus/batter, hoardings, Vauban rampart profile, Regelbau casemates, flak towers,
  ishigaki bases and tiered tenshu, flying buttresses, refinery tank farms, airship hangars).
  Everything stands on real support; polygons give the sloped faces that make rounds glance.
*/

type Backdrop = NonNullable<LevelDef['backdrops']>[number];
interface Room { x0: number; x1: number; y0: number; y1: number; floor: number; deps: number[]; tag: string }

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
    mats: (f: number) => { col: MatId; slab: MatId; back?: MatId; disguise?: MatId }, slabH = 0.5) {
    const cx = (c: number) => x0 + c * (roomW + colW);
    let y = y0;
    for (let f = 0; f < floors; f++) {
      const m = mats(f);
      const colIdx: number[][] = [];
      for (let c = 0; c <= cols; c++) colIdx.push(this.col(cx(c), y, colW, floorH, m.col, floorH > 2 ? floorH / 2 : floorH, m.disguise ? { disguise: m.disguise } : {}));
      const fy = y;
      y += floorH;
      for (let c = 0; c < cols; c++) {
        const a = c === 0 ? cx(0) - 0.15 : cx(c) + colW / 2;
        const b = c === cols - 1 ? cx(cols) + colW + 0.15 : cx(c + 1) + colW / 2;
        const slab = this.add(a, y, b - a, slabH, m.slab);
        const deps = [...colIdx[c], ...colIdx[c + 1], slab];
        this.rooms.push({ x0: cx(c) + colW, x1: cx(c + 1), y0: fy, y1: fy + floorH, floor: f, deps, tag });
        this.backdrops.push({ x: cx(c) + colW, y: fy, w: roomW, h: floorH + slabH * 0.5, mat: m.back ?? (m.col === 'steel' ? 'concrete' : m.col), deps });
      }
      y += slabH;
    }
    return { top: y, x1: cx(cols) + colW };
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
  const x = s.x, g = s.g;
  // talus: bottom ~30% of the wall flares out at ~70°
  const th = h * 0.3;
  s.push(wedge(x - th * 0.38, g, th * 0.38, th, mat, 'right'));
  const courses = Math.round(h / 1.2);
  for (let i = 0; i < courses; i++) {
    if (i % 2 === 0) { s.add(x, g + i * 1.2, thick / 2, 1.2, mat); s.add(x + thick / 2, g + i * 1.2, thick / 2, 1.2, mat); }
    else s.add(x, g + i * 1.2, thick, 1.2, mat);
  }
  const top = g + courses * 1.2;
  // machicolation: a stone gallery cantilevered on corbels, merlons on top
  s.push(flare(x, top, thick, 0.5, mat, 0.7, 0.2));
  s.battlements(x - 0.7, x + thick + 0.2, top + 0.5, mat);
  s.x = x + thick;
  return top;
}

/** tower keep: battered base, rooms, timber hoarding at the wall head, steep conical roof */
export function towerKeep(s: Site, opts: { floors?: number; w?: number; roofMat?: MatId; hoarding?: boolean; tag?: string } = {}) {
  const R = s.R, g = s.g, x = s.x;
  const floors = opts.floors ?? 3 + Math.floor(R() * 2);
  const w = opts.w ?? 9 + Math.round(R() * 3);
  const tag = opts.tag ?? 'keep';
  const roomW = (w - 1.2 * 3) / 2;
  s.push(wedge(x - 1.4, g, 1.4, 3, 'stone', 'right'), wedge(x + w, g, 1.4, 3, 'stone', 'left'));
  const f = s.frame(tag, x, g, 2, floors, roomW, 2.6, 1.2, (k) => ({ col: k < floors - 1 ? 'stone' : 'wood', slab: k < 1 ? 'stone' : 'wood', back: 'stone' }));
  let top = f.top;
  if (opts.hoarding ?? true) {
    s.push(flare(x, top, w, 1.1, 'wood', 1.0, 1.0));
    top += 1.1;
  }
  s.push(roof(x - 1.2, top, w + 2.4, (w + 2.4) * 0.75, opts.roofMat ?? 'tile'));
  s.x = f.x1 + 2.4;
  return { x0: x, x1: f.x1, top };
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
export function starFortFront(s: Site, guns = 2) {
  const g = s.g;
  let x = s.x;
  // glacis: a long gentle earth slope (part of the terrain) rising to the covered way
  const crest = g + 2.2;
  s.groundTo(x, g); s.groundTo(x + 16, crest);
  x += 16;
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
  const rw = 9;
  // rampart core: big rammed-earth blocks
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) s.add(rx + i * (rw / 3), floor + j * ((top - floor) / 2), rw / 3, (top - floor) / 2, 'earth');
  s.groundTo(rx + rw, floor); s.groundTo(rx + rw + 0.01, g + 0.5);
  // parapet: earth wedge whose top falls outward at ~1/6, banquette step behind
  s.push(trap(rx, top, 4, 1.8, 'earth', 0.4, 2.2));
  s.add(rx + 4.2, top, 1.2, 0.5, 'earth');
  // guns on the terreplein behind the parapet
  for (let k = 0; k < guns; k++) s.roofGun(rx + 5.6 + k * 2.4, top, 'artillery');
  s.x = rx + rw + 2;
  s.g = g + 0.5;
  s.intel.push('Earthen ramparts soak up high explosive. Drills, bunker busters and plunging fire do better.');
}

/** bombproof magazine: a masonry barrel vault buried under earth */
export function magazine(s: Site) {
  const x = s.x, g = s.g;
  s.add(x, g, 1.2, 2.2, 'stone');
  s.add(x + 5.2, g, 1.2, 2.2, 'stone');
  for (const v of arch(x + 3.2, g + 2.2, 2, 3.0, 7, 'stone')) s.push(v);
  s.add(x + 2.2, g, 2, 1.1, 'crate', { target: 'ammo' });
  s.targets.push('ammo');
  // earth berms banked against the vault walls
  s.push(wedge(x - 2.5, g, 2.5, 2.2, 'earth', 'right'), wedge(x + 6.4, g, 2.5, 2.2, 'earth', 'left'));
  s.x = x + 11;
}

// ───────────────────────── 20th century ─────────────────────────

/** Regelbau-style casemate: 2 m concrete, sloped front, earth piled on the flanks, gun inside */
export function casemate(s: Site, target: TargetKind = 'artillery') {
  const x = s.x + 3, g = s.g; // room for the front berm
  s.push(wedge(x - 3, g, 3, 2.6, 'earth', 'right'));
  s.push(trap(x, g, 2.2, 3.2, 'concrete', 1.4, 0)); // sloped face toward the attacker
  s.add(x + 2.2, g, 3.6, 0.6, 'concrete');
  s.add(x + 3.0, g + 0.6, 2.2, 1.2, 'steel', { target }); s.targets.push(target);
  s.add(x + 5.8, g, 1.8, 3.2, 'concrete');
  s.push(trap(x + 0.8, g + 3.2, 6.8, 1.6, 'concrete', 1.2, 0.3)); // thick roof, chamfered to the front
  s.push(wedge(x + 7.6, g, 3, 3.4, 'earth', 'left'));
  s.x = x + 11;
}

/** sloped steel glacis plates leaning against a concrete command bunker: shells glance off */
export function armoredBunker(s: Site) {
  const x = s.x, g = s.g;
  s.add(x - 0.7, g, 0.5, 0.6, 'concrete'); // toe block stops the plate sliding
  s.push(beam(x, g + 0.4, x + 2.0, g + 4.0, 0.5, 'steel'));
  const f = s.frame('bunker', x + 2.3, g, 2, 1, 2.8, 2.8, 1.4, () => ({ col: 'concrete', slab: 'concrete', back: 'concrete' }), 1.2);
  s.place('bunker', 'command', (r) => r[r.length - 1]);
  s.push(trap(x + 2.0, f.top, f.x1 - x - 1.7, 1.2, 'steel', 1.6, 0.4));
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
export function flakTower(s: Site, floors = 4) {
  const x = s.x, g = s.g;
  const f = s.frame('flak', x, g, 3, floors, 3.2, 2.8, 2, () => ({ col: 'concrete', slab: 'concrete', back: 'concrete' }), 0.9);
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
  const baseW = 20;
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
    const f = s.frame(`tenshu${t}`, tx, y, cols, 1, roomW, 2.6, colW, () => ({ col: 'wood', slab: 'wood', back: 'plaster' }), 0.35);
    // flared tile eaves: the next tier stands on top of them
    const eave = t === tiers - 1 ? 0 : 0.9;
    if (t < tiers - 1) {
      s.push(flare(tx, f.top, w, 0.7, 'tile', eave, eave));
      y = f.top + 0.7;
      const nw = Math.max(4.2, w - 3.2);
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
  const bt = s.frame('belltower', x, g, 1, 4, 2.6, 2.6, 0.9, () => ({ col: 'stone', slab: 'wood', back: 'stone' }));
  s.push(roof(x - 0.3, bt.top, bt.x1 - x + 0.6, 7, 'tile'));
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
  s.add(x + 3, g, 0.5, 2, 'wood'); s.add(x + 2 * r - 3.5, g, 0.5, 2, 'wood');
  s.push(trap(x + 1.6, g + 2, 2 * r - 3.2, 2.6, 'plaster', 1.2, 1.2));
  s.add(x + r - 1.2, g, 2.4, 1.2, 'crate', { target: 'ammo' }); s.targets.push('ammo');
  s.x = x + 2 * r + 3;
  s.intel.push('Hydrogen airship in the hangar. It burns.');
}

/** a barracks block with a pitched roof */
export function barracksBlock(s: Site, kind: TargetKind = 'barracks') {
  const x = s.x, g = s.g;
  const f = s.frame(`b${x}`, x, g, 1, 1, 4.4, 2.4, 0.7, () => ({ col: 'wood', slab: 'wood', back: 'plaster' }), 0.35);
  s.push(roof(x - 0.5, f.top, f.x1 - x + 1, 2, 'tile'));
  s.place(`b${x}`, kind);
  s.x = f.x1 + 2.2;
}

// ───────────────────────── composer ─────────────────────────

export interface Composition {
  id: string; name: string; seed: number; difficulty: number; brief: string;
  build: (s: Site) => void;
  objectives?: TargetKind[];
  village?: boolean;
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
  s.groundTo(s.x + 4, s.g); s.groundTo(s.x + 10, 0); s.groundTo(400, 0);
  s.furnish();
  const houses: HouseDef[] = [];
  if (c.village ?? true) { let hx = s.x + 14; for (let i = 0; i < 2; i++) { houses.push({ x: hx, w: 4.2, h: 3.8 }); hx += 6.5; } }
  const d = c.difficulty;
  const objectives = c.objectives ?? (['command', ...(s.targets.includes('ammo') ? ['ammo'] : [])] as TargetKind[]);
  const width = s.x - x0;
  return {
    id: c.id, name: c.name, brief: c.brief,
    intel: [...new Set(s.intel)],
    budget: Math.round((900 + d * 300 + width * 12) / 50) * 50,
    wind: [-1 - d * 0.5, 1 + d * 0.5], parTime: 60 + d * 20 + Math.round(width),
    ground: s.ground, cannonX: x0 - 32 - d * 2, blocks: s.blocks, houses, objectives,
    stars: [3000, 6000 + d * 600, 9000 + d * 900], collateralMult: 1,
    backdrops: s.backdrops,
  };
}

/** the themed operations */
export const THEMED: Composition[] = [
  { id: 'kurogane', name: 'Kurogane-jō', seed: 41, difficulty: 2, brief: 'A five-tier castle on a fan-sloped stone base. Timber and plaster above the stones.',
    build: (s) => { yagura(s, 'barracks'); s.x += 2; japaneseCastle(s, 4); yagura(s, 'workshop'); } },
  { id: 'saltworks', name: 'Saltworks Refinery', seed: 37, difficulty: 2, brief: 'A refinery turned strongpoint. The control house directs the garrison; the solvent store is in the hangar.',
    build: (s) => { barracksBlock(s); refinery(s, 3); hangar(s); } },
  { id: 'sainte-barbe', name: 'Fort Sainte-Barbe', seed: 53, difficulty: 3, brief: 'A Vauban fort: glacis, ditch, masonry escarp and an earthen rampart with guns on the terreplein.',
    build: (s) => { starFortFront(s, 2); magazine(s); hall(s, 'hall', 'command'); barracksBlock(s); } },
  { id: 'abbey', name: 'St. Aldric\'s Abbey', seed: 61, difficulty: 3, brief: 'A fortified abbey. The command post sits in the nave behind the arcade; the flying buttresses hold it all up.',
    build: (s) => { curtain(s, 6); s.x += 3; abbey(s); barracksBlock(s); } },
  { id: 'greywater', name: 'Battery Greywater', seed: 83, difficulty: 4, brief: 'Coastal battery: dragon\'s teeth, hedgehogs, Regelbau casemates and an armour-faced command bunker.',
    build: (s) => { dragonsTeeth(s, 3); hedgehogs(s, 2); s.x += 2; casemate(s, 'artillery'); casemate(s, 'artillery'); armoredBunker(s); barracksBlock(s); casemate(s, 'ammo'); } },
  { id: 'harrowgate', name: 'Harrowgate Castle', seed: 97, difficulty: 4, brief: 'A concentric castle with a moat, a battered curtain, a twin-towered gatehouse and a great tower keep.',
    build: (s) => { moat(s, 6, 2.5); curtain(s, 6, 2); s.x += 2.5; gatehouse(s); barracksBlock(s); curtain(s, 8, 2.4); s.x += 2.5; const k = towerKeep(s, { floors: 4, w: 11 }); s.place('keep', 'command', (r) => r.find((q) => q.floor === 2)); s.place('keep', 'ammo', (r) => r.find((q) => q.floor === 0)); s.roofGun((k.x0 + k.x1) / 2, k.top, 'artillery'); hall(s, 'hall2', 'workshop'); } },
  { id: 'zooflak', name: 'Zoo Flak Tower', seed: 131, difficulty: 5, brief: 'A concrete flak tower with gun tubs at every corner, ringed by casemates.',
    build: (s) => { hedgehogs(s, 3); casemate(s, 'barracks'); s.x += 2; flakTower(s, 5); casemate(s, 'artillery'); } },
];
