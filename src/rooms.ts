import * as THREE from 'three';
import { MATERIALS, type MatId, type TargetKind } from './config';
import type { Block, Game } from './game';
import type { LevelDef } from './levels';
import { blockGeometry, makeBlockMaterial, makeLadder } from './render';

/*
  Runtime rooms: where each room really stands after the frame settled, whether it has failed or is
  burning (checked a few times a second, not per person per frame), the ladders between storeys and
  the covers over concealed rooms.

  A concealed room (LevelDef rooms[].hidden, chosen per level in src/conceal.ts) is walled over by a
  panel in the material of its own frame, drawn in front of the room's furniture, people and target.
  The panel comes off, crumbling to dust, when:
   - a scout drone passes within its scan radius (Rooms.scan, called from the drone loop),
   - a block framing or inside the room is destroyed or knocked out of place,
   - an explosion goes off in the room (Rooms.blast, via Garrison.blast),
   - fire breaks out in it.
  The first time each room is uncovered there is a toast naming what was inside.
*/

type V2 = { x: number; y: number };
export type RoomInfo = NonNullable<LevelDef['rooms']>[number];

export interface Ladder { a: RoomRT; b: RoomRT; x: number; mesh: THREE.Mesh; gone: boolean }

interface Cover { mesh: THREE.Mesh; uni: Record<string, THREE.IUniform>; mark: THREE.ShaderMaterial; mat: MatId; fade: number; cx: number; cy: number }

/*
  A cover must hide the room but still read as infill, not structure: it is darker than the frame,
  sits back between the columns (an inset shadow under the lintel and along both jambs) and carries a
  faint diagonal hatch, the map-maker's mark for ground that has not been surveyed.
*/
const markFrag = /* glsl */ `
uniform vec2 uSize; uniform float uFade; varying vec2 vUv;
void main(){
  vec2 p = vUv * uSize;
  float dTop = uSize.y - p.y, dSide = min(p.x, uSize.x - p.x), dBot = p.y;
  // set back between the jambs: shadow under the lintel and down both sides
  float inset = 0.6 * (1.0 - smoothstep(0.0, 0.3, dTop)) + 0.45 * (1.0 - smoothstep(0.0, 0.2, dSide)) + 0.2 * (1.0 - smoothstep(0.0, 0.1, dBot));
  // unsurveyed-ground hatch
  float h = fract((p.x + p.y) / 0.42);
  float hatch = (1.0 - smoothstep(0.035, 0.07, abs(h - 0.5))) * 0.34;
  vec4 col = vec4(0.07, 0.06, 0.08, clamp(inset + hatch, 0.0, 0.8));
  // dashed survey line just inside the opening
  float e = min(min(dTop, dBot), dSide);
  float along = (dSide < min(dTop, dBot)) ? p.y : p.x;
  float line = (1.0 - smoothstep(0.03, 0.055, abs(e - 0.16))) * step(0.5, fract(along / 0.36));
  col = mix(col, vec4(0.93, 0.78, 0.42, 0.85), line);
  gl_FragColor = vec4(col.rgb, col.a * uFade);
}`;
const markVert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export interface RoomRT {
  i: number;
  def: RoomInfo;
  floor: Block | null;
  deps: Block[];
  /** where the deps came to rest (failure = any moved > 0.6 m or died) */
  home: V2[];
  /** every block framing (columns, slab below, slab above) or inside the room */
  bound: Block[];
  boundHome: V2[];
  /** blocks standing inside the room (targets, stores) */
  inside: Block[];
  target: Block | null;
  /** settled world bounds of the interior */
  x0: number; x1: number; y0: number; y1: number;
  /** floor body position at spawn (rooms follow their floor's drift) */
  fx: number; fy: number;
  failed: boolean;
  burning: boolean;
  ladders: Ladder[];
  /** x of standing furniture (people sit by them) */
  props: number[];
  /** people living here now (climbers count where they are heading) */
  pop: number;
  /** people found here at the start, and how many of them have died */
  spawnPop: number;
  dead: number;
  hidden: boolean;
  cover: Cover | null;
}

