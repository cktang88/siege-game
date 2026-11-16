import RAPIER from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { AMMO_BY_ID, PHYS } from './config';
import type { Block, BlastOpts, Game, Projectile } from './game';
import { makeSprite, textures } from './render';
import { audio } from './audio';

/*
  Enemy armour from the motor pool ('depot' targets): wheeled armoured cars that strafe the gun with a
  turret MG, and light tanks with a sloped glacis and a main gun that lobs shells at it. They are not
  physics bodies: rounds are tested against each hull outline (a polygon in the sprite's own frame),
  so the face a round strikes decides obliquity (sloped plates glance flat fire) and how much armour
  it meets (roof and belly are thin, the mantlet thick). Steel ignores canister and shrugs off solid
  shot; AP, shaped and contact charges, direct HE, drills from below and bombs from above kill it.
*/

export type VehicleKind = 'car' | 'tank';

interface Spec {
  sprite: string;
  hp: number;
  /** sprite height (m); length comes from the sprite's aspect */
  h: number;
  speed: number;
  /** halt this far ahead of the gun (m): [min, spread] */
  stop: [number, number];
  /** damage taken per point of: solid-shot kinetic energy, AP penetration, blast */
  kin: number; ap: number; blast: number;
  /** extra damage through the thin roof and belly plates */
  top: number; belly: number;
  /** hull outline in sprite fractions (u: 0 nose .. 1 tail, v: 0 ground .. 1 top), counter-clockwise */
  hull: [number, number][];
  /** per-edge armour factor (edge i runs hull[i] -> hull[i+1]); missing = by facing */
  edge?: Record<number, number>;
  muzzle: [number, number];
  /** cos(obliquity) below which AP and solid shot glance off */
  crit: number;
}

const SPEC: Record<VehicleKind, Spec> = {
  car: {
    sprite: 'armoredcar', hp: 150, h: 1.9, speed: 3.4, stop: [25, 5],
    kin: 0.2, ap: 0.5, blast: 0.65, top: 1.3, belly: 2,
    hull: [[0, 0.42], [0.12, 0.06], [0.92, 0.06], [1, 0.5], [0.98, 0.72], [0.64, 0.78], [0.62, 0.98], [0.45, 0.98], [0.42, 0.78], [0.3, 0.75]],
    muzzle: [0.3, 0.88],
    crit: 0.3, // thin plate: only a real graze glances
  },
  tank: {
    sprite: 'tank', hp: 380, h: 1.85, speed: 1.6, stop: [34, 3],
    kin: 0.06, ap: 0.5, blast: 0.3, top: 1.5, belly: 2,
    // a long, flat glacis (~18° from horizontal): flat fire skips off it, plunging fire bites
    hull: [[0, 0.38], [0.1, 0.03], [0.92, 0.03], [1, 0.42], [0.98, 0.62], [0.66, 0.64], [0.65, 0.9], [0.52, 0.99], [0.4, 0.95], [0.37, 0.66], [0.3, 0.64]],
    edge: { 8: 0.55 }, // the turret face (mantlet) is the thickest plate
    muzzle: [0.0, 0.78],
    crit: 0.56, // steel ricochets past ~56°, as for armour-plate blocks
  },
};

interface Vehicle {
  kind: VehicleKind;
  spec: Spec;
  mesh: THREE.Mesh;
  bar: THREE.Group;
  len: number;
  /** hull outline in metres, local frame (origin at ground centre, facing left) */
  poly: [number, number][];
  x: number; y: number; rot: number;
  hp: number;
  stopX: number;
  fireT: number;
  burst: number;
  shots: number;
  burning: number;
  flash: number;
  /** <0 alive; else seconds since it was knocked out */
  wreckT: number;
  phase: number;
  moving: boolean;
}

export class MotorPool {
  units: Vehicle[] = [];
  spawnT = 18;
  launched = 0;
  kills = 0;
  private stuck: { p: Projectile; u: Vehicle; lx: number; ly: number }[] = [];
  private told = new Set<string>();
  constructor(private g: Game) {}

