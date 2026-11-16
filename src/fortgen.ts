import type { MatId, TargetKind } from './config';
import type { BlockDef, HouseDef, LevelDef } from './levels';

/** small deterministic RNG (mulberry32) so a castle is the same every time it is played */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where to put the player's gun so every target is in range of a gun with muzzle velocity `vCap`
 * (30 m/s base, 36 and 44 with research) against the strongest headwind the level can roll.
 * Objectives get a 5% margin, other targets 1%. The gun starts at `far` and only moves up toward the
 * castle, never closer than `near`. Ballistics: v² = g·(dy + √(dx²+dy²)) for the best elevation, plus ~1.2% per m/s of headwind.
 */
export function cannonFor(blocks: BlockDef[], ground: [number, number][], objectives: TargetKind[], wind: [number, number], vCap: number, far: number, near: number) {
  const gY = (x: number) => {
    if (x <= ground[0][0]) return ground[0][1];
    for (let i = 1; i < ground.length; i++) if (x <= ground[i][0]) { const t = (x - ground[i - 1][0]) / (ground[i][0] - ground[i - 1][0] || 1); return ground[i - 1][1] + (ground[i][1] - ground[i - 1][1]) * t; }
    return ground[ground.length - 1][1];
  };
  const wf = 1 + 0.012 * Math.max(Math.abs(wind[0]), Math.abs(wind[1]));
  const worst = (cx: number) => {
    const ox = cx + 0.15, oy = gY(cx) + 2.35;
    let r = 0;
    for (const b of blocks) {
      if (!b.target) continue;
      const dx = b.x + b.w / 2 - ox, dy = b.y + b.h / 2 - oy;
      const v = Math.sqrt(-PHYS_G * (dy + Math.hypot(dx, dy))) * wf;
      r = Math.max(r, v / (objectives.includes(b.target) ? 0.95 : 0.99));
    }
    return r;
  };
  let x = far;
  while (x < near && worst(x) > vCap) x += 0.5;
  return Math.min(near, x);
}
const PHYS_G = -9.81;

export type Theme ='timber' | 'stone' | 'concrete' | 'mixed';

export interface GenSpec {
  id: string;
  name: string;
  seed: number;
  theme: Theme;
  /** 1 (easy) .. 5 (hard) */
  difficulty: number;
  brief?: string;
  objectives?: TargetKind[];
  village?: boolean;
}

/**
 * Builds a fortress out of stable modules laid side by side on a plateau.
 * Every span is a single slab resting on two columns, so a structure stands until its
 * load-bearing columns are taken out (the same "real support" rule as the hand-made levels).
 */