const COVER_Z = 4.3;
const COVERABLE: MatId[] = ['stone', 'wood', 'concrete', 'steel', 'fireproof', 'plaster', 'earth'];

export class Rooms {
  list: RoomRT[] = [];
  ladders: Ladder[] = [];
  /** block → hidden room it stands inside (for tooltips, labels and the minimap) */
  private insideOf = new Map<Block, RoomRT>();
  private checkT = 0;
  private announceT = 0;
  /** rooms uncovered since the last toast, and what found them */
  private found: { r: RoomRT; by: 'drone' | 'breach' | 'fire' }[] = [];
  /** bumped whenever a cover comes off (HUD readouts can watch it) */
  version = 0;
  /** how many rooms started concealed */
  concealed = 0;

  constructor(private g: Game) {}

  clear() {
    for (const r of this.list) r.cover?.mesh.parent?.remove(r.cover.mesh);
    for (const l of this.ladders) l.mesh.parent?.remove(l.mesh);
    this.list = []; this.ladders = []; this.insideOf.clear(); this.found = [];
    this.version = 0; this.concealed = 0; this.checkT = 0;
  }

  build(level: LevelDef, root: THREE.Group, R: () => number) {
    this.clear();
    const g = this.g;
    const live = g.blocks.filter((b) => !b.dead).map((b) => { const t = b.body.translation(); return { b, t, x0: t.x - b.w / 2, x1: t.x + b.w / 2, y0: t.y - b.h / 2, y1: t.y + b.h / 2 }; });
    (level.rooms ?? []).forEach((def, i) => {
      const floor = def.floorIdx >= 0 ? g.blocks[def.floorIdx] ?? null : null;
      const deps = def.deps.map((k) => g.blocks[k]).filter(Boolean);
      // the frame settles (up to ~0.6 m at the top of a keep) before anyone moves in
      let sx = 0, sy = 0, fx = 0, fy = 0;
      if (floor && !floor.dead) {
        const t = floor.body.translation(), fd = floor.def;
        sx = t.x - (fd.x + fd.w / 2); sy = t.y - (fd.y + fd.h / 2); fx = t.x; fy = t.y;
      }
      const x0 = def.x0 + sx, x1 = def.x1 + sx, y0 = def.y0 + sy, y1 = def.y1 + sy;
      const bound: Block[] = [], inside: Block[] = [];
      for (const q of live) {
        if (q.x1 < x0 - 0.12 || q.x0 > x1 + 0.12 || q.y1 < y0 - 0.12 || q.y0 > y1 + 0.12) continue;
        bound.push(q.b);
        if (q.t.x > x0 && q.t.x < x1 && q.t.y > y0 && q.t.y < y1) inside.push(q.b);
      }
      const r: RoomRT = {
        i, def, floor, deps, home: deps.map((b) => { const t = b.body.translation(); return { x: t.x, y: t.y }; }),
        bound, boundHome: bound.map((b) => { const t = b.body.translation(); return { x: t.x, y: t.y }; }),
        inside, target: inside.find((b) => b.target) ?? null,
        x0, x1, y0, y1, fx, fy, failed: false, burning: false, ladders: [], props: [], pop: 0, spawnPop: 0, dead: 0, hidden: !!def.hidden, cover: null,
      };
      this.list.push(r);
    });
    this.buildLadders(level, root, R);
    for (const r of this.list) if (r.hidden) { this.addCover(r, root); this.concealed++; }
  }