  clear() {
    for (const u of this.units) { u.mesh.parent?.remove(u.mesh); u.bar.parent?.remove(u.bar); }
    this.units = []; this.stuck = []; this.told.clear();
    this.spawnT = 18; this.launched = 0; this.kills = 0;
  }

  get alive() { return this.units.filter((u) => u.wreckT < 0); }
  depots(): Block[] { return this.g.liveTargets('depot'); }

  private once(key: string, text: string, tone: 'good' | 'bad' | 'info' = 'info') {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.g.toast(text, tone);
  }

  // ───────────────────────── spawning & driving ─────────────────────────
  launch(kind: VehicleKind, from: Block) {
    const g = this.g, sp = SPEC[kind];
    const tex = textures[sp.sprite];
    const aspect = tex ? (tex.image as HTMLImageElement).width / (tex.image as HTMLImageElement).height : kind === 'car' ? 2.15 : 2.58;
    const len = sp.h * aspect;
    const mesh = makeSprite(sp.sprite, sp.h, 7.0, 0x4a4f44); // behind the infantry (7.2)
    mesh.geometry.translate(0, sp.h / 2, 0); // origin at the ground line under the hull's centre
    g.root.add(mesh);
    const bar = new THREE.Group();
    const back = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.22), new THREE.MeshBasicMaterial({ color: 0x0b0c0e, transparent: true, opacity: 0.8, depthTest: false }));
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(1.92, 0.13), new THREE.MeshBasicMaterial({ color: 0xe2503a, depthTest: false, transparent: true }));
    fill.geometry.translate(0.96, 0, 0); fill.position.set(-0.96, 0, 0.01); fill.name = 'fill';
    back.renderOrder = 30; fill.renderOrder = 31;
    bar.add(back, fill);
    g.root.add(bar);
    const t = from.body.translation();
    const x = Math.min(t.x, g.fortressBounds.x0 - 2) - len / 2;
    const u: Vehicle = {
      kind, spec: sp, mesh, bar, len, poly: sp.hull.map(([a, b]) => [(a - 0.5) * len, b * sp.h]),
      x, y: g.groundY(x), rot: 0, hp: sp.hp, stopX: this.haltX(kind, len, x),
      fireT: kind === 'tank' ? 3 + Math.random() * 2 : 1, burst: 0, shots: 0, burning: 0, flash: 0, wreckT: -1, phase: Math.random() * 6, moving: true,
    };
    this.units.push(u);
    this.place(u);
    g.toast(kind === 'tank' ? 'Enemy tank rolling out of the motor pool!' : 'Armoured car inbound!', 'bad');
    this.once(`intro-${kind}`, kind === 'tank'
      ? 'Tanks: flat shots skip off the glacis. Plunge AP onto it, stick a charge on, or bomb it.'
      : 'Armoured cars shrug off canister and round shot. AP, a direct HE hit or a sticky charge stops them.', 'info');
  }

  /**
   * Where to halt: on the valley floor between the foot of the gun's redoubt (cannonX + 12) and the rise
   * of the castle's ground, never on a slope and never up the gun mound. Cars take the gun end of the
   * floor, tanks the castle end; on flat ground this falls back to ~25-30 m (car) and ~35 m (tank).
   */
  haltX(kind: VehicleKind, len: number, from: number) {
    const g = this.g, cx = g.level.cannonX, sp = SPEC[kind];
    const a = cx + 12, b = Math.max(a + 2, Math.min(from, g.fortressBounds.x0 - 1));
    let lo = Infinity;
    for (let x = a; x <= b; x += 0.5) lo = Math.min(lo, g.groundY(x));
    // the floor: the stretch within 0.8 m of the lowest ground, from its gun end to where the hill starts rising
    let f0 = a, f1 = a;
    for (let x = a; x <= b; x += 0.5) if (g.groundY(x) <= lo + 0.8) { f0 = x; break; }
    for (let x = f0; x <= b && g.groundY(x) <= lo + 0.8; x += 0.5) f1 = x;
    const mid = (f0 + f1) / 2, half = len / 2 + 0.3;
    const want = cx + sp.stop[0] + Math.random() * sp.stop[1];
    const x = kind === 'car' ? Math.min(Math.max(want, f0 + half), Math.max(f0 + half, mid)) : Math.max(Math.min(want, f1 - half), Math.min(f1 - half, mid));
    // a floor shorter than the hull: nose at the foot of the gun mound, tail up the far slope
    return f1 - f0 < 2 * half ? f0 + half : x;
  }

  private place(u: Vehicle) {
    const g = this.g, half = u.len * 0.36;
    const yb = g.groundY(u.x - half), yf = g.groundY(u.x + half);
    u.y = Math.min(yb, yf) + (Math.max(yb, yf) - Math.min(yb, yf)) * 0.5;
    u.rot = Math.atan2(yf - yb, 2 * half);
  }

  /** world point of a local (hull-frame) point */
  private world(u: Vehicle, lx: number, ly: number) {
    const c = Math.cos(u.rot), s = Math.sin(u.rot);
    return { x: u.x + lx * c - ly * s, y: u.y + lx * s + ly * c };
  }
  private local(u: Vehicle, x: number, y: number) {
    const c = Math.cos(u.rot), s = Math.sin(u.rot), dx = x - u.x, dy = y - u.y;
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  }

  update(dt: number, active: boolean) {
    const g = this.g;
    const depots = this.depots();
    const d = g.level.difficulty ?? 4;
    if (active && depots.length) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        const cap = d >= 7 ? 3 : 2;
        const from = depots[this.launched % depots.length];
        const kinds: VehicleKind[] = d >= 5 ? ['car', 'tank'] : ['car'];
        const kind = kinds[this.launched % kinds.length];
        const fx = Math.min(from.body.translation().x, g.fortressBounds.x0 - 2);
        // the exit must be clear: a vehicle (or wreck) still in the way holds the next one back
        const clear = !this.units.some((o) => Math.abs(o.x - fx) < o.len + 4);
        if (this.alive.length < cap && clear) { this.launch(kind, from); this.launched++; this.spawnT = 30; } else this.spawnT = 4;
      }
    }
    const cx = g.level.cannonX, gun = g.barrel.position;
    for (const u of this.units) {
      u.flash = Math.max(0, u.flash - dt * 8);
      if (u.wreckT >= 0) { this.updateWreck(u, dt); continue; }
      // drive at the gun until in range, queueing behind anything in front, never through masonry
      let go = u.x > u.stopX;
      // queue behind wrecks and same-type vehicles; a car may pass a halted tank (they halt at different points)
      if (go) for (const o of this.units) if (o !== u && o.x < u.x && (o.wreckT >= 0 || o.kind === u.kind) && u.x - o.x - (u.len + o.len) / 2 < 1.2) { go = false; break; }
      if (go) {
        const front = this.world(u, -u.len / 2 - 0.35, 0.9);
        g.world.intersectionsWithShape(front, u.rot, new RAPIER.Cuboid(0.3, 0.6), (c) => {
          const o = g.owners.get(c.handle);
          if (o?.t === 'block' && !o.b.dead) go = false;
          return go;
        });
      }
      u.moving = go;
      if (go) {
        u.x -= u.spec.speed * dt;
        this.place(u);
        if (Math.random() < dt * 6) g.r.smoke.spawn({ x: u.x + u.len * 0.5, y: u.y + 0.5, vx: 0.8 + g.wind * 0.3, vy: 0.6, max: 1.3, size0: 0.3, size1: 1.1, c0: [0.3, 0.3, 0.3], c1: [0.55, 0.55, 0.55], a0: 0.5, a1: 0, drag: 1 });
        if (Math.random() < dt * 0.8) audio.play('drone', u.x, 0.5, u.kind === 'tank' ? 0.35 : 0.5);
      }
      // weapons
      if (active && !g.ended) {
        if (u.kind === 'car') this.carGun(u, dt, gun);
        else if (!go) this.tankGun(u, dt, cx);
      }
      // damage state: a hurt hull smokes, a badly hurt one burns
      const frac = u.hp / u.spec.hp;
      if (u.burning > 0) {
        u.burning -= dt;
        this.damage(u, (u.kind === 'tank' ? 2 : 5) * dt);
      }
      if (frac < 0.6 && Math.random() < dt * (frac < 0.3 ? 10 : 4)) {
        const p = this.world(u, (Math.random() - 0.3) * u.len * 0.5, u.spec.h * 0.75);
        g.r.smoke.spawn({ x: p.x, y: p.y, vx: g.wind * 0.4, vy: 1.3, max: 2.2, size0: 0.5, size1: 2, c0: [0.18, 0.17, 0.16], c1: [0.42, 0.41, 0.4], a0: 0.7, a1: 0, drag: 0.6 });
      }
      if ((frac < 0.3 || u.burning > 0) && Math.random() < dt * 12) {
        const p = this.world(u, (Math.random() - 0.5) * u.len * 0.5, u.spec.h * 0.7);
        g.r.flame.spawn({ x: p.x, y: p.y, vx: g.wind * 0.3, vy: 1.6, max: 0.5, size0: 0.55, size1: 0.1, c0: [1.4, 0.8, 0.2], c1: [0.7, 0.15, 0.03], a0: 0.95, a1: 0, drag: 1 });
      }
      this.sync(u);
    }
    // charges glued to a hull ride along with it; when one goes off it is a shaped charge against the plate
    for (const s of this.stuck) {
      if (s.p.dead) {
        if (s.p.fuse <= 0 && s.u.wreckT < 0) this.damage(s.u, s.p.ammo.blastDamage * s.p.dmgMul * 1.2, true);
        continue;
      }
      const w = this.world(s.u, s.lx, s.ly);
      if (s.p.stuck) { s.p.stuck.lx = w.x; s.p.stuck.ly = w.y; }
    }
    this.stuck = this.stuck.filter((s) => !s.p.dead);
    this.units = this.units.filter((u) => {
      if (u.wreckT > 40) { u.mesh.parent?.remove(u.mesh); u.bar.parent?.remove(u.bar); return false; }
      return true;
    });
  }

  private carGun(u: Vehicle, dt: number, gun: THREE.Vector3) {
    const g = this.g;
    if (u.x - g.level.cannonX > 38) return;
    u.fireT -= dt;
    if (u.fireT > 0) return;
    if (u.burst <= 0) u.burst = 6;
    u.burst--;
    u.fireT = u.burst > 0 ? 0.12 : 2.4 + Math.random() * 0.6;
    const m = this.world(u, (u.spec.muzzle[0] - 0.5) * u.len, u.spec.muzzle[1] * u.spec.h);
    // firing blind into smoke, most of the burst goes wide
    const blind = g.enemyBlind > 0;
    g.tracer(m.x, m.y, gun.x + (Math.random() - 0.5) * (blind ? 6 : 1.6), gun.y + (Math.random() - 0.4) * (blind ? 3 : 1), u.burst % 2 ? null : 'rifle');
    g.damageCannon(blind ? 0.1 : 0.3);
  }

  private tankGun(u: Vehicle, dt: number, cx: number) {
    const g = this.g;
    u.fireT -= dt;
    if (u.fireT > 0) return;
    if (g.enemyBlind > 0) { u.fireT = 1; u.shots = Math.min(u.shots, 1); return; }
    u.fireT = 6 + Math.random() * 2;
    // the layer walks his fall of shot in, but a tank gun on the move is never exact
    const errs = [6, 3.5];
    const err = (u.shots < errs.length ? errs[u.shots] : 1.2 + Math.random() * 3.3) * (Math.random() < 0.5 ? -1 : 1);
    const m = this.world(u, (u.spec.muzzle[0] - 0.5) * u.len, u.spec.muzzle[1] * u.spec.h);
    const tx = cx + err, ty = g.groundY(tx) + 0.4;
    const shot = this.aim(m.x, m.y, tx, ty, 34);
    if (!shot) { u.fireT = 2; return; }
    u.shots++;
    const he = AMMO_BY_ID.he;
    g.spawnProjectile(he, m.x, m.y, shot.vx, shot.vy, true);
    const imp = g.predictImpact(m.x, m.y, shot.vx, shot.vy, he.wind);
    const mk = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.25, 28), new THREE.MeshBasicMaterial({ color: 0xff3b1f, transparent: true, opacity: 0.9, depthTest: false }));
    mk.position.set(imp.x, imp.y + 0.15, 12);
    mk.scale.y = 0.35;
    g.root.add(mk);
    g.incoming.push({ x: imp.x, t: shot.flight, mesh: mk });
    g.muzzleBlast(m.x, m.y, Math.atan2(shot.vy, shot.vx), 0.6);
    audio.play('enemyGun', m.x, 0.8, 1.15);
    if (u.shots === 1) g.toast('Tank gun firing on you!', 'bad');
  }

  /**
   * Low-angle firing solution at speed v onto (tx, ty), flown exactly as the physics will fly it
   * (gravity, wind, 60 Hz). Bisects the elevation for the flattest path that clears the terrain.
   */
  aim(sx: number, sy: number, tx: number, ty: number, v: number) {
    const g = this.g, DT = 1 / 60;
    const wind = g.wind * AMMO_BY_ID.he.wind * 0.35;
    const dir = tx < sx ? -1 : 1;
    const fly = (e: number) => {
      let x = sx, y = sy, vx = Math.cos(e) * v * dir, vy = Math.sin(e) * v, n = 0;
      while (n++ < 900) {
        vx += wind * DT; vy += PHYS.gravity * DT;
        x += vx * DT; y += vy * DT;
        if ((x - tx) * dir >= 0) return { h: y - ty, n };
        if (y < g.groundY(x) - 0.05) return { h: -1e9, n };
      }
      return { h: -1e9, n };
    };
    let lo = -0.35, hi = 0.75;
    if (fly(hi).h < 0) return null;
    for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (fly(m).h >= 0) hi = m; else lo = m; }
    const e = hi + 0.004;
    return { vx: Math.cos(e) * v * dir, vy: Math.sin(e) * v, flight: fly(e).n * DT };
  }

  private updateWreck(u: Vehicle, dt: number) {
    const g = this.g;
    u.wreckT += dt;
    const p = this.world(u, (Math.random() - 0.5) * u.len * 0.5, u.spec.h * 0.6);
    if (u.wreckT < 18 && Math.random() < dt * 16) g.r.flame.spawn({ x: p.x, y: p.y, vx: g.wind * 0.3, vy: 1.8 + Math.random(), max: 0.6, size0: 0.8, size1: 0.1, c0: [1.4, 0.75, 0.18], c1: [0.7, 0.15, 0.03], a0: 0.95, a1: 0, drag: 1 });
    if (Math.random() < dt * (u.wreckT < 25 ? 8 : 2)) g.r.smoke.spawn({ x: p.x, y: p.y + 0.4, vx: g.wind * 0.6, vy: 1.4, max: 3, size0: 0.7, size1: 3, c0: [0.14, 0.13, 0.13], c1: [0.4, 0.39, 0.38], a0: 0.75, a1: 0, drag: 0.4 });
    if (u.wreckT < 18) g.r.lights.set(`wreck${u.phase}`, u.x, u.y + 1, 4, [1, 0.5, 0.15], 0.8, 0.45);
    if (u.wreckT > 36) (u.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - (u.wreckT - 36) / 4);
  }

  private sync(u: Vehicle) {
    const bob = u.moving && u.kind === 'car' ? Math.sin(u.x * 3) * 0.03 : 0;
    u.mesh.position.set(u.x, u.y + bob, u.mesh.position.z);
    u.mesh.rotation.z = u.rot;
    const frac = Math.max(0, u.hp / u.spec.hp);
    const k = (0.65 + 0.35 * frac) * (1 + u.flash * 1.5);
    (u.mesh.material as THREE.MeshBasicMaterial).color.setRGB(k, k * (1 - u.flash * 0.3), k * (1 - u.flash * 0.3));
    u.bar.position.set(u.x, u.y + u.spec.h + 0.45, 14);
    const fill = u.bar.getObjectByName('fill') as THREE.Mesh;
    fill.scale.x = Math.max(0.001, frac);
    u.bar.visible = u.wreckT < 0;
  }

  // ───────────────────────── damage ─────────────────────────
  damage(u: Vehicle, dmg: number, shaped = false) {
    if (u.wreckT >= 0 || dmg <= 0) return;
    u.hp -= dmg;
    u.flash = Math.min(1, u.flash + Math.min(0.8, dmg / 40));
    if (shaped) this.g.sparks(u.x, u.y + u.spec.h * 0.6, 16);
    if (u.hp <= 0) this.knockOut(u);
  }

  knockOut(u: Vehicle) {
    const g = this.g;
    u.wreckT = 0; u.hp = 0; u.moving = false;
    this.kills++;
    const c = this.world(u, 0, u.spec.h * 0.55);
    // the hull brews up: ammunition and fuel go together (an enemy blast: no collateral against you)
    g.explode(c.x, c.y, u.kind === 'tank' ? 3 : 2.4, u.kind === 'tank' ? 90 : 60, { enemy: true, visual: u.kind === 'tank' ? 1.5 : 1.1 });
    const col = new THREE.Color(0.3, 0.31, 0.27);
    for (let i = 0; i < 14; i++) g.r.debris.spawn(c.x + (Math.random() - 0.5) * u.len * 0.6, c.y, (Math.random() - 0.5) * 9, 3 + Math.random() * 8, 0.12 + Math.random() * 0.25, col.clone().multiplyScalar(0.7 + Math.random() * 0.5));
    (u.mesh.material as THREE.MeshBasicMaterial).color.setRGB(0.32, 0.29, 0.27);
    u.mesh.rotation.z = u.rot + (u.kind === 'tank' ? 0.02 : 0.06);
    u.bar.visible = false;
    g.toast(u.kind === 'tank' ? 'Tank knocked out!' : 'Armoured car destroyed!', 'good');
  }

  /** nearest hull face to a point: distance (0 inside), armour factor and outward normal (world) */
  private nearest(u: Vehicle, x: number, y: number) {
    const q = this.local(u, x, y);
    const P = u.poly;
    let best = Infinity, bi = 0, inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, yi] = P[i], [xj, yj] = P[j];
      if ((yi > q.y) !== (yj > q.y) && q.x < ((xj - xi) * (q.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    for (let i = 0; i < P.length; i++) {
      const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((q.x - ax) * dx + (q.y - ay) * dy) / l2));
      const d = Math.hypot(q.x - ax - dx * t, q.y - ay - dy * t);
      if (d < best) { best = d; bi = i; }
    }
    return { d: inside ? 0 : best, ...this.face(u, bi) };
  }

  /** a hull edge's outward normal (world) and armour factor */
  private face(u: Vehicle, i: number) {
    const P = u.poly;
    const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length];
    const l = Math.hypot(bx - ax, by - ay);
    const nx = (by - ay) / l, ny = -(bx - ax) / l; // CCW outline: (dy, -dx) points out
    const c = Math.cos(u.rot), s = Math.sin(u.rot);
    const n = { x: nx * c - ny * s, y: nx * s + ny * c };
    const f = u.spec.edge?.[i] ?? (ny > 0.97 ? u.spec.top : ny < -0.97 ? u.spec.belly : 1);
    return { n, f };
  }

  /** first hull face crossed by the segment a->b */
  private cross(u: Vehicle, ax: number, ay: number, bx: number, by: number) {
    const a = this.local(u, ax, ay), b = this.local(u, bx, by);
    const rx = b.x - a.x, ry = b.y - a.y;
    const P = u.poly;
    let best: { t: number; i: number } | null = null;
    for (let i = 0; i < P.length; i++) {
      const [px, py] = P[i], [qx, qy] = P[(i + 1) % P.length];
      const sx = qx - px, sy = qy - py;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((px - a.x) * sy - (py - a.y) * sx) / den;
      const v = ((px - a.x) * ry - (py - a.y) * rx) / den;
      if (t < 0 || t > 1 || v < 0 || v > 1) continue;
      if (!best || t < best.t) best = { t, i };
    }
    if (!best) return null;
    return { t: best.t, x: ax + (bx - ax) * best.t, y: ay + (by - ay) * best.t, ...this.face(u, best.i) };
  }

  /** explosion damage (player ordnance): falls off with distance to the hull, focused by contact, worse through roof and belly */
  blast(x: number, y: number, r: number, dmg: number, opts: BlastOpts) {
    if (r <= 0) return;
    for (const u of this.units) {
      if (u.wreckT >= 0) continue;
      const n = this.nearest(u, x, y);
      if (n.d >= r) continue;
      const k = 1 - n.d / r;
      this.damage(u, dmg * k * u.spec.blast * n.f * (n.d < 0.3 ? 1.6 : 1));
      if (opts.ignite && k > 0.3) u.burning = Math.max(u.burning, opts.ignite * 2);
    }
  }

  /** player rounds against the hulls, tested along this frame's flight; handles the hit and may consume the round */
  hit(p: Projectile, dt: number) {
    const g = this.g;
    if (p.dead || p.enemy || !this.units.length) return;
    if (p.burrow) {
      // a drill tunnelling under a hull blows its belly in
      const u = this.units.find((q) => q.wreckT < 0 && Math.abs(q.x - p.x) < q.len * 0.45);
      if (u) {
        g.boom(p, p.x, g.groundY(p.x) - 0.4, p.ammo.blastRadius, p.ammo.blastDamage, { under: true, push: 1.4 });
        g.removeProjectile(p);
      }
      return;
    }
    if (p.impacted || p.stuck || p.inert !== undefined) return;
    const b = p.body ? p.body.translation() : { x: p.x + p.vx * dt, y: p.y + p.vy * dt };
    let hit: (NonNullable<ReturnType<MotorPool['cross']>> & { u: Vehicle }) | null = null;
    for (const u of this.units) {
      if (u.wreckT >= 0 || Math.abs(u.x - p.x) > u.len + 30) continue;
      const c = this.cross(u, p.x, p.y, b.x, b.y);
      if (c && (!hit || c.t < hit.t)) hit = { ...c, u };
    }
    if (hit) this.strike(p, hit.u, hit.x, hit.y, hit.n, hit.f);
  }

  private strike(p: Projectile, u: Vehicle, x: number, y: number, n: { x: number; y: number }, f: number) {
    const g = this.g, a = p.ammo, sp = Math.hypot(p.vx, p.vy) || 1;
    const dir = { x: p.vx / sp, y: p.vy / sp };
    const dn = dir.x * n.x + dir.y * n.y;
    const cos = Math.abs(dn);
    const ref = { x: dir.x - 2 * dn * n.x, y: dir.y - 2 * dn * n.y };
    const out = { x: x + n.x * (p.body ? 0.45 : 0.08), y: y + n.y * (p.body ? 0.45 : 0.08) };
    const setV = (vx: number, vy: number) => {
      p.vx = vx; p.vy = vy;
      if (p.body) { p.body.setTranslation(out, true); p.body.setLinvel({ x: vx, y: vy }, true); } else { p.x = out.x; p.y = out.y; }
    };
    const name = u.kind === 'tank' ? 'tank' : 'armoured car';
    if (p.pellet) {
      g.sparks(x, y, 3);
      if (Math.random() < 0.3) audio.play('clang', x, 0.35, 1.6);
      this.once('pellet', 'Canister rattles off the armour.');
      g.removeProjectile(p);
      return;
    }
    if (a.mode === 'penetrator') {
      if (cos < u.spec.crit * 0.95 && a.id !== 'bomb_pen') {
        this.damage(u, p.pen * cos * u.spec.ap * f * 0.1);
        g.sparks(x, y, 14);
        audio.play('clang', x, 0.9, 1.15);
        this.once(`glance-${u.kind}`, `Glanced off the ${name}'s sloped plate. Hit it square, or plunge from above.`);
        if (a.fuse) { g.boom(p, x, y, a.blastRadius, a.blastDamage, { bonus: a.bonus }); g.removeProjectile(p); return; } // fuze crushed on the plate
        p.pen *= 0.55;
        setV(ref.x * sp * 0.65, ref.y * sp * 0.65);
        return;
      }
      this.damage(u, p.pen * cos * u.spec.ap * f * (a.bonus?.steel ?? 1));
      g.sparks(x, y, 10);
      g.boom(p, x - dir.x * 0.15, y - dir.y * 0.15, a.blastRadius, a.blastDamage, { bonus: a.bonus });
      g.removeProjectile(p);
      return;
    }
    switch (a.id) {
      case 'shell':
      case 'heavy': {
        // solid shot dents steel: a little damage square on, almost none at a glance; the ball is spent
        const kin = a.kinetic * (sp / 30) ** 2 * p.dmgMul;
        g.sparks(x, y, 10);
        audio.play('clang', x, 0.9, a.id === 'heavy' ? 0.8 : 1);
        if (cos < u.spec.crit) {
          this.damage(u, kin * cos * u.spec.kin * f * 0.3);
          this.once(`glance-${u.kind}`, `Glanced off the ${name}'s sloped plate. Hit it square, or plunge from above.`);
          setV(ref.x * sp * 0.5, ref.y * sp * 0.5);
          p.inert = 2;
        } else {
          this.damage(u, kin * cos * u.spec.kin * f);
          this.once('solid', `Solid shot barely dents the ${name}. Bring AP, charges or HE.`);
          setV(-dir.x * sp * 0.12 + n.x * 1.5, -dir.y * sp * 0.12 + n.y * 1.5);
          p.inert = 2.5;
        }
        p.impacted = true;
        return;
      }
      case 'delayed':
        p.impacted = true;
        p.fuse = p.fuseSetting ?? a.fuse ?? 3;
        setV(ref.x * sp * 0.12, ref.y * sp * 0.12 - 1);
        return;
      case 'sticky': {
        p.impacted = true;
        p.fuse = g.stats.stickyFuse;
        if (p.body) { g.owners.delete(p.collider!.handle); g.world.removeRigidBody(p.body); p.body = undefined; }
        p.x = x; p.y = y; p.vx = 0; p.vy = 0;
        p.stuck = { lx: x, ly: y, rot: 0 };
        const l = this.local(u, x, y);
        this.stuck.push({ p, u, lx: l.x, ly: l.y });
        audio.play('thud', x, 0.6);
        return;
      }
      case 'smoke':
        g.smokeScreen(x, y);
        g.removeProjectile(p);
        return;
      case 'drill':
        g.explode(x, y, 2.2, 70);
        g.removeProjectile(p);
        return;
      default: {
        // HE, incendiary, cluster, flak, bombs and bomblets go off against the hull
        const opts: BlastOpts = a.ignite ? { ignite: a.ignite, visual: 0.9 } : a.id === 'flak' ? { flak: true, visual: 0.8 } : {};
        g.boom(p, x - dir.x * 0.1, y - dir.y * 0.1, a.blastRadius, a.blastDamage, opts);
        g.removeProjectile(p);
      }
    }
  }
}
