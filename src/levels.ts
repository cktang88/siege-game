import type { MatId, TargetKind } from './config';

export interface BlockDef {
  x: number; // bottom-left
  y: number;
  w: number;
  h: number;
  mat: MatId;
  target?: TargetKind;
  /** looks like this material until scouted */
  disguise?: MatId;
  /** convex outline (CCW), in metres from the bbox bottom-left; omitted = rectangle */
  poly?: [number, number][];
}

export interface HouseDef { x: number; w: number; h: number }

export interface LevelDef {
  id: string;
  name: string;
  brief: string;
  intel: string[];
  budget: number;
  wind: [number, number];
  parTime: number;
  ground: [number, number][];
  cannonX: number;
  blocks: BlockDef[];
  houses: HouseDef[];
  objectives: TargetKind[];
  /** score thresholds for 1, 2, 3 stars */
  stars: [number, number, number];
  collateralMult: number;
  /** non-colliding interior back walls (cutaway view); each disappears when any block in deps fails */
  backdrops?: { x: number; y: number; w: number; h: number; mat: MatId; deps: number[] }[];
  /** rooms for the garrison: interior bounds, the floor block under it (-1 = ground) and its frame */
  rooms?: { x0: number; x1: number; y0: number; y1: number; floorIdx: number; deps: number[] }[];
  era?: 'medieval' | 'modern';
  /** castle sits on a hill this many metres above the plain (applied at load: src/elevate.ts) */
  elevation?: number;
  /** x where the castle's own terrain begins (the hill crest starts here) */
  siteX?: number;
  /** muzzle velocity the player is expected to have here (for keeping objectives in range) */
  gunCap?: number;
  /** 1 (border) .. 8 (capital): later levels field shield infantry and heavier vehicles */
  difficulty?: number;
}

class Builder {
  blocks: BlockDef[] = [];
  add(x: number, y: number, w: number, h: number, mat: MatId, extra: Partial<BlockDef> = {}) {
    this.blocks.push({ x, y, w, h, mat, ...extra });
    return y + h;
  }
  /** stacked column of segments */
  col(x: number, y: number, w: number, h: number, mat: MatId, seg = 1.2, extra: Partial<BlockDef> = {}) {
    const n = Math.max(1, Math.round(h / seg));
    const s = h / n;
    for (let i = 0; i < n; i++) this.add(x, y + i * s, w, s, mat, extra);
    return y + h;
  }
  /** horizontal row of equal blocks */
  row(x0: number, x1: number, y: number, h: number, mat: MatId, seg = 2, extra: Partial<BlockDef> = {}) {
    const n = Math.max(1, Math.round((x1 - x0) / seg));
    const s = (x1 - x0) / n;
    for (let i = 0; i < n; i++) this.add(x0 + i * s, y, s, h, mat, extra);
    return y + h;
  }
  /** brick wall: staggered courses */
  wall(x: number, y: number, w: number, h: number, mat: MatId, course = 1, extra: Partial<BlockDef> = {}) {
    const n = Math.max(1, Math.round(h / course));
    const c = h / n;
    for (let i = 0; i < n; i++) this.add(x, y + i * c, w, c, mat, extra);
    return y + h;
  }
}

// ───────────────────────── Level 1 ─────────────────────────
function outpost(): LevelDef {
  const b = new Builder();
  const g = 0;
  b.row(60, 76, g, 0.6, 'stone', 2);
  const f1 = g + 0.6;
  b.col(60, f1, 1, 2.4, 'stone');
  b.col(65.2, f1, 1, 2.4, 'wood');
  b.col(70, f1, 1, 2.4, 'wood');
  b.col(75, f1, 1, 2.4, 'stone');
  b.add(62, f1, 2.2, 1.4, 'wood', { target: 'barracks' });
  b.add(72.2, f1, 1.6, 1.1, 'crate', { target: 'ammo' });
  b.add(66.8, f1, 1.2, 0.8, 'crate');
  b.add(66.8, f1 + 0.8, 1.2, 0.8, 'crate');
  const r1 = f1 + 2.4;
  b.add(60, r1, 5.7, 0.4, 'wood');
  b.add(65.7, r1, 4.8, 0.4, 'wood');
  b.add(70.5, r1, 5.5, 0.4, 'wood');
  const f2 = r1 + 0.4;
  b.col(62.5, f2, 0.6, 2.2, 'wood', 1.1);
  b.col(68.6, f2, 0.6, 2.2, 'wood', 1.1);
  b.add(64.6, f2, 2, 1.4, 'stone', { target: 'command' });
  const r2 = f2 + 2.2;
  b.add(62.2, r2, 7.3, 0.4, 'wood');
  b.add(62.2, r2 + 0.4, 0.7, 0.7, 'stone');
  b.add(65.5, r2 + 0.4, 0.7, 0.7, 'stone');
  b.add(68.8, r2 + 0.4, 0.7, 0.7, 'stone');
  // lookout on the right
  b.col(73, f2, 0.5, 2.4, 'wood', 1.2);
  b.col(75.3, f2, 0.5, 2.4, 'wood', 1.2);
  b.add(72.8, f2 + 2.4, 3.2, 0.35, 'wood');
  b.add(73.6, f2 + 2.75, 1.4, 0.9, 'stone');
  return {
    id: 'outpost', elevation: 7, gunCap: 30, name: 'Outpost Varn',
    brief: 'A timber-and-stone border outpost. Their command post sits on the upper floor; the munitions store is on the ground floor, right side.',
    intel: ['Mostly timber: incendiaries will spread.', 'Barracks will send infantry toward your gun.', 'Village behind the outpost. Mind your aim.'],
    budget: 900, wind: [-2, 2], parTime: 60,
    ground: [[-80, 0], [200, 0]],
    cannonX: 24, blocks: b.blocks,
    houses: [{ x: 84, w: 4.4, h: 4 }, { x: 90, w: 4, h: 3.6 }, { x: 96, w: 4.4, h: 4 }],
    objectives: ['command', 'ammo'],
    stars: [4000, 7000, 9500], collateralMult: 1,
  };
}

