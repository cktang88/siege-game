import * as THREE from 'three';
import type { TargetKind } from './config';
import type { Era } from './engrig';
import { textures } from './render';

/*
  Objective dressings. An objective block is a room's contents in one piece (a command post, a munitions
  store, a workshop...); it carries a picture of what it is on its face, so it reads at a glance instead of
  as a tinted block with a label. The picture (public/sprites/obj_*.png, made with scripts/gen-sprites.mjs)
  is fitted inside the block with a small margin, keeps its aspect and stands on the block's floor line; the
  block shows a frame in the target colour around it (block shader, uTarget = 2) and a darker panel behind.

  The picture is a child of the block mesh: it rides the block as it slides and topples, leaves with it
  (dropObject frees its geometry and material; the texture is shared) and sits just under a concealed room's
  cover (z 4.3); it is also hidden outright while the room is walled up. Fracture remains are plain rubble.
  Kinds whose block already wears a sprite (the counter-battery gun's aiming barrel, the mast) get none.
*/

const SPRITES: Partial<Record<TargetKind, Record<Era, string>>> = {
  command: { modern: 'obj_hq_mod', medieval: 'obj_hq_med' },
  ammo: { modern: 'obj_ammo_mod', medieval: 'obj_ammo_med' },
  workshop: { modern: 'obj_eng_mod', medieval: 'obj_eng_med' },
  barracks: { modern: 'obj_bar_mod', medieval: 'obj_bar_med' },
  flak: { modern: 'obj_flak_mod', medieval: 'obj_flak_med' },
  depot: { modern: 'obj_depot', medieval: 'obj_depot' },
};

/** every dressing texture, for the sprite loader */
export const OBJ_SPRITES = [...new Set(Object.values(SPRITES).flatMap((s) => Object.values(s!)))];

/** gap between the block's edge and the picture (m): the target-colour frame shows in it */
export const OBJ_MARGIN = 0.14;

/** the dressing for an objective block of size w x h (centred on the block), or null if it has none */
export function makeDressing(kind: TargetKind, era: Era, w: number, h: number): THREE.Mesh | null {
  const name = SPRITES[kind]?.[era];
  const tex = name ? textures[name] : undefined;
  if (!tex) return null;
  const img = tex.image as HTMLImageElement;
  const aspect = img.width / img.height;
  const m = Math.min(OBJ_MARGIN, w * 0.12, h * 0.12);
  const bw = w - 2 * m, bh = h - 2 * m;
  if (bw <= 0.1 || bh <= 0.1) return null;
  let sw = bw, sh = bw / aspect;
  if (sh > bh) { sh = bh; sw = bh * aspect; }
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, alphaTest: 0.05 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), mat);
  // things stand on the floor: bottom-aligned, centred across
  mesh.position.set(0, -h / 2 + m + sh / 2, 0.15);
  mesh.name = 'objDressing';
  return mesh;
}

/** per frame: char and damage darken the picture, a hit flashes it, a walled-up room hides it */
export function updateDressing(d: THREE.Mesh, burn: number, damage: number, flash: number, hidden: boolean) {
  d.visible = !hidden;
  if (hidden) return;
  const k = (1 - 0.75 * Math.min(1, burn * 1.2)) * (1 - 0.3 * damage) + flash * 0.6;
  (d.material as THREE.MeshBasicMaterial).color.setScalar(k);
}
