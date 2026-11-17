import * as THREE from 'three';
import type { Block, Game } from './game';
import type { LevelDef } from './levels';
import { makeSprite } from './render';
import { Rooms, type Ladder, type RoomInfo, type RoomRT } from './rooms';
import { SoldierRig } from './soldier';

/*
  The garrison: people and furniture inside the rooms. They are not physics bodies; each rides
  the floor slab under its room (so a tilting floor tips them) and drops when the room's frame
  fails. Blasts, falling masonry, long falls and fire kill people; furniture just goes with the room.
  Off duty, people live in their rooms: they stroll to a spot and stand about, turn round, squat by
  the furniture, and now and then climb a ladder to the storey above or below (never into a room
  that has failed or is on fire). Walking stays inside the room's span between its columns.
  Fire: when part of a room's frame is alight, people panic and run for the far end, and may die
  of smoke and heat; on a ground floor the end of the room is a way out, so they bolt outside.
  Furniture in a burning room catches, chars, and carries the fire to the rest of the room's timbers.
  Rooms, ladders and concealed-room covers live in src/rooms.ts.
*/

type V2 = { x: number; y: number };
export type { RoomInfo };

type Act = 'pace' | 'sit' | 'climb' | 'panic';

interface Dweller {
  person: boolean;
  rig?: SoldierRig;
  mesh: THREE.Object3D;
  floor: Block | null;
  /** position in the floor body's local frame (or world, on the ground) */
  lx: number; ly: number;
  deps: Block[];
  home: V2[];
  /** the room they live in (null once they have fallen out of it) */
  room: RoomRT | null;
  /** the room they were found in at the start (for counting people of concealed rooms) */
  origin: RoomRT | null;
  x: number; y: number; vx: number; vy: number;
  /** fled: ran out of a burning ground-floor room (out the back, fading away; not a casualty) */
  state: 'home' | 'falling' | 'dead' | 'fled';
  /** x0..x1: walkable span (world); goal: where they are walking to; face: -1 left, 1 right */
  pace: { x0: number; x1: number; dir: number; speed: number; wait: number; goal: number; face: number; turnAt: number };
  act: Act;
  /** what to do on reaching the goal */
  next: 'stand' | 'sit' | 'ladder';
  ladder: Ladder | null;
  climb: { up: boolean; x: number; y1: number } | null;
  fallFrom: number;
  deadT: number;
  h: number;
  /** furniture: how far it has burnt (0..1) */
  char: number;
}

const PROPS = {
  medieval: [['p_barrel', 0.95], ['p_table', 0.9], ['p_bunk', 1.55], ['p_rack', 1.4], ['p_cauldron', 1.2], ['p_shelf', 1.8], ['p_cannon', 1.0], ['p_banner', 1.5]],
  modern: [['p_radio', 1.0], ['p_shells', 0.75], ['p_bunk', 1.55], ['p_table', 0.9], ['p_rack', 1.4], ['p_shelf', 1.8], ['p_barrel', 0.95]],
} as const;

const CLIMB_SPEED = 0.85;

export class Garrison {
  list: Dweller[] = [];
  casualties = 0;
  total = 0;
  /** people who escaped a burning room */
  fled = 0;
  rooms: Rooms;
  constructor(private g: Game) { this.rooms = new Rooms(g); }

  clear() {
    for (const d of this.list) d.mesh.parent?.remove(d.mesh);
    this.list = [];
    this.casualties = 0;
    this.total = 0;
    this.fled = 0;
    this.rooms.clear();
  }

