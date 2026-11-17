import type { BlockDef, LevelDef } from './levels';
import { rng } from './fortgen';

/*
  Concealed rooms. From the middle of the campaign some rooms are walled over: the cutaway shows the
  surrounding masonry (or timber, or concrete) instead of the room, so its people, furniture and any
  target inside cannot be seen. The cover comes off when a scout drone flies over, when the room is
  broken open (a block of its frame destroyed, a blast inside it) or when fire starts in it.
  Which rooms are hidden is fixed by the level seed, so a castle is the same every time it is played.
*/

/** share of rooms walled over at a difficulty: none on the border, a quarter mid-campaign, ~40% late */
export function concealShare(difficulty: number) {
  return difficulty <= 1 ? 0 : difficulty <= 4 ? 0.25 : 0.4;
}

/** a target block standing in the room */
export function roomTarget(blocks: BlockDef[], r: { x0: number; x1: number; y0: number }) {
  return blocks.find((b) => b.target && b.x >= r.x0 - 0.05 && b.x < r.x1 && Math.abs(b.y - r.y0) < 0.1);
}

/** mark a deterministic share of the level's rooms hidden (objective rooms are a little likelier) */
export function concealRooms(level: LevelDef, seed: number): LevelDef {
  const rooms = level.rooms;
  if (!rooms?.length) return level;
  const share = concealShare(level.difficulty ?? 1);
  const n = Math.round(rooms.length * share);
  for (const r of rooms) delete r.hidden;
  if (!n) return level;
  const R = rng((seed * 7919 + 104729) >>> 0);
  const keyed = rooms.map((r) => ({ r, k: R() * (roomTarget(level.blocks, r) ? 0.55 : 1) * (r.x1 - r.x0 < 1.4 ? 3 : 1) }));
  keyed.sort((a, b) => a.k - b.k);
  for (const { r } of keyed.slice(0, n)) r.hidden = true;
  const note = `${n} of the ${rooms.length} rooms are walled up. A scout drone sees into them; a breach or a fire opens them.`;
  if (!level.intel.includes(note)) level.intel.push(note);
  return level;
}