// ───────────────────────── Level 2 ─────────────────────────
function bastion(): LevelDef {
  const b = new Builder();
  const g = 2;
  // reactive armor skirt disguised as masonry, in front of the curtain wall
  b.wall(57.4, g, 0.6, 4, 'reactive', 1, { disguise: 'stone' });
  b.wall(58, g, 1.2, 5, 'stone', 1);
  b.add(58, g + 5, 0.6, 0.6, 'stone');
  // concrete bunker (HQ) with counter-battery gun on the roof
  b.col(62, g, 1, 2.6, 'concrete', 1.3);
  b.col(69, g, 1, 2.6, 'concrete', 1.3);
  b.add(64.5, g, 2.4, 1.4, 'stone', { target: 'command' });
  b.add(61.8, g + 2.6, 8.4, 0.8, 'concrete');
  b.add(64.6, g + 3.4, 2.2, 1, 'steel', { target: 'artillery' });
  b.add(62, g + 3.4, 0.8, 0.9, 'steel');
  b.add(69.2, g + 3.4, 0.8, 0.9, 'steel');
  // engineers' shed
  b.col(72, g, 0.6, 2.2, 'wood', 1.1);
  b.col(77.4, g, 0.6, 2.2, 'wood', 1.1);
  b.add(73.2, g, 3, 1.3, 'wood', { target: 'workshop' });
  b.add(71.8, g + 2.2, 6.4, 0.35, 'wood');
  // rear stone tower with the munitions store at its base
  b.col(80, g, 0.8, 2.2, 'stone', 1.1);
  b.col(83.2, g, 0.8, 2.2, 'stone', 1.1);
  b.add(81.1, g, 1.8, 1, 'crate', { target: 'ammo' });
  b.add(80, g + 2.2, 4, 0.5, 'stone');
  b.col(80, g + 2.7, 0.8, 2.2, 'stone', 1.1);
  b.col(83.2, g + 2.7, 0.8, 2.2, 'stone', 1.1);
  b.add(81, g + 2.7, 2, 1.2, 'wood', { target: 'barracks' });
  b.add(80, g + 4.9, 4, 0.5, 'stone');
  b.add(80, g + 5.4, 0.8, 0.8, 'stone');
  b.add(83.2, g + 5.4, 0.8, 0.8, 'stone');
  return {
    id: 'bastion', elevation: 7, gunCap: 30, name: 'Bastion Kell',
    brief: 'A modern bastion. Command is buried in a concrete bunker topped by a counter-battery gun that will fire on you. Engineers repair anything you damage.',
    intel: ['Concrete laughs at HE: bring bunker busters or go underneath.', 'Front curtain wall may be hiding something. A drone would tell you.', 'The gun bracket-fires: each shot lands closer.'],
    budget: 1300, wind: [-3, 3], parTime: 90,
    ground: [[-80, 0], [46, 0], [54, g], [92, g], [98, 0], [220, 0]],
    cannonX: 20, blocks: b.blocks,
    houses: [{ x: 101, w: 4.4, h: 4 }, { x: 107, w: 4, h: 3.6 }],
    objectives: ['command', 'artillery'],
    stars: [4000, 7500, 10500], collateralMult: 1,
  };
}