  spawn(level: LevelDef, root: THREE.Group) {
    this.clear();
    const rooms = level.rooms ?? [];
    let seed = 1234 + rooms.length;
    const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    this.rooms.build(level, root, R);
    const era = level.era ?? 'medieval';
    const props = PROPS[era];
    let people = 0;
    for (const rt of this.rooms.list) {
      const r = rt.def;
      const w = r.x1 - r.x0;
      // targets already occupy the middle of some rooms: furniture goes to the sides there
      const busy = !!rt.target;
      const nProps = w < 2.2 ? 0 : busy ? 1 : 1 + (R() < 0.45 ? 1 : 0);
      const slots = busy ? [r.x0 + 0.5] : [r.x0 + 0.6 + R() * 0.3, r.x1 - 0.7 - R() * 0.3];
      for (let i = 0; i < nProps; i++) {
        const [name, h] = props[Math.floor(R() * props.length)];
        if (h > r.y1 - r.y0 - 0.3) continue;
        // keep furniture off the foot of a ladder
        let sx = slots[i];
        if (rt.ladders.some((l) => Math.abs(l.x - (sx + rt.x0 - r.x0)) < 0.7)) sx = sx < (r.x0 + r.x1) / 2 ? sx + 0.8 : sx - 0.8;
        if (sx < r.x0 + 0.3 || sx > r.x1 - 0.3) continue;
        const m = makeSprite(name, h, 3.1);
        if (R() < 0.5) m.scale.x = -1;
        const hang = name === 'p_banner';
        this.add(root, { person: false, mesh: m, h, x: sx, y: r.y0 + (hang ? r.y1 - r.y0 - h - 0.15 : 0), room: rt });
        if (!hang) rt.props.push(sx + rt.x0 - r.x0);
      }
      // people: about half the rooms are manned
      if (people < 48 && w > 1.6 && R() < (busy ? 0.7 : 0.5)) {
        const n = w > 3.5 && R() < 0.35 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const rig = new SoldierRig(true);
          rig.group.scale.setScalar(0.92);
          this.add(root, { person: true, rig, mesh: rig.group, h: 1.25, x: r.x0 + 0.5 + R() * (w - 1), y: r.y0, room: rt });
          rt.pop++;
          rt.spawnPop++;
          people++;
          this.total++;
        }
      }
    }
    this.rooms.index();
  }

  private add(root: THREE.Group, o: { person: boolean; rig?: SoldierRig; mesh: THREE.Object3D; h: number; x: number; y: number; room: RoomRT }) {
    // rooms are laid out on the design grid, but tall frames settle (up to ~0.6 m at the top of a
    // keep) before the garrison moves in: stand on the floor where it actually came to rest
    const rt = o.room;
    const sx = rt.x0 - rt.def.x0, sy = rt.y0 - rt.def.y0;
    const face = Math.random() < 0.5 ? -1 : 1;
    const d: Dweller = {
      person: o.person, rig: o.rig, mesh: o.mesh, floor: rt.floor, deps: rt.deps, home: rt.home, room: rt, origin: o.person ? rt : null, lx: 0, ly: 0, h: o.h,
      x: o.x + sx, y: o.y + sy, vx: 0, vy: 0, state: 'home', fallFrom: 0, deadT: 0, char: 0,
      pace: { x0: rt.x0 + 0.35, x1: rt.x1 - 0.35, dir: face, speed: 0.5 + Math.random() * 0.4, wait: Math.random() * 3, goal: o.x + sx, face, turnAt: -1 },
      act: 'pace', next: 'stand', ladder: null, climb: null,
    };
    this.toLocal(d);
    o.mesh.position.z = o.person ? 3.5 : 3.1;
    root.add(o.mesh);
    this.place(d);
    this.list.push(d);
  }

  /** remember position relative to the floor body */
  private toLocal(d: Dweller) {
    if (!d.floor || d.floor.dead) { d.floor = null; d.lx = d.x; d.ly = d.y; return; }
    const t = d.floor.body.translation(), r = d.floor.body.rotation();
    const dx = d.x - t.x, dy = d.y - t.y, c = Math.cos(-r), s = Math.sin(-r);
    d.lx = dx * c - dy * s; d.ly = dx * s + dy * c;
  }

  private fromLocal(d: Dweller) {
    if (!d.floor) { d.x = d.lx; d.y = d.ly; return 0; }
    const t = d.floor.body.translation(), r = d.floor.body.rotation();
    const c = Math.cos(r), s = Math.sin(r);
    d.x = t.x + d.lx * c - d.ly * s; d.y = t.y + d.lx * s + d.ly * c;
    return r;
  }

  private place(d: Dweller, rot = 0) {
    if (d.rig) return;
    d.mesh.position.set(d.x, d.y + d.h / 2, d.mesh.position.z);
    d.mesh.rotation.z = rot;
  }

  kill(d: Dweller, fling?: V2) {
    if (d.state === 'dead' || d.state === 'fled') return;
    if (d.person) {
      this.casualties++;
      if (d.origin) d.origin.dead++;
      if (fling) { d.vx = fling.x; d.vy = fling.y; }
    }
    d.state = d.person ? 'dead' : 'falling';
    if (!d.person) { d.vx = fling?.x ?? (Math.random() - 0.5) * 2; d.vy = fling?.y ?? 1; }
  }

  /** 'casualties/total' as far as the player can know: people of still-concealed rooms are left out, with '+?' while any room is walled up */
  get readout() {
    let pop = 0, dead = 0, unseen = false;
    for (const r of this.rooms.list) if (r.hidden) { pop += r.spawnPop; dead += r.dead; unseen = true; }
    return `${this.casualties - dead}/${this.total - pop}${unseen ? '+?' : ''}`;
  }

  /** burning blocks this frame (centre and half extents), gathered once per update */
  private fires: { x: number; y: number; hw: number; hh: number }[] = [];

  /** how much fire is around this person or prop (0..1, roughly the share of the room alight) and where it is, or null */
  private fireIn(d: Dweller): { frac: number; x: number } | null {
    let lit = 0, x = 0;
    for (const f of this.fires) {
      // within ~1 m sideways and overlapping the room height (floor below to ceiling above)
      if (Math.abs(f.x - d.x) < f.hw + 1 && f.y + f.hh > d.y - 0.6 && f.y - f.hh < d.y + 2) { lit++; x += f.x; }
    }
    return lit ? { frac: Math.min(1, lit / 3), x: x / lit } : null;
  }

  /** people in a burning room run for the far end; smoke and heat kill some; a ground-floor room lets them out */
  private panic(d: Dweller, fire: { frac: number; x: number }, dt: number) {
    const p = d.pace;
    if (d.act !== 'panic') { d.act = 'panic'; this.dropLadder(d); }
    p.wait = 0;
    p.speed = 1.8;
    p.dir = d.x < fire.x ? -1 : 1;
    p.face = p.dir;
    p.goal = p.dir < 0 ? p.x0 : p.x1;
    if (Math.random() < dt * (0.06 + 0.3 * fire.frac)) { this.kill(d); return; }
    const atEnd = p.dir < 0 ? d.x <= p.x0 + 0.1 : d.x >= p.x1 - 0.1;
    const low = d.y - this.g.groundY(d.x) < 0.8;
    if (atEnd && low) {
      // out of the back door and away from the fire
      d.state = 'fled';
      d.deadT = 0;
      d.vx = p.dir * 1.8;
      this.fled++;
    }
  }

  /** furniture in a burning room catches, chars, flickers, and helps the fire across the room */
  private burnProp(d: Dweller, dt: number) {
    if (d.char >= 1) return;
    d.char = Math.min(1, d.char + dt / 12);
    const mat = (d.mesh as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (mat?.color) mat.color.setScalar(1 - 0.7 * d.char);
    const g = this.g;
    if (d.char < 0.85 && Math.random() < dt * 8) {
      g.r.flame.spawn({ x: d.x + (Math.random() - 0.5) * 0.6, y: d.y + Math.random() * d.h * 0.8, vx: g.wind * 0.3, vy: 1.2 + Math.random(), max: 0.5, size0: 0.45, size1: 0.1,
        c0: [1.4, 0.75, 0.15], c1: [0.75, 0.16, 0.03], a0: 0.95, a1: 0, drag: 1 });
    }
    // a burning cot or rack is a fire against the walls and the floor it stands on
    if (d.char > 0.15 && d.char < 0.85) {
      for (const b of d.deps) if (b.mat.flammable && b.burning <= 0 && Math.random() < dt * 0.05) g.ignite(b);
      if (d.floor && d.floor.mat.flammable && d.floor.burning <= 0 && Math.random() < dt * 0.05) g.ignite(d.floor);
    }
  }

  /** blast at (x,y): people inside the radius die, furniture is thrown; a concealed room it goes off in is broken open */
  blast(x: number, y: number, r: number) {
    this.rooms.blast(x, y, r);
    for (const d of this.list) {
      if (d.state === 'dead' || d.state === 'fled') continue;
      const dist = Math.hypot(d.x - x, d.y + 0.6 - y);
      if (dist > r * 1.1) continue;
      const k = (1 - dist / (r * 1.1)) * 9;
      const fling = { x: ((d.x - x) / (dist || 1)) * k, y: Math.abs((d.y - y) / (dist || 1)) * k + 2 };
      if (d.person) this.kill(d, fling);
      else { d.state = 'falling'; d.vx = fling.x; d.vy = fling.y; d.fallFrom = d.y; }
    }
  }

  /** a person who landed alive rides the block (or ground) under them from now on */
  private standUp(d: Dweller, on: Block | null) {
    d.state = 'home';
    d.vx = 0; d.vy = 0;
    d.floor = on;
    d.deps = on ? [on] : [];
    d.home = d.deps.map((b) => { const t = b.body.translation(); return { x: t.x, y: t.y }; });
    if (d.room) { d.room.pop--; d.room = null; }
    const half = on ? Math.max(0.3, on.w / 2 - 0.3) : 1.5;
    const cx = on ? on.body.translation().x : d.x;
    const face = Math.random() < 0.5 ? -1 : 1;
    d.pace = { x0: Math.min(d.x, cx - half), x1: Math.max(d.x, cx + half), dir: face, speed: 0.4 + Math.random() * 0.3, wait: 1.5 + Math.random() * 2, goal: d.x, face, turnAt: -1 };
    d.act = 'pace'; d.next = 'stand'; d.ladder = null; d.climb = null;
    this.toLocal(d);
    if (d.rig) { d.rig.deadT = -1; d.rig.update(0, d.x, d.y, 'stand'); }
  }

  /** a ladder this person was heading for is no longer their plan */
  private dropLadder(d: Dweller) {
    if (d.ladder && d.next === 'ladder' && !d.climb) {
      const dest = d.ladder.a === d.room ? d.ladder.b : d.ladder.a;
      dest.pop--;
    }
    if (d.next === 'ladder') d.next = 'stand';
    if (!d.climb) d.ladder = null;
  }

  /** what to do next, after a pause: stroll somewhere, go and sit by the furniture, or take a ladder */
  private decide(d: Dweller) {
    const p = d.pace, rm = d.room;
    const roll = Math.random();
    d.act = 'pace';
    d.next = 'stand';
    p.speed = 0.45 + Math.random() * 0.45;
    if (rm && rm.ladders.length && roll < 0.2 && !rm.burning && !rm.failed) {
      const l = rm.ladders[Math.floor(Math.random() * rm.ladders.length)];
      const dest = l.a === rm ? l.b : l.a;
      // never into a room that has failed, is on fire or is crowded
      if (!l.gone && !dest.failed && !dest.burning && dest.pop < 3) {
        d.ladder = l; d.next = 'ladder';
        dest.pop++;
        p.goal = this.roomX(l.a, l.x);
        return this.setDir(d);
      }
    }
    if (rm && rm.props.length && roll < 0.45) {
      const px = this.roomX(rm, rm.props[Math.floor(Math.random() * rm.props.length)]);
      p.goal = Math.min(p.x1, Math.max(p.x0, px + (Math.random() < 0.5 ? -0.45 : 0.45)));
      d.next = 'sit';
      return this.setDir(d);
    }
    // a stroll: somewhere else in the room, at least a short walk away
    const span = p.x1 - p.x0;
    if (span < 0.3) { p.goal = d.x; p.wait = 1 + Math.random() * 2; return; }
    let gx = p.x0 + Math.random() * span;
    if (Math.abs(gx - d.x) < 0.6) gx = d.x + (gx < d.x ? -1 : 1) * Math.min(span * 0.6, 1.2);
    p.goal = Math.min(p.x1, Math.max(p.x0, gx));
    this.setDir(d);
  }
  private setDir(d: Dweller) { const p = d.pace; p.dir = Math.sign(p.goal - d.x) || p.face; p.face = p.dir; }

  /** a room-relative x (settled at spawn) where that room's floor is now */
  private roomX(rm: RoomRT, x: number) {
    if (!rm.floor || rm.floor.dead) return x;
    return x + rm.floor.body.translation().x - rm.fx;
  }
  private roomY(rm: RoomRT) {
    if (!rm.floor || rm.floor.dead) return rm.y0;
    return rm.y0 + rm.floor.body.translation().y - rm.fy;
  }

  /** at the foot (or head) of the ladder: let go of the floor and climb */
  private startClimb(d: Dweller) {
    const l = d.ladder!, rm = d.room!;
    const up = l.a === rm;
    const dest = up ? l.b : l.a;
    if (l.gone || dest.failed || dest.burning) { this.dropLadder(d); d.pace.wait = 0.8 + Math.random(); return; }
    d.climb = { up, x: this.roomX(l.a, l.x), y1: this.roomY(dest) };
    d.act = 'climb';
    rm.pop--;
    d.floor = null; d.lx = d.x; d.ly = d.y;
  }

  /** step up or down the ladder; at the top (or bottom) move into the other room */
  private stepClimb(d: Dweller, dt: number) {
    const c = d.climb!, l = d.ladder!;
    const dest = c.up ? l.b : l.a;
    if (l.gone || l.a.failed || l.b.failed) {
      d.state = 'falling'; d.fallFrom = d.y; d.vx = 0; d.vy = 0;
      d.room = null; d.climb = null; d.ladder = null; dest.pop--;
      return;
    }
    d.x += Math.max(-dt, Math.min(dt, c.x - d.x));
    const dy = c.y1 - d.y, step = CLIMB_SPEED * dt;
    if (Math.abs(dy) > step) d.y += Math.sign(dy) * step;
    else {
      d.y = c.y1;
      d.room = dest; d.floor = dest.floor && !dest.floor.dead ? dest.floor : null;
      d.deps = dest.deps; d.home = dest.home;
      const sx = this.roomX(dest, 0);
      d.pace.x0 = dest.x0 + 0.35 + sx; d.pace.x1 = dest.x1 - 0.35 + sx;
      d.pace.wait = 0.6 + Math.random() * 1.2;
      d.pace.goal = d.x;
      d.act = 'pace'; d.next = 'stand'; d.climb = null; d.ladder = null;
      this.toLocal(d);
    }
    d.lx = d.x; d.ly = d.y;
    d.rig?.update(dt, d.x, d.y, 'climb');
  }

  /** off duty: walk to the goal, then stand about, squat, or take the ladder */
  private live(d: Dweller, dt: number) {
    const p = d.pace;
    if (d.act === 'panic') {
      const step = p.speed * dt;
      if (Math.abs(p.goal - d.x) > step) { d.lx += p.dir * step; this.fromLocal(d); }
      return;
    }
    if (p.wait > 0) {
      p.wait -= dt;
      // stood about long enough to look the other way
      if (p.turnAt > 0 && p.wait < p.turnAt) { p.face = -p.face; p.turnAt = -1; }
      if (p.wait <= 0) this.decide(d);
      return;
    }
    const step = p.speed * dt;
    const dx = p.goal - d.x;
    if (Math.abs(dx) > step && d.x + p.dir * step >= p.x0 - 0.05 && d.x + p.dir * step <= p.x1 + 0.05) {
      d.lx += p.dir * step;
      this.fromLocal(d);
      return;
    }
    // arrived (or reached the end of the room)
    if (d.next === 'ladder' && d.ladder) { this.startClimb(d); if (d.act === 'climb') return; }
    if (d.next === 'sit') { d.act = 'sit'; p.wait = 3 + Math.random() * 5; p.turnAt = -1; }
    else { d.act = 'pace'; p.wait = 0.8 + Math.random() * 3; p.turnAt = Math.random() < 0.4 ? p.wait * (0.3 + Math.random() * 0.4) : -1; }
    d.next = 'stand';
  }

  update(dt: number) {
    const g = this.g;
    this.fires.length = 0;
    for (const b of g.blocks) {
      if (b.dead || b.burning <= 0) continue;
      const t = b.body.translation();
      this.fires.push({ x: t.x, y: t.y, hw: b.w / 2, hh: b.h / 2 });
    }
    this.rooms.update(dt, this.fires);
    for (const d of this.list) {
      if (d.state === 'fled') {
        d.deadT += dt;
        d.x += d.vx * dt;
        d.rig?.update(dt, d.x, d.y, 'walk');
        d.rig?.fade(Math.max(0, 1 - d.deadT / 1.2));
        continue;
      }
      if (d.state === 'home' && d.act === 'climb') {
        this.stepClimb(d, dt);
        continue;
      }
      if (d.state === 'home') {
        // the room has failed if its frame moved or broke (rooms check their frames a few times a second)
        const failed = (d.floor && d.floor.dead) || (d.room ? d.room.failed : d.deps.some((b, i) => b.dead || Math.hypot(b.body.translation().x - d.home[i].x, b.body.translation().y - d.home[i].y) > 0.6));
        if (failed) {
          d.state = 'falling'; d.fallFrom = d.y;
          const v = d.floor && !d.floor.dead ? d.floor.body.linvel() : { x: 0, y: 0 };
          d.vx = v.x; d.vy = v.y;
          if (d.person) this.dropLadder(d);
          if (d.room && d.person) d.room.pop--;
          d.room = null;
        } else {
          const fire = this.fires.length ? this.fireIn(d) : null;
          if (d.person && fire) this.panic(d, fire, dt);
          // the fire has burnt out: calm down and get on with it
          else if (d.person && d.act === 'panic') { d.act = 'pace'; d.pace.wait = 2 + Math.random() * 2; d.pace.speed = 0.5; }
          if (d.state !== 'home') continue;
          if (!d.person && fire) this.burnProp(d, dt);
          if (d.person) this.live(d, dt);
          const rot = this.fromLocal(d);
          // a steep tilt throws people off their feet
          if (Math.abs(rot) > 0.5) { d.state = 'falling'; d.fallFrom = d.y; if (d.person) this.dropLadder(d); if (d.room && d.person) d.room.pop--; d.room = null; }
          if (d.rig) {
            const p = d.pace;
            const moving = p.wait <= 0 && Math.abs(p.goal - d.x) > 0.02;
            // squatting by the furniture, or cowering at the end of a burning room
            d.rig.update(dt, d.x, d.y, moving ? 'walk' : d.act === 'sit' || d.act === 'panic' ? 'sit' : 'stand');
            d.rig.group.scale.x = (p.face > 0 ? -1 : 1) * 0.92; d.rig.group.rotation.z = rot;
          } else this.place(d, rot);
          continue;
        }
      }
      // falling or dead: simple ballistic body down to whatever is below
      d.vy -= 9.81 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      let ground = g.groundY(d.x);
      let on: Block | null = null;
      g.world.intersectionsWithPoint({ x: d.x, y: d.y - 0.05 }, (c) => {
        const o = g.owners.get(c.handle);
        if (o?.t === 'block' && !o.b.dead) { ground = Math.max(ground, d.y); on = o.b; return false; }
        return true;
      });
      if (d.y <= ground) {
        d.y = ground;
        if (d.state === 'falling' && d.person && d.fallFrom - d.y > 1.8) this.kill(d);
        d.vx *= 0.5; d.vy = 0;
      }
      if (d.state === 'dead') {
        d.deadT += dt;
        d.rig?.update(dt, d.x, d.y, 'dead');
        if (d.deadT > 6) { d.rig?.fade(Math.max(0, 1 - (d.deadT - 6) / 2)); }
      } else if (d.rig) {
        d.rig.update(dt, d.x, d.y, 'dead');
        // survived a short fall: get up and keep pacing on whatever they landed on
        const flat = !on || Math.abs((on as Block).body.rotation()) < 0.5;
        if (d.vy === 0 && Math.abs(d.vx) < 0.2 && flat) this.standUp(d, on);
      } else {
        this.place(d, d.mesh.rotation.z + d.vx * dt * 0.5);
      }
    }
    // crushed by moving masonry
    for (const b of g.blocks) {
      if (b.dead || b.body.isSleeping()) continue;
      const v = b.body.linvel();
      if (v.x * v.x + v.y * v.y < 6) continue;
      const t = b.body.translation();
      for (const d of this.list) if (d.person && d.state !== 'dead' && d.state !== 'fled' && Math.abs(d.x - t.x) < b.w / 2 + 0.25 && d.y + 1.2 > t.y - b.h / 2 && d.y < t.y + b.h / 2) this.kill(d);
    }
    this.list = this.list.filter((d) => { if ((d.state === 'dead' && d.deadT > 8) || (d.state === 'fled' && d.deadT > 1.2)) { d.mesh.parent?.remove(d.mesh); return false; } return true; });
  }
}