  /** ladders between a room and the one stacked directly above it (same column of the frame) */
  private buildLadders(level: LevelDef, root: THREE.Group, R: () => number) {
    const kind = level.era === 'modern' ? 'steel' : 'wood';
    const rooms = this.list;
    for (const a of rooms) {
      if (a.x1 - a.x0 < 1.6) continue;
      const b = rooms.find((u) => u !== a && u.def.floorIdx >= 0 && u.y0 - a.y1 > -0.05 && u.y0 - a.y1 < 1.2 && Math.min(a.x1, u.x1) - Math.max(a.x0, u.x0) > 1.4);
      // a ladder never leads from an open room into a concealed one (that would give it away)
      if (!b || b.hidden !== a.hidden || b.x1 - b.x0 < 1.6) continue;
      if (R() > 0.5) continue;
      const ov0 = Math.max(a.x0, b.x0), ov1 = Math.min(a.x1, b.x1);
      // a side clear of targets and stores in both rooms
      const clash = (x: number) => [...a.inside, ...b.inside].reduce((s, q) => {
        const t = q.body.translation();
        return s + (Math.abs(t.x - x) < q.w / 2 + 0.35 ? (q.target ? 10 : 1) : 0);
      }, 0);
      const cands = [ov0 + 0.45, ov1 - 0.45].sort(() => R() - 0.5);
      const x = cands.reduce((best, c) => (clash(c) < clash(best) ? c : best));
      if (clash(x) >= 10) continue;
      const h = b.y0 - a.y0 + 1.05;
      const mesh = makeLadder(h, kind);
      mesh.position.set(x, a.y0, 2.8);
      root.add(mesh);
      const l: Ladder = { a, b, x, mesh, gone: false };
      a.ladders.push(l); b.ladders.push(l);
      this.ladders.push(l);
    }
  }