// ───────────────────────── Level 3 ─────────────────────────
function citadel(): LevelDef {
  const b = new Builder();
  const g = 3;
  // double wall: masonry outer, concrete inner, with a gap (spaced armor)
  b.wall(58, g, 1, 6, 'stone', 1.2);
  b.add(57.8, g + 6, 1.4, 0.5, 'stone');
  b.wall(61, g, 1, 5, 'concrete', 1.25);
  // barracks hall
  b.col(64, g, 0.6, 2.4, 'wood', 1.2);
  b.col(69.4, g, 0.6, 2.4, 'wood', 1.2);
  b.add(65.4, g, 3, 1.5, 'wood', { target: 'barracks' });
  b.add(63.8, g + 2.4, 6.4, 0.4, 'wood');
  // the keep: steel-cored pillars disguised as masonry
  b.col(72, g, 1, 3.2, 'steel', 1.6, { disguise: 'stone' });
  b.col(83, g, 1, 3.2, 'steel', 1.6, { disguise: 'stone' });
  b.col(77.5, g, 1, 3.2, 'stone', 1.6);
  b.add(74.2, g, 2.2, 1.2, 'crate');
  b.add(79.5, g, 2.2, 1.2, 'crate');
  b.add(71.8, g + 3.2, 6.2, 0.6, 'concrete');
  b.add(78, g + 3.2, 6.2, 0.6, 'concrete');
  const k2 = g + 3.8;
  b.col(72.5, k2, 0.8, 2.6, 'stone', 1.3);
  b.col(82.7, k2, 0.8, 2.6, 'stone', 1.3);
  b.add(76.4, k2, 2.4, 1.5, 'stone', { target: 'command' });
  b.add(72.3, k2 + 2.6, 11.2, 0.6, 'concrete');
  b.add(76.3, k2 + 3.2, 2.4, 1, 'steel', { target: 'artillery' });
  b.add(72.3, k2 + 3.2, 0.8, 0.8, 'stone');
  b.add(82.5, k2 + 3.2, 0.8, 0.8, 'stone');
  // munitions in a firebrick vault
  b.col(87, g, 0.8, 2.4, 'fireproof', 1.2);
  b.col(94.2, g, 0.8, 2.4, 'fireproof', 1.2);
  b.add(88.6, g, 1.8, 1.2, 'crate', { target: 'ammo' });
  b.add(90.6, g, 1.8, 1.2, 'crate', { target: 'ammo' });
  b.add(86.8, g + 2.4, 8.4, 0.5, 'fireproof');
  b.add(89.4, g + 2.9, 2.6, 1, 'steel', { target: 'flak' });
  // workshop
  b.col(98, g, 0.6, 2.2, 'wood', 1.1);
  b.col(102.4, g, 0.6, 2.2, 'wood', 1.1);
  b.add(99, g, 2.8, 1.3, 'wood', { target: 'workshop' });
  b.add(97.8, g + 2.2, 5.4, 0.35, 'wood');
  return {
    id: 'citadel', elevation: 8, gunCap: 36, name: 'Citadel Ostrava',
    brief: 'A layered citadel. Double walls, a keep with a counter-battery gun, munitions sealed in a firebrick vault with flak on its roof.',
    intel: ['Outer masonry + inner concrete: blasts spend themselves on the first wall.', 'Firebrick vault: incendiaries are useless there.', 'Flak will shoot down bombers. Kill it before calling an air strike.', 'Something about the keep pillars looks off.'],
    budget: 1800, wind: [-4, 4], parTime: 130,
    ground: [[-80, 0], [48, 0], [56, g], [106, g], [112, 0], [220, 0]],
    cannonX: 28, blocks: b.blocks,
    houses: [{ x: 114, w: 4.4, h: 4 }, { x: 120, w: 4, h: 3.6 }, { x: 44, w: 4, h: 3.6 }],
    objectives: ['command', 'ammo'],
    stars: [4000, 8000, 11500], collateralMult: 1,
  };
}

// ───────────────────────── Level 4 ─────────────────────────
function cleanCut(): LevelDef {
  const b = new Builder();
  const g = 0;
  b.col(64, g, 0.8, 2.6, 'concrete', 1.3);
  b.col(69.2, g, 0.8, 2.6, 'concrete', 1.3);
  b.add(65.8, g, 2.4, 1.3, 'stone', { target: 'command' });
  b.add(63.8, g + 2.6, 6.4, 0.6, 'steel');
  b.add(65.2, g + 3.2, 3.6, 0.5, 'concrete');
  b.add(62.6, g, 1.4, 1, 'wood', { target: 'barracks' });
  return {
    id: 'cleancut', elevation: 6.5, gunCap: 30, name: 'Clean Cut',
    brief: 'A command bunker hidden in an occupied village. Take out the HQ and nothing else. Collateral damage counts triple.',
    intel: ['Steel roof: air strikes will bounce off.', 'Houses on both sides. One bad shot costs more than it gains.', 'A small guard post sends troops.'],
    budget: 1000, wind: [-2.5, 2.5], parTime: 50,
    ground: [[-80, 0], [220, 0]],
    cannonX: 26, blocks: b.blocks,
    houses: [{ x: 52, w: 4.4, h: 4 }, { x: 57.5, w: 4, h: 3.6 }, { x: 72, w: 4.4, h: 4 }, { x: 77.5, w: 4, h: 3.6 }],
    objectives: ['command'],
    stars: [3000, 6000, 8500], collateralMult: 3,
  };
}

export const LEVELS: LevelDef[] = [outpost(), bastion(), citadel(), cleanCut()];
