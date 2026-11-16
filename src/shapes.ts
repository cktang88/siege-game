import type { MatId } from './config';
import type { BlockDef } from './levels';

type P = [number, number];

/** convex block from world-space points: normalises to its bbox and makes the winding CCW */
export function polyBlock(pts: P[], mat: MatId, extra: Partial<BlockDef> = {}): BlockDef {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    area += ax * by - bx * ay;
  }
  const ccw = area < 0 ? [...pts].reverse() : pts;
  const x0 = Math.min(...ccw.map((p) => p[0])), y0 = Math.min(...ccw.map((p) => p[1]));
  const x1 = Math.max(...ccw.map((p) => p[0])), y1 = Math.max(...ccw.map((p) => p[1]));
  const r = (v: number) => +v.toFixed(3);
  return { x: r(x0), y: r(y0), w: r(x1 - x0), h: r(y1 - y0), mat, poly: ccw.map(([x, y]) => [r(x - x0), r(y - y0)] as P), ...extra };
}

/** right-angle wedge; `high` is the side with the vertical face (a batter, glacis, ramp, buttress foot) */
export const wedge = (x: number, y: number, w: number, h: number, mat: MatId, high: 'left' | 'right', extra: Partial<BlockDef> = {}) =>
  polyBlock(high === 'left' ? [[x, y], [x + w, y], [x, y + h]] : [[x, y], [x + w, y], [x + w, y + h]], mat, extra);

/** trapezoid: top edge inset from the bottom corners (negative insets overhang: eaves, corbels) */
export const trap = (x: number, y: number, w: number, h: number, mat: MatId, insetL: number, insetR: number, extra: Partial<BlockDef> = {}) =>
  polyBlock([[x, y], [x + w, y], [x + w - insetR, y + h], [x + insetL, y + h]], mat, extra);

/** inverted trapezoid: wide at the top (projecting hoardings, flared eaves) */
export const flare = (x: number, y: number, w: number, h: number, mat: MatId, outL: number, outR: number, extra: Partial<BlockDef> = {}) =>
  polyBlock([[x, y], [x + w, y], [x + w + outR, y + h], [x - outL, y + h]], mat, extra);

/** gable or conical roof in profile; apex as a fraction of the width */
export const roof = (x: number, y: number, w: number, h: number, mat: MatId, apex = 0.5, extra: Partial<BlockDef> = {}) =>
  polyBlock([[x, y], [x + w, y], [x + w * apex, y + h]], mat, extra);

/** a straight member of thickness t between two points (rotated rectangle): struts, flying buttresses, beams */
export function beam(ax: number, ay: number, bx: number, by: number, t: number, mat: MatId, extra: Partial<BlockDef> = {}) {
  const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
  const nx = (-dy / l) * (t / 2), ny = (dx / l) * (t / 2);
  return polyBlock([[ax + nx, ay + ny], [ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny]], mat, extra);
}

/** voussoirs of a semicircular (or partial) arch: stands only in compression, keystone and all */
export function arch(cx: number, cy: number, rIn: number, rOut: number, n: number, mat: MatId, a0 = 0, a1 = Math.PI, extra: Partial<BlockDef> = {}) {
  const out: BlockDef[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n, b = a0 + ((a1 - a0) * (i + 1)) / n;
    out.push(polyBlock([
      [cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn], [cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut],
      [cx + Math.cos(b) * rOut, cy + Math.sin(b) * rOut], [cx + Math.cos(b) * rIn, cy + Math.sin(b) * rIn],
    ], mat, extra));
  }
  return out;
}

/** a dome / radar radome in profile: an arch of thin shell segments */
export const dome = (cx: number, cy: number, r: number, t: number, n: number, mat: MatId) => arch(cx, cy, r - t, r, n, mat);