  /** a wall panel in the frame's own material over the room's cutaway */
  private addCover(r: RoomRT, root: THREE.Group) {
    const count = new Map<MatId, number>();
    for (const b of r.deps) {
      const m = (b.def.disguise ?? b.def.mat) as MatId;
      if (COVERABLE.includes(m)) count.set(m, (count.get(m) ?? 0) + (b === r.floor ? 0.5 : 1));
    }
    let mat: MatId = 'stone', best = 0;
    for (const [m, n] of count) if (n > best) { best = n; mat = m; }
    const M = MATERIALS[mat];
    // a hair wider than the opening so no sliver of the room shows at the columns
    const w = r.x1 - r.x0 + 0.04, h = r.y1 - r.y0 + 0.04;
    const geo = blockGeometry(w, h);
    const sm = makeBlockMaterial(M.color.map((c) => c * 0.84) as [number, number, number], w, h, M.kind, geo);
    const mesh = new THREE.Mesh(geo, sm);
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    mesh.position.set(cx, cy, COVER_Z);
    const mark = new THREE.ShaderMaterial({ vertexShader: markVert, fragmentShader: markFrag, transparent: true, depthWrite: false,
      uniforms: { uSize: { value: new THREE.Vector2(w, h) }, uFade: { value: 1 } } });
    const ov = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mark);
    ov.position.z = 0.02; ov.renderOrder = 1;
    mesh.add(ov);
    root.add(mesh);
    r.cover = { mesh, uni: sm.uniforms, mark, mat, fade: 1, cx, cy };
  }

  /** the material a block appears to be, if it is walled up in a concealed room */
  coverMat(b: Block): MatId | null {
    const r = this.insideOf.get(b);
    return r && r.hidden ? r.cover?.mat ?? 'stone' : null;
  }
  /** this block (usually a target) is out of sight in a concealed room */
  conceals(b: Block) { return !!this.insideOf.get(b)?.hidden; }

  /** called after build: remember which blocks are walled up */
  index() {
    this.insideOf.clear();
    for (const r of this.list) if (r.hidden) for (const b of r.inside) this.insideOf.set(b, r);
  }

  private moved(bs: Block[], home: V2[], tol: number) {
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (b.dead) return true;
      const t = b.body.translation();
      if (Math.abs(t.x - home[i].x) > tol || Math.abs(t.y - home[i].y) > tol) return true;
    }
    return false;
  }

  uncover(r: RoomRT, by: 'drone' | 'breach' | 'fire') {
    if (!r.hidden) return;
    r.hidden = false;
    this.version++;
    this.found.push({ r, by });
    if (by === 'drone') this.announceT = 1;
    for (const b of r.inside) this.insideOf.delete(b);
    if (r.target) this.g.events.push({ type: 'target', kind: r.target.target as TargetKind });
    const c = r.cover;
    if (!c) return;
    // dust and a few chips of the panel as it crumbles away
    const g = this.g, col = new THREE.Color(...MATERIALS[c.mat].color);
    const p = c.mesh.position, w = r.x1 - r.x0, h = r.y1 - r.y0;
    for (let i = 0; i < 8; i++) g.r.smoke.spawn({ x: p.x + (Math.random() - 0.5) * w, y: p.y + (Math.random() - 0.5) * h, vx: (Math.random() - 0.5) * 0.6, vy: 0.3 + Math.random() * 0.4, max: 1.6, size0: 0.8, size1: 2.4, c0: [0.62, 0.58, 0.52], c1: [0.7, 0.68, 0.64], a0: 0.55, a1: 0, drag: 1.2 });
    for (let i = 0; i < 10; i++) g.r.debris.spawn(p.x + (Math.random() - 0.5) * w, p.y + (Math.random() - 0.3) * h, (Math.random() - 0.5) * 2, Math.random() * 1.5, 0.08 + Math.random() * 0.14, col.clone().multiplyScalar(0.7 + Math.random() * 0.4));
  }

  /**
   * Block `old` split into `pieces` (src/fracture.ts); `heir` carries its role, `ot` is where `old` stood.
   * Frames, floors and contents follow the pieces (home = where the piece would be had the old block
   * not drifted), so a split member still fails the room once it moves; a split in the frame of a
   * concealed room breaks it open.
   */
  relink(old: Block, pieces: Block[], heir: Block | null, ot: V2) {
    const homeOf = (p: Block, h: V2) => { const t = p.body.translation(); return { x: t.x - (ot.x - h.x), y: t.y - (ot.y - h.y) }; };
    const swap = (list: Block[], homes: V2[] | null) => {
      const i = list.indexOf(old);
      if (i < 0) return false;
      const h = homes ? homes[i] : null;
      list.splice(i, 1); homes?.splice(i, 1);
      for (const p of pieces) { list.push(p); if (homes && h) homes.push(homeOf(p, h)); }
      return true;
    };
    for (const r of this.list) {
      if (r.floor === old) {
        // the piece under the middle of the room, else the heir
        const cx = (r.x0 + r.x1) / 2;
        let best = heir, bd = Infinity;
        for (const p of pieces) { const t = p.body.translation(); const d = Math.abs(t.x - cx) - p.w / 2; if (d < bd) { bd = d; best = p; } }
        if (best) {
          const bt = best.body.translation();
          // keep the room's drift continuous: fx/fy is where the floor body stood when the room settled
          r.fx = bt.x - (ot.x - r.fx); r.fy = bt.y - (ot.y - r.fy);
        }
        r.floor = best;
      }
      swap(r.deps, r.home);
      const framed = swap(r.bound, r.boundHome);
      swap(r.inside, null);
      if (r.target === old) r.target = heir && heir.target ? heir : null;
      if (framed && r.hidden) this.uncover(r, 'breach');
    }
    const room = this.insideOf.get(old);
    if (room) { this.insideOf.delete(old); if (room.hidden) for (const p of pieces) this.insideOf.set(p, room); }
  }

  /** a scout drone at (x, y) sees into rooms within its radius (looking down: twice as far below as across) */
  scan(x: number, y: number, radius: number) {
    for (const r of this.list) {
      if (!r.hidden) continue;
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      const dx = Math.max(0, Math.abs(cx - x) - (r.x1 - r.x0) / 2), dy = cy - y;
      if (Math.hypot(dx, dy < 0 ? dy * 0.5 : dy) < radius) this.uncover(r, 'drone');
    }
  }

  /** an explosion at (x, y) breaks open any concealed room it goes off in */
  blast(x: number, y: number, radius: number) {
    const m = Math.min(1.2, radius * 0.5);
    for (const r of this.list) {
      if (r.hidden && x > r.x0 - m && x < r.x1 + m && y > r.y0 - m && y < r.y1 + m) this.uncover(r, 'breach');
    }
  }

  update(dt: number, fires: { x: number; y: number; hw: number; hh: number }[]) {
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.1;
      for (const r of this.list) {
        if (!r.failed) r.failed = (!!r.floor && r.floor.dead) || this.moved(r.deps, r.home, 0.6);
        let burning = false;
        for (const f of fires) {
          if (f.x + f.hw > r.x0 - 0.05 && f.x - f.hw < r.x1 + 0.05 && f.y + f.hh > r.y0 - 0.05 && f.y - f.hh < r.y1 + 0.05) { burning = true; break; }
        }
        r.burning = burning;
        if (r.hidden) {
          if (burning) this.uncover(r, 'fire');
          else if (r.failed || this.moved(r.bound, r.boundHome, 0.35)) this.uncover(r, 'breach');
        }
      }
      for (const l of this.ladders) {
        if (l.gone || !(l.a.failed || l.b.failed)) continue;
        l.gone = true;
        l.mesh.visible = false;
      }
    }
    // covers ride their floor (a sagging storey takes its wall panel with it) and crumble away once found
    for (const r of this.list) {
      const c = r.cover;
      if (!c) continue;
      if (r.floor && !r.floor.dead) {
        const t = r.floor.body.translation();
        c.mesh.position.x = c.cx + t.x - r.fx; c.mesh.position.y = c.cy + t.y - r.fy;
      }
      if (!r.hidden) {
        c.fade = Math.max(0, c.fade - dt * 1.4);
        c.uni.uFade.value = c.fade;
        c.mark.uniforms.uFade.value = c.fade;
        c.uni.uDamage.value = Math.min(1, (1 - c.fade) * 2.2);
        if (c.fade <= 0) { c.mesh.parent?.remove(c.mesh); c.mesh.geometry.dispose(); (c.mesh.children[0] as THREE.Mesh | undefined)?.geometry.dispose(); c.mark.dispose(); r.cover = null; }
      }
    }
    // a drone sweeping in finds rooms one after another: tell of them together once it has settled
    this.announceT -= dt;
    if (this.found.length && this.announceT <= 0) this.announce();
  }

  /** one toast per batch of rooms found: what was in them */
  private announce() {
    const found = this.found;
    this.found = [];
    const what = (r: RoomRT) => {
      const k = r.target?.target;
      if (k === 'ammo') return 'magazine';
      if (k === 'command') return 'command post';
      if (k === 'barracks') return 'barracks';
      if (k === 'workshop') return 'workshop';
      if (k === 'depot') return 'motor pool';
      if (k) return 'emplacement';
      if (r.spawnPop > 0) return 'guardroom';
      if (r.inside.some((b) => b.def.mat === 'crate')) return 'storeroom';
      return 'room';
    };
    const names: string[] = found.map((f) => what(f.r));
    const order = ['magazine', 'command post', 'barracks', 'workshop', 'motor pool', 'emplacement', 'guardroom', 'storeroom', 'room'];
    const key = order.find((n) => names.includes(n)) ?? 'room';
    const by = found[0].by;
    const text = found.length > 1
      ? `${by === 'drone' ? 'Drone intel: ' : ''}${found.length} hidden rooms uncovered${key !== 'room' ? `, including a ${key}` : ''}.`
      : by === 'drone' ? `Drone intel: hidden ${key} uncovered.` : by === 'fire' ? `Fire exposes a hidden ${key}.` : `Hidden ${key} uncovered.`;
    const important = found.some((f) => f.r.target && this.g.level.objectives.includes(f.r.target.target as TargetKind));
    this.g.toast(text, important ? 'good' : 'info');
  }

  /** a live target of this kind can be seen (or at least one exists out of sight) */
  unknownKind(kind: TargetKind) {
    const live = this.g.blocks.filter((b) => !b.dead && b.target === kind);
    return live.length > 0 && live.every((b) => this.conceals(b));
  }
}
