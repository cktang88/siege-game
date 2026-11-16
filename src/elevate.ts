import { cannonFor } from './fortgen';
import type { LevelDef } from './levels';

/*
  Castles command the ground. A level with an `elevation` is lifted onto a hill at load time:
  the castle, its terrain features (moats, glaci, ditches), back walls, rooms and the village behind
  are raised by `elevation` metres, and an approach slope rises from the plain. The gun stays on its
  own (lower) redoubt, so most shots go level or upward. The gun is then re-placed so every
  objective stays in range at the level's planned muzzle velocity.
*/
export function elevate(level: LevelDef): LevelDef {
  const H = level.elevation ?? 0;
  if (!(H > 0)) return level;
  const firstBlock = Math.min(...level.blocks.map((b) => b.x));
  // the site begins where its own terrain starts (glacis, moat, ramp) or a little before the first wall
  const site = level.siteX ?? firstBlock - 10;
  const foot = site - H * 1.7; // ~30° approach slope
  const gY = (pts: [number, number][], x: number) => {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const t = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0] || 1); return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t; }
    return pts[pts.length - 1][1];
  };
  const g0 = level.ground;
  const ground: [number, number][] = [];
  for (const [x, y] of g0) if (x < foot) ground.push([x, y]);
  ground.push([foot, gY(g0, foot)]);
  ground.push([site, gY(g0, site) + H]);
  for (const [x, y] of g0) if (x > site) ground.push([x, y + H]);
  // the far side drops back to the plain well beyond the village
  const lastX = Math.max(...level.houses.map((h) => h.x + h.w), Math.max(...level.blocks.map((b) => b.x + b.w))) + 8;
  const tail = ground.filter(([x]) => x > lastX + H * 2.4);
  const head = ground.filter(([x]) => x <= lastX);
  // the plateau holds its height right up to its far edge, then drops back to the plain
  const out: [number, number][] = [...head, [lastX, gY(g0, lastX) + H], [lastX + H * 2.4, gY(g0, lastX + H * 2.4)], ...tail.map(([x]) => [x, gY(g0, x)] as [number, number])];
  out.sort((a, b) => a[0] - b[0]);
  const blocks = level.blocks.map((b) => ({ ...b, y: b.y + H }));
  const lifted: LevelDef = {
    ...level,
    elevation: 0,
    ground: out,
    blocks,
    backdrops: level.backdrops?.map((b) => ({ ...b, y: b.y + H })),
    rooms: level.rooms?.map((r) => ({ ...r, y0: r.y0 + H, y1: r.y1 + H })),
  };
  // keep everything in range: the gun moves up toward the hill if it must, but stays off the slope
  const near = Math.min(level.cannonX + 40, foot - 12);
  lifted.cannonX = cannonFor(blocks, out, level.objectives, level.wind, level.gunCap ?? 36, Math.min(level.cannonX, near), near);
  return lifted;
}
