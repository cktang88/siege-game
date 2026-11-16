import type { MatId, TargetKind } from './config';
import { cannonFor, rng } from './fortgen';
import type { BlockDef, HouseDef, LevelDef } from './levels';
import { flare, roof, wedge } from './shapes';

/*
  Grand fortresses for the late campaign: 20–40+ real rooms.

  Every building is a post-and-lintel grid frame. Columns stand on column lines; each room's floor
  slab spans from the centre of one column to the centre of the next, so every column above a slab
  boundary bears on two slabs. Nothing is glued: take out a column and the slabs it carried drop,
  their loads drop onto the floor below, and a keep can come down floor by floor.
*/

export interface GrandSpec {
  id: string;
  name: string;
  seed: number;
  /** 5..8 */
  difficulty: number;
  theme: 'stone' | 'concrete' | 'mixed';
  keeps?: 1 | 2;
  brief?: string;
}

interface Room { x0: number; x1: number; y0: number; y1: number; floor: number; col: number; bldg: string; deps: number[]; mat: MatId }

export function generateGrand(spec: GrandSpec): LevelDef {
  const R = rng(spec.seed);
  const d = spec.difficulty;
  const pick = <T,>(xs: T[]) => xs[Math.floor(R() * xs.length)];
  const blocks: BlockDef[] = [];
  const rooms: Room[] = [];
  const add = (x: number, y: number, w: number, h: number, mat: MatId, extra: Partial<BlockDef> = {}) => {
    blocks.push({ x: +x.toFixed(2), y: +y.toFixed(2), w: +w.toFixed(2), h: +h.toFixed(2), mat, ...extra });
  };

  const heavy: MatId = spec.theme === 'concrete' ? 'concrete' : 'stone';
  const light: MatId = spec.theme === 'concrete' ? 'concrete' : 'wood';
  const SLAB = 0.5;

  /** grid frame; returns its rooms. mats(floor) chooses column/slab materials per storey */
  function frame(bldg: string, x0: number, y0: number, cols: number, floors: number, roomW: number, floorH: number, colW: number,
    mats: (f: number) => { col: MatId; slab: MatId; disguise?: MatId }) {
    const cx = (c: number) => x0 + c * (roomW + colW); // left edge of column c
    let y = y0;
    for (let f = 0; f < floors; f++) {
      const m = mats(f);
      const colIdx: number[][] = [];
      for (let c = 0; c <= cols; c++) {
        const segs = floorH > 2 ? 2 : 1;
        colIdx.push([]);
        for (let s = 0; s < segs; s++) { colIdx[c].push(blocks.length); add(cx(c), y + (s * floorH) / segs, colW, floorH / segs, m.col, m.disguise ? { disguise: m.disguise } : {}); }
      }
      const fy = y;
      y += floorH;
      for (let c = 0; c < cols; c++) {
        const a = c === 0 ? cx(0) - 0.15 : cx(c) + colW / 2;
        const b = c === cols - 1 ? cx(cols) + colW + 0.15 : cx(c + 1) + colW / 2;
        const slabIdx = blocks.length;
        add(a, y, b - a, SLAB, m.slab);
        rooms.push({ x0: cx(c) + colW, x1: cx(c + 1), y0: fy, y1: fy + floorH, floor: f, col: c, bldg, deps: [...colIdx[c], ...colIdx[c + 1], slabIdx], mat: m.col === 'wood' || m.col === 'steel' ? (m.col === 'wood' ? 'wood' : heavy) : m.col });
      }
      y += SLAB;
    }
    return { top: y, x1: cx(cols) + colW };
  }

  function battlements(x0: number, x1: number, y: number, mat: MatId = heavy) {
    for (let x = x0; x + 0.7 <= x1 + 0.01; x += 1.6) add(x, y, 0.7, 0.8, mat);
  }

  /** a solid curtain wall: two leaves of coursed masonry with a walkway and merlons */
  function curtain(x: number, y0: number, h: number, mat: MatId, thick = 2, talus = true) {
    const courses = Math.round(h / 1.2);
    // talus: the battered foot, ~30% of the height at ~70°
    if (talus) blocks.push(wedge(x - h * 0.3 * 0.38, y0, h * 0.3 * 0.38, h * 0.3, mat, 'right'));
    for (let i = 0; i < courses; i++) {
      // stagger the leaves so courses bond
      if (i % 2 === 0) { add(x, y0 + i * 1.2, thick / 2, 1.2, mat); add(x + thick / 2, y0 + i * 1.2, thick / 2, 1.2, mat); }
      else { add(x, y0 + i * 1.2, thick, 1.2, mat); }
    }
    const top = y0 + courses * 1.2;
    // machicolated wall-head: a gallery cantilevered over the face on corbels
    blocks.push(flare(x, top, thick, 0.5, mat, 0.7, 0.2));
    battlements(x - 0.7, x + thick + 0.2, top + 0.5, mat);
    return x + thick;
  }

  const g = 2 + Math.round(R() * 2);
  const x0 = 60;
  let x = x0;

  // ── outer works ──
  if (d >= 6) {
    const h = 6 + Math.round(R() * 2);
    for (let i = 0; i < Math.round(h / 1); i++) add(x - 0.6, g + i, 0.6, 1, 'reactive', { disguise: 'stone' });
  }
  x = curtain(x, g, 7 + Math.round(R() * 3), heavy, 2, d < 6);
  if (d >= 7) { x += 2.2; x = curtain(x, g, 6, 'concrete', 1.6); }
  x += 3;

  // ── gatehouse ──
  const gate = frame('gate', x, g, 2, 3, 3.4, 2.5, 1, (f) => ({ col: f < 2 ? heavy : light, slab: f < 2 ? heavy : light }));
  blocks.push(roof(x - 0.8, gate.top, gate.x1 - x + 1.6, 4.6, 'tile'));
  x = gate.x1 + 3;

  // ── outer bailey: workshops and barracks ──
  const sheds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = `shed${i}`;
    const s = frame(id, x, g, 1, 1, 4.6, 2.3, 0.7, () => ({ col: 'wood', slab: 'wood' }));
    blocks.push(roof(x - 0.5, s.top, s.x1 - x + 1, 2.2, 'tile'));
    sheds.push(id);
    x = s.x1 + 2.2;
  }
  x += 1;

  // ── inner curtain ──
  x = curtain(x, g, 9 + Math.round(R() * 3), heavy, 2.2) + 2.5;

  // ── towers and keep(s) ──
  const towers: { id: string; top: number; x0: number; x1: number }[] = [];
  const tower = (id: string) => {
    const floors = 5 + Math.floor(R() * 3) + (d >= 7 ? 1 : 0);
    const t = frame(id, x, g, 1, floors, 2.8, 2.4, 1, (f) => ({ col: f < 3 ? heavy : pick([heavy, light]), slab: f < 2 ? heavy : light }));
    // timber hoarding round the tower head; the gun sits on it
    blocks.push(flare(x, t.top, t.x1 - x, 0.8, 'wood', 0.6, 0.6));
    towers.push({ id, top: t.top + 0.8, x0: x, x1: t.x1 });
    x = t.x1 + 2;
  };
  const keeps: { id: string; floors: number; cols: number; top: number; x0: number; x1: number }[] = [];
  const keep = (id: string) => {
    const cols = 4 + Math.floor(R() * 2) + (d >= 7 ? 1 : 0);
    const floors = 4 + Math.floor(R() * 2) + (d >= 8 ? 1 : 0);
    const steelCore = d >= 6;
    blocks.push(wedge(x - 1.6, g, 1.6, 3.4, heavy, 'right'));
    const k = frame(id, x, g, cols, floors, 3.8 + R() * 0.6, 2.6, 1.1, (f) => ({
      col: f === 0 && steelCore ? 'steel' : f < 2 ? heavy : f < floors - 1 ? pick([heavy, 'wood']) : 'wood',
      slab: f < 2 ? (spec.theme === 'mixed' ? 'concrete' : heavy) : f < floors - 1 ? pick([heavy, 'wood']) : 'wood',
      disguise: f === 0 && steelCore ? heavy : undefined,
    }));
    blocks.push(wedge(k.x1, g, 1.6, 3.4, heavy, 'left'));
    // hoarding gallery along the keep head, merlons on it
    blocks.push(flare(x, k.top, k.x1 - x, 1.0, 'wood', 0.9, 0.9));
    keeps.push({ id, floors, cols, top: k.top + 1.0, x0: x, x1: k.x1 });
    battlements(x - 0.9, k.x1 + 0.2, k.top + 1.0, 'wood');
    x = k.x1 + 2;
  };
  tower('towerA');
  keep('keep1');
  tower('towerB');
  if ((spec.keeps ?? 1) === 2) { x += 4; keep('keep2'); tower('towerC'); }
  const xEnd = x;

  // ── fill rooms ──
  const used = new Set<Room>();
  const place = (r: Room | undefined, t: TargetKind) => {
    if (!r) return false;
    used.add(r);
    const w = Math.min(2.4, r.x1 - r.x0 - (t === 'ammo' ? 1.3 : 0.5));
    add((r.x0 + r.x1) / 2 - w / 2, r.y0, w, t === 'ammo' ? 1.1 : 1.3, t === 'ammo' ? 'crate' : t === 'command' ? 'stone' : 'wood', { target: t });
    return true;
  };
  const roomsOf = (b: string) => rooms.filter((r) => r.bldg === b && !used.has(r));
  const k1 = keeps[0];
  // command post: a middle storey of the main keep
  const cmdFloor = Math.max(1, Math.floor(k1.floors / 2));
  place(roomsOf(k1.id).find((r) => r.floor === cmdFloor && r.col === Math.floor(k1.cols / 2)), 'command');
  // munitions: deep in the keep's ground floor, sealed in a firebrick vault
  const vault = roomsOf(k1.id).find((r) => r.floor === 0 && r.col === k1.cols - 1)!;
  place(vault, 'ammo');
  // firebrick blast walls either side of the crates
  add(vault.x0 + 0.05, vault.y0, 0.45, 1.6, 'fireproof');
  add(vault.x1 - 0.5, vault.y0, 0.45, 1.6, 'fireproof');
  // a second store in the rear tower or second keep
  const rear = keeps[1] ?? null;
  if (rear) place(roomsOf(rear.id).find((r) => r.floor === 0), 'ammo');
  else place(roomsOf(towers[towers.length - 1].id).find((r) => r.floor === 0), 'ammo');
  if (keeps[1]) place(roomsOf(keeps[1].id).find((r) => r.floor === Math.floor(keeps[1].floors / 2)), 'command');
  // garrison
  place(roomsOf('gate').find((r) => r.floor === 0), 'barracks');
  place(roomsOf(sheds[0])[0], 'barracks');
  place(roomsOf(sheds[1])[0], 'workshop');
  if (d >= 6) place(roomsOf(k1.id).find((r) => r.floor === k1.floors - 1), 'workshop');
  // guns on the towers, flak on the keep roof
  for (const t of towers.slice(0, d >= 7 ? 3 : 2)) add((t.x0 + t.x1) / 2 - 1.1, t.top, 2.2, 1, 'steel', { target: 'artillery' });
  add((k1.x0 + k1.x1) / 2 - 1.3, k1.top + 0.8, 2.6, 1, 'steel', { target: 'flak' });
  // furniture: stores, rubble walls and timber partitions make every room worth reading
  for (const r of rooms) {
    if (used.has(r)) continue;
    const w = r.x1 - r.x0;
    const roll = R();
    if (roll < 0.3) { add(r.x0 + 0.3, r.y0, Math.min(1.4, w - 0.6), 0.9, 'crate'); }
    else if (roll < 0.5) { add(r.x0 + w / 2 - 0.6, r.y0, 1.2, 1.2, heavy); }
    else if (roll < 0.62 && w > 3) { add(r.x0 + 0.2, r.y0, 0.9, 0.8, 'wood'); add(r.x1 - 1.1, r.y0, 0.9, 0.8, 'wood'); }
  }

  const ground: [number, number][] = [[-80, 0], [x0 - 14, 0], [x0 - 6, g], [xEnd + 6, g], [xEnd + 14, 0], [400, 0]];
  const houses: HouseDef[] = [];
  let hx = xEnd + 18;
  for (let i = 0; i < 3; i++) { houses.push({ x: hx, w: 4.2, h: 3.8 }); hx += 6 + R() * 2; }
  const nRooms = rooms.length;
  const objectives: TargetKind[] = ['command', 'ammo'];

  return {
    elevation: 6 + d * 0.5, gunCap: 44,
    id: spec.id, name: spec.name,
    brief: spec.brief ?? `A great fortress of ${nRooms} rooms behind ${d >= 7 ? 'double' : 'a'} curtain wall. Command sits mid-keep; the munitions are spread through the works.`,
    intel: [
      `${nRooms} rooms across ${keeps.length} keep${keeps.length > 1 ? 's' : ''}, ${towers.length} towers, a gatehouse and the bailey.`,
      'Post-and-lintel frames: drop a column and the floors above come down with it.',
      'Upper storeys are timber. Lower storeys are masonry or concrete.',
      ...(d >= 6 ? ['The keep\'s ground-floor columns do not look like ordinary masonry.'] : []),
      `${towers.length} tower guns will range on you. Flak on the keep roof.`,
      'The rear works are only in range of a gun with Cordite Charges. Air power helps.',
    ],
    budget: Math.round((2600 + d * 450 + nRooms * 30) / 100) * 100,
    wind: [-2 - d * 0.4, 2 + d * 0.4],
    parTime: 150 + nRooms * 4,
    ground, cannonX: cannonFor(blocks, ground, objectives, [-2 - d * 0.4, 2 + d * 0.4], 44, x0 - 34, Math.min(x0 - 20, Math.min(...blocks.map((b) => b.x)) - 24)), blocks, houses, objectives,
    stars: [4000, 9000 + d * 600, 14000 + d * 900], collateralMult: 1, difficulty: d,
    backdrops: rooms.map((r) => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 + SLAB * 0.5, mat: r.mat, deps: r.deps })),
  };
}