export function generateLevel(spec: GenSpec): LevelDef {
  const R = rng(spec.seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(R() * xs.length)];
  const d = spec.difficulty;
  const blocks: BlockDef[] = [];
  const add = (x: number, y: number, w: number, h: number, mat: MatId, extra: Partial<BlockDef> = {}) => {
    blocks.push({ x: +x.toFixed(2), y: +y.toFixed(2), w, h, mat, ...extra });
    return y + h;
  };
  const col = (x: number, y: number, w: number, h: number, mat: MatId, seg = 1.2, extra: Partial<BlockDef> = {}) => {
    const n = Math.max(1, Math.round(h / seg));
    for (let i = 0; i < n; i++) add(x, y + (i * h) / n, w, h / n, mat, extra);
    return y + h;
  };

  const mats: Record<Theme, { wall: MatId[]; col: MatId[]; slab: MatId[] }> = {
    timber: { wall: ['wood', 'wood', 'stone'], col: ['wood'], slab: ['wood'] },
    stone: { wall: ['stone'], col: ['stone', 'wood'], slab: ['wood', 'stone'] },
    concrete: { wall: ['concrete', 'stone'], col: ['concrete'], slab: ['concrete'] },
    mixed: { wall: ['stone', 'concrete', 'wood'], col: ['stone', 'wood', 'concrete'], slab: ['wood', 'concrete'] },
  };
  const M = mats[spec.theme];

  const g = d >= 3 ? 1 + Math.round(R() * 3) : Math.round(R() * 2);
  const x0 = 58 + Math.round(R() * 6);

  // which targets: command always; others scale with difficulty
  const pool: TargetKind[] = ['ammo', 'barracks', 'artillery', 'workshop', 'flak'];
  const extras: TargetKind[] = [];
  const nExtra = Math.min(pool.length, 1 + Math.floor(d * 0.9));
  while (extras.length < nExtra) {
    const t = pick(pool);
    if (!extras.includes(t)) extras.push(t);
  }
  if (d <= 1) extras.splice(extras.indexOf('artillery') >= 0 ? extras.indexOf('artillery') : extras.length, 1);
  const targets: TargetKind[] = ['command', ...extras];

  let x = x0;
  // front defences
  if (d >= 2 || R() < 0.5) {
    const h = 3 + Math.round(R() * (1 + d));
    if (d >= 3 && R() < 0.6) {
      col(x, g, 0.6, Math.min(h, 4), 'reactive', 1, { disguise: 'stone' });
      x += 0.6;
    }
    col(x, g, 1, h, pick(M.wall), 1.2);
    x += 1;
    if (d >= 4 && R() < 0.6) { x += 1.8; col(x, g, 1, h - 1, 'concrete', 1.25); x += 1; }
    x += 2 + R() * 2;
  }

  const kinds = ['tower', 'hall', 'bunker', 'vault', 'shed'] as const;
  const placed: TargetKind[] = [];
  for (const t of targets) {
    let kind: (typeof kinds)[number] =
      t === 'command' ? (spec.theme === 'concrete' || d >= 4 ? 'bunker' : pick(['tower', 'hall'] as const)) :
      t === 'ammo' ? (d >= 3 && R() < 0.6 ? 'vault' : 'shed') :
      t === 'artillery' || t === 'flak' ? 'tower' :
      t === 'workshop' || t === 'barracks' ? pick(['shed', 'hall'] as const) : 'shed';
    if (t === 'artillery' && R() < 0.4) kind = 'bunker';
    const w = kind === 'hall' ? 6 + Math.round(R() * 2) : kind === 'shed' ? 4.4 + R() : kind === 'vault' ? 5.6 : kind === 'bunker' ? 6.4 : 4.2;
    const cw = kind === 'shed' ? 0.6 : 0.9;
    const cm: MatId = kind === 'bunker' ? 'concrete' : kind === 'vault' ? 'fireproof' : pick(M.col);
    const sm: MatId = kind === 'bunker' ? (d >= 4 ? 'steel' : 'concrete') : kind === 'vault' ? 'fireproof' : pick(M.slab);
    const fh = 2.4;
    const floors = kind === 'tower' ? 2 + Math.floor(R() * Math.min(3, d)) : 1;
    let y = g;
    for (let f = 0; f < floors; f++) {
      col(x, y, cw, fh, cm, 1.2);
      col(x + w - cw, y, cw, fh, cm, 1.2);
      const isTop = f === floors - 1;
      // the target lives on the ground floor, except guns which sit on the roof
      if (f === 0 && t !== 'artillery' && t !== 'flak') {
        const tw = Math.min(2.4, w - cw * 2 - 0.6);
        add(x + w / 2 - tw / 2, y, tw, t === 'ammo' ? 1.1 : 1.3, t === 'ammo' ? 'crate' : t === 'command' ? 'stone' : 'wood', { target: t });
      } else if (R() < 0.5) {
        add(x + w / 2 - 0.7, y, 1.4, 0.9, R() < 0.3 ? 'crate' : pick(M.wall));
      }
      y += fh;
      add(x - 0.2, y, w + 0.4, kind === 'bunker' ? 0.8 : 0.45, sm);
      y += kind === 'bunker' ? 0.8 : 0.45;
      if (isTop) {
        if (t === 'artillery' || t === 'flak') add(x + w / 2 - 1.1, y, 2.2, 1, 'steel', { target: t });
        else { add(x, y, 0.7, 0.7, pick(M.wall)); add(x + w - 0.7, y, 0.7, 0.7, pick(M.wall)); }
      }
    }
    placed.push(t);
    x += w + 1.2 + R() * 2.5;
  }
  const xEnd = x;

  const plateau = g > 0;
  const ground: [number, number][] = plateau
    ? [[-80, 0], [x0 - 10, 0], [x0 - 4, g], [xEnd + 4, g], [xEnd + 10, 0], [260, 0]]
    : [[-80, 0], [260, 0]];

  const houses: HouseDef[] = [];
  if (spec.village ?? R() < 0.7) {
    let hx = xEnd + (plateau ? 13 : 4);
    for (let i = 0; i < 2 + Math.floor(R() * 2); i++) { houses.push({ x: hx, w: 4.2, h: 3.8 }); hx += 5.5 + R() * 2; }
  }

  const objectives = spec.objectives ?? (d >= 3 ? ['command', placed.includes('ammo') ? 'ammo' : placed[1]].filter(Boolean) as TargetKind[] : ['command']);
  const width = xEnd - x0;
  const budget = Math.round((700 + d * 230 + width * 8) / 50) * 50;
  const cannonX = Math.max(10, x0 - 32 - d * 3);
  const themeText: Record<Theme, string> = {
    timber: 'Timber-framed works. Fire will travel.',
    stone: 'Old masonry. Brittle under blast, heavy when it falls.',
    concrete: 'Poured concrete. HE alone will not do it.',
    mixed: 'A patchwork of materials, repaired many times.',
  };
  const intel = [themeText[spec.theme]];
  if (placed.includes('artillery')) intel.push('A counter-battery gun will range on your position.');
  if (placed.includes('flak')) intel.push('Flak on site: air support will be contested.');
  if (placed.includes('workshop')) intel.push('Engineers will repair what you do not finish.');
  if (blocks.some((b) => b.disguise)) intel.push('Scouts report something odd about the front wall.');
  if (houses.length) intel.push('Civilians nearby.');

  return {
    elevation: 5.5 + d * 0.6, gunCap: d <= 3 ? 30 : d <= 5 ? 36 : 44,
    id: spec.id, name: spec.name,
    brief: spec.brief ?? `A ${spec.theme} stronghold. Destroy the ${objectives.map((o) => (o === 'command' ? 'command post' : o)).join(' and ')}.`,
    intel, budget, wind: [-1 - d * 0.6, 1 + d * 0.6], parTime: 50 + d * 20,
    ground, cannonX, blocks, houses, objectives,
    stars: [3000, 5500 + d * 500, 8000 + d * 800], collateralMult: 1,
  };
}
