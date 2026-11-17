import * as THREE from 'three';
import type { Block, Game, Soldier } from './game';
import { EngineerRig, type Era, type Tool } from './engrig';
import { Scaffold, planScaffold } from './scaffold';
import { audio } from './audio';
import { TARGETS } from './config';

/*
  The enemy repair crew (docs/RESEARCH.md, "Siege repair & scaffolding").

  While the engineers' workshop stands, it keeps a crew of 2-4 men in the field (more at higher
  difficulty). They come out of the workshop (down the garrison's ladders where its room has a way
  down, then along the ground), and take one cracked block at a time, the lowest first (the old rules:
  only cracked blocks still in place, not burning, not rubble, not objectives; nothing destroyed is
  ever rebuilt). For each job they first put up a scaffold beside or across the block (src/scaffold.ts),
  then each takes a station: on the ground or on a working lift, reached up the scaffold's ladder. They
  bring material up from the stack at the foot (a hod of mortar, a cement sack), work it in with hammer
  or trowel until it is used up, and go down for more. The block only mends while a man is at work at
  it: more hands are faster, with diminishing returns. When it is made good they strike the scaffold
  and move on.

  They are infantry as far as the guns are concerned: they live in Game.soldiers (flagged `eng`, so
  the infantry loop leaves them to this module), so blasts, shot, canister and falling masonry kill
  them, and they count as garrison casualties. They run from fire. A scaffold blown down throws the men
  on it; a fall of more than ~2.2 m kills. With the whole crew down the job waits until the workshop
  sends replacements (one every ~20 s); with the workshop destroyed the survivors pack up and leave.
*/

type On = 'ground' | 'abs' | 'scaf';
interface WP { x: number; y: number; on: On; climb?: boolean }
type Goal = 'foot' | 'pile' | 'spot' | 'rally' | 'leave' | 'flee' | 'none';

interface Eng {
  s: Soldier;
  rig: EngineerRig;
  path: WP[];
  goal: Goal;
  on: On;
  /** scaffold-local position while on the scaffold */
  lx: number; ly: number;
  mode: 'go' | 'idle' | 'build' | 'pick' | 'work' | 'fall' | 'dead' | 'frozen';
  station: number; spot: number;
  face: number;
  supply: number;
  carrying: boolean;
  vx: number; vy: number; fallFrom: number;
  counted: boolean;
  t: number;
  /** seconds since spawn (fades in at the workshop door) */
  age: number;
  rallyX: number;
  gone: boolean;
}

const WALK = 1.35, CARRY_WALK = 1.05, CLIMB = 0.95;
/** repair per second at full crew effect, as a share of max HP (the old crew's 2.8%/s, with time lost to fetching) */
const RATE = 0.034;
/** hands at work → effect: 0.6, 0.96, 1.18, 1.31 */
const crewEffect = (n: number) => 0.6 * (1 - 0.6 ** n) / 0.4;

export class Crew {
  list: Eng[] = [];
  job: Block | null = null;
  scaf: Scaffold | null = null;
  fallen: Scaffold[] = [];
  size = 2;
  private spawnQ = 0;
  private spawnT = 0;
  private replT = 20;
  private started = false;
  private toastJob = false;
  private wiped = false;
  private sndT = 0;
  private label: HTMLElement | null = null;
  /** repaired HP this battle (for labs) */
  mended = 0;

  constructor(private g: Game) {}

  /** the castle's era picks the kit; hand-built levels without one count as modern if built of concrete or steel */
  get era(): Era {
    const L = this.g.level;
    if (!L) return 'medieval';
    if (L.era) return L.era;
    return L.blocks.some((b) => b.mat === 'concrete' || b.mat === 'steel' || b.mat === 'reactive') ? 'modern' : 'medieval';
  }
  get alive() { return this.list.filter((e) => !e.s.dead && !e.gone); }
  /** men at work at the block right now */
  get working() { return this.list.filter((e) => !e.s.dead && e.mode === 'work').length; }

  clear() {
    for (const s of [this.scaf, ...this.fallen]) s?.dispose();
    this.list = []; this.job = null; this.scaf = null; this.fallen = [];
    this.started = false; this.toastJob = false; this.wiped = false; this.spawnQ = 0; this.spawnT = 0; this.replT = 20; this.mended = 0;
    this.label?.remove(); this.label = null;
  }

  /** a block the crew may take on (the old repair rules, and no fire right beside it) */
  ok(b: Block) {
    return !b.dead && !b.mat.indestructible && b.burning <= 0 && b.hp < b.maxHp * 0.97 && b.hp > b.maxHp * 0.15 && !b.target
      && !this.g.frac.isRubble(b)
      && Math.abs(b.body.rotation()) < 0.08 && Math.hypot(b.body.linvel().x, b.body.linvel().y) < 0.05;
  }
  private fireNear(x0: number, x1: number, y0: number, y1: number, r: number) {
    for (const q of this.g.blocks) {
      if (q.dead || q.burning <= 0) continue;
      const t = q.body.translation();
      const dx = Math.max(x0 - (t.x + q.w / 2), 0, t.x - q.w / 2 - x1), dy = Math.max(y0 - (t.y + q.h / 2), 0, t.y - q.h / 2 - y1);
      if (Math.hypot(dx, dy) < r) return q;
    }
    return null;
  }

  // ───────────────────────── spawning ─────────────────────────
  /** a new engineer at a live workshop: down its room's ladders if there is a way, else at its door on the ground */
  spawn() {
    const g = this.g;
    const shops = g.liveTargets('workshop');
    if (!shops.length) return null;
    const w = shops[Math.floor(Math.random() * shops.length)];
    const t = w.body.translation();
    const path: WP[] = [];
    let x = t.x + (Math.random() - 0.5) * Math.min(1, w.w * 0.6), y = g.groundY(x);
    let on: On = 'ground';
    const rooms = g.garrison.rooms.list;
    const home = rooms.find((r) => !r.failed && (r.target === w || r.inside.includes(w)));
    if (home && home.y0 - g.groundY((home.x0 + home.x1) / 2) > 0.6) {
      // breadth-first down the ladders to a ground-floor room
      const prev = new Map<typeof home, { from: typeof home; x: number } | null>([[home, null]]);
      const q = [home];
      let exit: typeof home | null = null;
      while (q.length && !exit) {
        const r = q.shift()!;
        for (const l of r.ladders) {
          const n = l.a === r ? l.b : l.a;
          if (l.gone || n.failed || n.burning || prev.has(n)) continue;
          prev.set(n, { from: r, x: l.x });
          if (n.y0 - g.groundY((n.x0 + n.x1) / 2) < 0.6) { exit = n; break; }
          q.push(n);
        }
      }
      if (exit) {
        const chain: { r: typeof home; x: number }[] = [];
        for (let r: typeof home | undefined = exit; r && prev.get(r); r = prev.get(r)!.from) chain.unshift({ r, x: prev.get(r)!.x });
        x = Math.min(home.x1 - 0.4, Math.max(home.x0 + 0.4, t.x + (Math.random() - 0.5)));
        y = home.y0; on = 'abs';
        let cur = home;
        for (const c of chain) {
          path.push({ x: c.x, y: cur.y0, on: 'abs' }, { x: c.x, y: c.r.y0, on: 'abs', climb: true });
          cur = c.r;
        }
        // out of the end of the ground-floor room nearest the front, onto the ground
        const out = cur.x0 - 0.2;
        path.push({ x: out, y: cur.y0, on: 'abs' }, { x: out - 0.6, y: 0, on: 'ground' });
      }
    }
    const tool: Tool = this.list.length % 2 ? 'trowel' : 'hammer';
    const rig = new EngineerRig(this.era, tool);
    rig.group.scale.setScalar(0.92);
    rig.group.position.z = 3.5;
    g.root.add(rig.group);
    const s: Soldier = { x, y, rig, dead: false, shootT: 0, stopX: -1e9, phase: 0, deadT: 0, shield: 0, eng: true };
    g.soldiers.push(s);
    g.garrison.total++;
    const e: Eng = {
      s, rig, path, goal: 'none', on, lx: 0, ly: 0, mode: path.length ? 'go' : 'idle', station: -1, spot: -1, face: -1, supply: 0, carrying: false,
      vx: 0, vy: 0, fallFrom: y, counted: false, t: 0.3 + Math.random() * 0.5, age: 0, rallyX: path.length ? path[path.length - 1].x : x - 0.8 - Math.random(), gone: false,
    };
    rig.pose(0, x, y, 'stand', 'idle', false);
    rig.fade(0);
    this.list.push(e);
    this.wiped = false;
    return e;
  }

  // ───────────────────────── jobs ─────────────────────────
  private startJob(b: Block) {
    const g = this.g;
    this.job = b;
    this.scaf = new Scaffold(g, b, planScaffold(g, b, this.era), this.era);
    for (const e of this.alive) { e.station = -1; e.spot = -1; if (e.mode !== 'fall') this.rethink(e); }
    if (!this.toastJob) {
      this.toastJob = true;
      g.toast('Enemy engineers are putting up scaffolding to patch a cracked wall. Shoot the crew or knock out their workshop.', 'info');
    }
  }

  private endJob() {
    this.job = null;
    if (this.scaf) {
      // a steel or timber scaffold left without a crew stands until someone comes to strike it
      if (this.scaf.state === 'build' && this.scaf.progress <= 0.001) { this.scaf.dispose(); this.scaf = null; }
      else this.scaf.strike();
    }
    for (const e of this.alive) { e.station = -1; e.spot = -1; if (e.mode === 'work' || e.mode === 'pick') { e.mode = 'idle'; e.t = 0; } }
  }

  /** knock the scaffold down: the men on it fall */
  private collapse(from: { x: number; y: number } | null, k: number, burning = false) {
    const sc = this.scaf;
    if (!sc || !sc.standing) return;
    for (const e of this.list) {
      if (e.s.dead || e.gone || e.on !== 'scaf') continue;
      const high = e.ly - sc.plan.base > 0.2;
      e.on = 'ground'; e.path = []; e.goal = 'none';
      if (high) {
        e.mode = 'fall'; e.fallFrom = e.s.y;
        e.vx = from ? Math.sign(e.s.x - from.x) * 1.5 * k : (Math.random() - 0.5); e.vy = 1 + Math.random() * k;
      } else { e.mode = 'idle'; e.t = 0.5; }
      e.station = -1; e.spot = -1;
    }
    sc.collapse(from, k, burning);
    this.fallen.push(sc);
    this.scaf = null;
    this.audio('crumble', (sc.bx0 + sc.bx1) / 2, 0.4);
  }

  /** a blast at (x, y) of radius r (Game.explode): a scaffold within reach comes down */
  blast(x: number, y: number, r: number) {
    const sc = this.scaf;
    if (!sc || !sc.standing || r <= 0) return;
    if (sc.dist(x, y) < r * 0.75 + 0.2) this.collapse({ x, y }, Math.min(2, 0.6 + r / 3));
  }

  // ───────────────────────── movement ─────────────────────────
  private toScaf(e: Eng) { const sc = this.scaf!; e.lx = e.s.x - sc.ox; e.ly = e.s.y - sc.oy; e.on = 'scaf'; }

  /** plan a path to a ground x, or to a station spot on the scaffold */
  private route(e: Eng, to: { x: number } | { station: number; spot: number } | 'pile' | 'foot') {
    const sc = this.scaf;
    const p = sc?.plan;
    e.path = [];
    let tgt: { scaf: boolean; x: number; h: number };
    if (to === 'pile' || to === 'foot') tgt = { scaf: false, x: p!.pileX + (to === 'foot' ? (p!.pileX < p!.ladderX ? 0.55 : -0.55) : 0) + (Math.random() - 0.5) * 0.3, h: 0 };
    else if ('station' in to) { const st = p!.stations[to.station]; tgt = { scaf: true, x: st.spots[to.spot].x, h: st.h }; }
    else tgt = { scaf: false, x: to.x, h: 0 };
    // off the scaffold first, by its ladder
    if (e.on === 'scaf' && sc && sc.standing) {
      const y = p!.base + tgt.h;
      if (tgt.scaf && Math.abs(e.ly - y) < 0.05) { e.path.push({ x: tgt.x, y, on: 'scaf' }); return; }
      if (e.ly - p!.base > 0.05) e.path.push({ x: p!.ladderX, y: e.ly, on: 'scaf' }, { x: p!.ladderX, y: p!.base, on: 'scaf', climb: true });
    }
    if (tgt.scaf && sc) {
      if (tgt.h > 0) {
        e.path.push({ x: sc.wx(p!.ladderX), y: 0, on: 'ground' }, { x: p!.ladderX, y: p!.base + tgt.h, on: 'scaf', climb: true }, { x: tgt.x, y: p!.base + tgt.h, on: 'scaf' });
      } else e.path.push({ x: sc.wx(tgt.x), y: 0, on: 'ground' });
    } else e.path.push({ x: sc && (to === 'pile' || to === 'foot') ? sc.wx(tgt.x) : tgt.x, y: 0, on: 'ground' });
  }

  private go(e: Eng, goal: Goal, to: Parameters<Crew['route']>[1]) {
    e.goal = goal; e.mode = 'go';
    this.route(e, to);
  }

  /** what this man should be doing now */
  private rethink(e: Eng) {
    const sc = this.scaf;
    if (sc && sc.standing) {
      const footX = sc.wx(sc.plan.pileX) + (sc.plan.pileX < sc.plan.ladderX ? 0.55 : -0.55);
      const atFoot = e.on !== 'scaf' && Math.abs(e.s.x - footX) < 0.6;
      if (sc.state !== 'up' || !this.job) {
        if (atFoot) { e.mode = 'build'; e.path = []; e.goal = 'none'; }
        else this.go(e, 'foot', 'foot');
        return;
      }
      if (e.station < 0) this.assign(e);
      if (!e.carrying) {
        const atPile = e.on !== 'scaf' && Math.abs(e.s.x - sc.wx(sc.plan.pileX)) < 0.45;
        if (atPile) { e.mode = 'pick'; e.t = 0.7; e.path = []; e.face = sc.wx(sc.plan.pileX) < e.s.x ? -1 : 1; }
        else this.go(e, 'pile', 'pile');
      } else this.go(e, 'spot', { station: e.station, spot: e.spot });
      return;
    }
    // nothing to do: wait by the way out of the workshop
    if (Math.abs(e.s.x - e.rallyX) > 0.4 || e.on === 'scaf') this.go(e, 'rally', { x: e.rallyX });
    else { e.mode = 'idle'; e.t = 1 + Math.random(); e.path = []; }
  }

  /** a free station spot, spreading the crew over the lifts before doubling up */
  private assign(e: Eng) {
    const st = this.scaf!.plan.stations;
    const used = new Set(this.alive.filter((q) => q !== e && q.station >= 0).map((q) => `${q.station}|${q.spot}`));
    for (let sp = 0; sp < 3; sp++) for (let i = 0; i < st.length; i++) {
      if (sp < st[i].spots.length && !used.has(`${i}|${sp}`)) { e.station = i; e.spot = sp; return; }
    }
    e.station = 0; e.spot = st[0].spots.length - 1;
  }

  private arrive(e: Eng) {
    const sc = this.scaf;
    const goal = e.goal;
    e.goal = 'none';
    if (goal === 'spot' && sc && sc.built && this.job && e.station >= 0) {
      e.mode = 'work';
      e.supply = 7 + Math.random() * 4;
      e.carrying = false;
      e.face = sc.plan.stations[e.station].spots[e.spot].face;
      return;
    }
    if (goal === 'leave') { e.mode = 'idle'; e.t = 0; e.gone = true; return; }
    if (goal === 'flee') { e.mode = 'idle'; e.t = 2.5 + Math.random() * 2; return; }
    e.mode = 'idle'; e.t = 0;
    this.rethink(e);
  }

  /** one step along the path; true while still moving */
  private step(e: Eng, dt: number) {
    const g = this.g, s = e.s, sc = this.scaf;
    const wp = e.path[0];
    if (!wp) return false;
    if (wp.on === 'scaf' && !(sc && sc.standing)) { e.path = []; return false; }
    if (wp.on === 'scaf' && e.on !== 'scaf') this.toScaf(e);
    if (wp.on !== 'scaf' && e.on === 'scaf') { e.on = wp.on; s.y = wp.on === 'ground' ? g.groundY(s.x) : wp.y; }
    if (wp.on === 'abs') e.on = 'abs';
    const v = (e.carrying ? CARRY_WALK : WALK) * (e.goal === 'flee' ? 1.6 : 1);
    let done = false;
    if (wp.climb) {
      const cs = CLIMB * (e.goal === 'flee' ? 1.5 : 1) * dt;
      if (e.on === 'scaf') {
        e.lx += Math.max(-dt * 2, Math.min(dt * 2, wp.x - e.lx));
        const dy = wp.y - e.ly;
        if (Math.abs(dy) > cs) e.ly += Math.sign(dy) * cs; else { e.ly = wp.y; done = Math.abs(wp.x - e.lx) < 0.02; }
      } else {
        s.x += Math.max(-dt * 2, Math.min(dt * 2, wp.x - s.x));
        const dy = wp.y - s.y;
        if (Math.abs(dy) > cs) s.y += Math.sign(dy) * cs; else { s.y = wp.y; done = Math.abs(wp.x - s.x) < 0.02; }
      }
    } else {
      const cx = e.on === 'scaf' ? e.lx : s.x;
      const dx = wp.x - cx, st = v * dt;
      const nx = Math.abs(dx) > st ? cx + Math.sign(dx) * st : wp.x;
      if (Math.abs(dx) > 0.01) e.face = Math.sign(dx);
      done = Math.abs(dx) <= st;
      if (e.on === 'scaf') { e.lx = nx; e.ly = wp.y; } else { s.x = nx; s.y = e.on === 'ground' ? g.groundY(nx) : wp.y; }
    }
    if (done) e.path.shift();
    return true;
  }

  // ───────────────────────── update ─────────────────────────
  /** active: the workshop stands and the enemy's timers run */
  update(dt: number, active: boolean) {
    const g = this.g;
    const shop = g.liveTargets('workshop').length > 0;
    const frozen = shop && !active;
    this.sndT -= dt;
    if (active && !this.started) {
      this.started = true;
      const d = g.level.difficulty ?? 0;
      this.size = Math.min(4, 2 + (d >= 3 ? 1 : 0) + (d >= 6 ? 1 : 0));
      this.spawnQ = this.size;
      this.spawnT = 0;
    }
    if (active) {
      // the first crew comes out one by one; losses are made good slowly
      this.spawnT -= dt;
      if (this.spawnQ > 0 && this.spawnT <= 0) { this.spawnQ--; this.spawnT = 1.1; this.spawn(); }
      const n = this.alive.length;
      if (this.spawnQ <= 0 && n < this.size) { this.replT -= dt; if (this.replT <= 0) { this.replT = 20; this.spawn(); } }
      else this.replT = Math.max(this.replT, 8);
      if (n === 0 && this.list.length && this.spawnQ <= 0 && !this.wiped) {
        this.wiped = true;
        g.toast('Repair crew down. The workshop will send more engineers.', 'good');
      }
    }
    if (!shop && (this.job || this.list.some((e) => !e.s.dead && !e.gone && e.goal !== 'leave'))) {
      // the workshop is gone: the job is dropped and the crew packs up and leaves the field
      if (this.job) this.endJob();
      if (this.scaf && this.scaf.state === 'strike') this.scaf.state = 'up';
      const fb = g.fortressBounds;
      for (const e of this.alive) if (e.goal !== 'leave' && e.mode !== 'fall') { e.carrying = false; this.go(e, 'leave', { x: fb.x1 + 3 + Math.random() * 2 }); }
    }

    // the job: still worth doing, and the scaffold rides with it
    if (this.job && !frozen) {
      const b = this.job;
      if (b.dead) {
        const h = b.heir;
        if (h && this.ok(h) && this.scaf) { this.scaf.rebind(h); this.job = h; }
        else { this.collapse(null, 0.6); this.job = null; }
      } else if (!this.ok(b)) {
        // knocked loose: the scaffold goes with it; otherwise (made good, or alight) it is struck
        const v = b.body.linvel();
        if (Math.abs(b.body.rotation()) > 0.15 || Math.hypot(v.x, v.y) > 0.6) this.collapse({ x: b.body.translation().x, y: b.body.translation().y }, 0.5);
        this.endJob();
      }
    }
    const sc = this.scaf;
    if (sc && sc.standing) {
      const r = sc.bounds();
      // fire beside it: the crew drops the job; a timber scaffold catches and burns down
      const fire = this.fireNear(r.x0, r.x1, r.y0, r.y1, 0.6);
      if (fire) {
        if (this.job) this.endJob();
        if (sc.timber && sc.burnT < 0) sc.burnT = 1.6;
      }
      if (sc.burnT >= 0) {
        sc.burnT -= dt;
        if (Math.random() < dt * 6) g.r.flame.spawn({ x: r.x0 + Math.random() * (r.x1 - r.x0), y: r.y0 + Math.random() * (r.y1 - r.y0) * 0.6, vx: g.wind * 0.3, vy: 1.2, max: 0.6, size0: 0.4, size1: 0.1, c0: [1.4, 0.75, 0.15], c1: [0.75, 0.16, 0.03], a0: 0.95, a1: 0, drag: 1 });
        if (sc.burnT <= 0) this.collapse(null, 0.4, true);
      }
    }
    if (this.scaf && this.scaf.standing) {
      const r = this.scaf.bounds();
      // a round through it, or masonry falling into it, brings it down
      for (const p of g.projectiles) {
        if (p.dead || p.x < r.x0 - 0.1 || p.x > r.x1 + 0.1 || p.y < r.y0 || p.y > r.y1 + 0.1) continue;
        const v = p.body && !p.body.isSleeping() ? p.body.linvel() : { x: p.vx, y: p.vy };
        if (v.x * v.x + v.y * v.y > 64) { this.collapse({ x: p.x - v.x * 0.05, y: p.y - v.y * 0.05 }, 1.1); break; }
      }
    }
    if (this.scaf && this.scaf.standing) {
      const r = this.scaf.bounds();
      for (const b of g.blocks) {
        if (b.dead || b.body.isSleeping()) continue;
        const v = b.body.linvel();
        if (v.x * v.x + v.y * v.y < 6) continue;
        const t = b.body.translation();
        if (t.x + b.w / 2 > r.x0 && t.x - b.w / 2 < r.x1 && t.y - b.h / 2 < r.y1 && t.y + b.h / 2 > r.y0) { this.collapse({ x: t.x, y: t.y + b.h / 2 }, 0.9); break; }
      }
    }

    // the scaffold for the job in hand was knocked down: put up a new one
    if (active && this.job && !this.scaf && this.alive.length) {
      this.scaf = new Scaffold(g, this.job, planScaffold(g, this.job, this.era), this.era);
      for (const e of this.alive) { e.station = -1; e.spot = -1; if (e.mode !== 'fall' && e.goal !== 'flee') this.rethink(e); }
    }
    // a new job: the lowest cracked block, once the last scaffold is down and someone is there to do it
    if (active && !this.job && !this.scaf && this.alive.length) {
      g.repT -= dt;
      if (g.repT <= 0) {
        g.repT = 4;
        let best: Block | null = null, by = Infinity;
        for (const b of g.blocks) {
          if (!this.ok(b)) continue;
          const t = b.body.translation();
          if (this.fireNear(t.x - b.w / 2, t.x + b.w / 2, t.y - b.h / 2, t.y + b.h / 2, 1.5)) continue;
          const y = t.y - b.h / 2;
          if (y < by - 0.05) { by = y; best = b; }
        }
        if (best) this.startJob(best);
      }
    }

    // fires this frame, for the men to run from
    const fires: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const b of g.blocks) {
      if (b.dead || b.burning <= 0) continue;
      const t = b.body.translation();
      fires.push({ x0: t.x - b.w / 2, x1: t.x + b.w / 2, y0: t.y - b.h / 2, y1: t.y + b.h / 2 });
    }

    let atFoot = 0, onScaf = 0, hands = 0;
    for (const e of this.list) {
      const s = e.s;
      if (s.dead) { this.dead(e, dt); continue; }
      if (e.gone) {
        // out of sight beyond the castle
        e.t += dt;
        s.rig.fade(Math.max(0, 1 - e.t / 0.8));
        e.rig.pose(dt, s.x, s.y, 'walk', 'swing', false);
        if (e.t > 0.8) { s.rig.group.parent?.remove(s.rig.group); g.soldiers = g.soldiers.filter((q) => q !== s); }
        continue;
      }
      e.age += dt;
      if (e.age < 0.7) s.rig.fade(Math.min(1, e.age / 0.6));
      else if (e.age - dt < 0.7) s.rig.fade(1);
      if (frozen) { this.pose(e, dt); continue; }
      if (e.mode === 'fall') { this.fall(e, dt); continue; }
      // fire: get away from it (down the ladder first), and it may kill a man caught right beside it
      const near = fires.find((f) => Math.max(f.x0 - s.x, 0, s.x - f.x1) < 1.3 && s.y + 1.4 > f.y0 - 0.2 && s.y < f.y1 + 0.3);
      if (near) {
        const d = Math.max(near.x0 - s.x, 0, s.x - near.x1);
        if (d < 0.35 && Math.random() < dt * 0.35) { g.killSoldier(s); this.dead(e, dt); continue; }
        if (e.goal !== 'flee') {
          const dir = s.x < (near.x0 + near.x1) / 2 ? -1 : 1;
          e.carrying = false; e.station = -1; e.spot = -1;
          this.go(e, 'flee', { x: s.x + dir * (5 + Math.random() * 2) });
        }
      }
      if (e.path.length) {
        e.mode = 'go';
        this.step(e, dt);
        if (!e.path.length) this.arrive(e);
      } else if (e.mode === 'work') {
        if (!this.job || !this.scaf || !this.scaf.built) { e.mode = 'idle'; e.t = 0; }
        else {
          e.supply -= dt;
          if (e.supply > 0) hands++;
          else this.rethink(e);
        }
      } else if (e.mode === 'pick') {
        e.t -= dt;
        if (e.t <= 0) { e.carrying = true; e.mode = 'idle'; e.t = 0; this.rethink(e); }
      } else if (e.mode === 'build') {
        const want = this.scaf && this.scaf.standing && (this.scaf.state !== 'up' || !this.job);
        if (!want) this.rethink(e);
      } else {
        e.t -= dt;
        if (e.t <= 0) { e.t = 0.6; this.rethink(e); }
      }
      if (e.mode === 'build') atFoot++;
      if (e.on === 'scaf' && this.scaf && e.ly - this.scaf.plan.base > 0.2) onScaf++;
      if (e.on === 'scaf' && this.scaf) { s.x = e.lx + this.scaf.ox; s.y = e.ly + this.scaf.oy; }
      this.pose(e, dt);
    }

    // the scaffold goes up while someone is at its foot; it comes down once nobody is left on it
    if (this.scaf) {
      const sc = this.scaf;
      sc.update(dt, sc.state === 'strike' && onScaf > 0 ? 0 : atFoot);
      if (sc.state === 'gone') { this.scaf = null; g.repT = Math.max(g.repT, 2.5); for (const e of this.alive) if (e.mode === 'build') { e.mode = 'idle'; e.t = 0.3; } }
    }
    for (const f of this.fallen) f.update(dt, 0);
    this.fallen = this.fallen.filter((f) => !f.done);

    // the work itself: only hands at the block mend it
    if (this.job && hands > 0 && !frozen) {
      const b = this.job;
      const add = Math.min(b.maxHp - b.hp, b.maxHp * RATE * crewEffect(hands) * dt);
      b.hp += add;
      this.mended += add;
      if (b.hp >= b.maxHp * 0.97) this.endJob();
    }
    g.repairing = this.job;
    this.list = this.list.filter((e) => !(e.s.dead && e.s.deadT > 3.7) && !(e.gone && e.t > 0.8));
    this.updateLabel();
  }

  private pose(e: Eng, dt: number) {
    const s = e.s, rig = s.rig as EngineerRig;
    const wp = e.path[0];
    const climbing = !!wp?.climb;
    const moving = !!wp && e.mode === 'go';
    const legs = climbing ? 'climb' : moving ? 'walk' : e.mode === 'work' || e.mode === 'build' ? 'shoot' : e.mode === 'pick' ? 'sit' : 'stand';
    const arms = climbing ? 'climb' : moving ? 'swing' : e.mode === 'work' ? 'work' : e.mode === 'build' || e.mode === 'pick' ? 'build' : 'idle';
    rig.pose(dt, s.x, s.y, legs, arms, e.carrying);
    // on (or right at) the scaffold the men stand in front of the wall; elsewhere among the rooms, behind it
    const sc = this.scaf;
    const atScaf = e.on === 'scaf' || (!!sc && sc.standing && s.x > sc.bounds().x0 - 1.4 && s.x < sc.bounds().x1 + 1.4 && Math.abs(s.y - sc.stationY(0) + (sc.plan.stations[0].h)) < 0.4);
    rig.group.position.z = atScaf ? 4.6 : 3.5;
    rig.group.scale.x = (e.face > 0 ? -1 : 1) * 0.92;
    if (e.mode === 'work' && rig.struck) this.blow(e);
    if (e.mode === 'build' && rig.struck && this.sndT <= 0) { this.sndT = 0.35; this.audio(this.era === 'modern' ? 'clang' : 'thud', s.x, 0.12, 1.6); }
  }

  /** a hammer blow or a trowel stroke lands: mortar dust, chips, sparks only off steel */
  private blow(e: Eng) {
    const g = this.g, b = this.job;
    if (!b) return;
    const p = (e.s.rig as EngineerRig).toolHead();
    const col = new THREE.Color(...b.mat.color);
    const hammer = (e.s.rig as EngineerRig).tool === 'hammer';
    const dust = col.clone().lerp(new THREE.Color(0.86, 0.83, 0.76), 0.55);
    g.r.smoke.spawn({ x: p.x, y: p.y, vx: -e.face * (0.2 + Math.random() * 0.3), vy: 0.25 + Math.random() * 0.3, max: 0.8 + Math.random() * 0.4, size0: hammer ? 0.08 : 0.06, size1: hammer ? 0.36 : 0.24,
      c0: [dust.r, dust.g, dust.b], c1: [dust.r * 0.9, dust.g * 0.9, dust.b * 0.9], a0: hammer ? 0.45 : 0.3, a1: 0, drag: 2, windK: 0.3 });
    if (hammer) {
      for (let i = 0; i < 2; i++) g.r.debris.spawn(p.x, p.y, -e.face * (0.5 + Math.random()), 0.5 + Math.random() * 1.2, 0.035 + Math.random() * 0.035, col.clone().multiplyScalar(0.85 + Math.random() * 0.3));
      if (b.matId === 'steel' || b.matId === 'reactive') {
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * Math.PI - (e.face > 0 ? Math.PI : 0) * 0 + Math.PI * 0.1, v = 1.5 + Math.random() * 2.5;
          g.r.fire.spawn({ x: p.x, y: p.y, vx: -e.face * Math.abs(Math.cos(a)) * v, vy: Math.sin(a) * v, max: 0.18 + Math.random() * 0.15, size0: 0.06, size1: 0.02, c0: [3, 2.2, 1], c1: [2, 0.6, 0.1], a0: 1, a1: 0, grav: -12 });
        }
      }
    }
    if (this.sndT <= 0) {
      this.sndT = 0.12;
      this.audio(hammer ? (b.mat.flammable ? 'thud' : b.matId === 'steel' ? 'clang' : 'thud') : 'shovel', p.x, hammer ? 0.16 : 0.1, hammer ? 1.8 : 1.4);
    }
  }

  private audio(id: 'thud' | 'clang' | 'shovel' | 'crumble', x: number, gain = 0.3, pitch = 1) { audio.play(id, x, gain, pitch); }

  /** off the scaffold: falls until it lands; a long fall kills */
  private fall(e: Eng, dt: number) {
    const g = this.g, s = e.s;
    e.vy -= 9.81 * dt;
    s.x += e.vx * dt; s.y += e.vy * dt;
    const ground = this.landing(s.x, s.y);
    if (s.y <= ground) {
      s.y = ground;
      if (e.fallFrom - s.y > 2.2) { g.killSoldier(s); return; }
      e.mode = 'idle'; e.t = 1 + Math.random(); e.on = 'ground'; e.vx = 0; e.vy = 0;
      s.y = g.groundY(s.x) > ground - 0.05 ? g.groundY(s.x) : ground;
    }
    e.rig.pose(dt, s.x, s.y, 'walk', 'climb', false);
    s.rig.group.position.z = 4.6;
  }

  /** the ground, or the top of whatever block is under (x, y) */
  private landing(x: number, y: number) {
    const g = this.g;
    let ground = g.groundY(x);
    g.world.intersectionsWithPoint({ x, y: y - 0.05 }, (c) => {
      const o = g.owners.get(c.handle);
      if (o?.t === 'block' && !o.b.dead) { ground = Math.max(ground, y); return false; }
      return true;
    });
    return ground;
  }

  private dead(e: Eng, dt: number) {
    const g = this.g, s = e.s;
    if (!e.counted) {
      e.counted = true;
      g.garrison.casualties++;
      e.path = []; e.carrying = false; e.station = -1;
      if (e.on === 'scaf' || e.mode === 'fall') { e.vy = Math.max(e.vy, 0); e.mode = 'fall'; }
      e.on = 'ground';
    }
    // a man killed up on the scaffold drops off it
    const ground = this.landing(s.x, s.y);
    if (s.y > ground + 0.01) { e.vy -= 9.81 * dt; s.y = Math.max(ground, s.y + e.vy * dt); s.x += e.vx * dt; }
    s.deadT += dt;
    e.rig.pose(dt, s.x, s.y, 'dead', 'dead', false);
    if (s.deadT > 2.2) s.rig.fade(Math.max(0, 1 - (s.deadT - 2.2) / 1.5));
  }

  /** a small marker over the job while the crew is at it */
  private updateLabel() {
    const g = this.g, sc = this.scaf;
    const show = !!(this.job && sc && sc.standing && this.list.some((e) => !e.s.dead && (e.mode === 'work' || e.mode === 'build' || e.on === 'scaf')));
    if (typeof document === 'undefined') return;
    const box = document.getElementById('labels');
    if (!box) return;
    if (!show) { if (this.label) this.label.style.display = 'none'; return; }
    if (!this.label || !this.label.isConnected) {
      this.label?.remove();
      const el = document.createElement('div');
      el.className = 'tlabel';
      el.style.color = TARGETS.workshop.color;
      el.style.borderColor = TARGETS.workshop.color;
      el.style.fontSize = '9px';
      el.style.opacity = '0.85';
      el.textContent = 'Engineers at work';
      box.appendChild(el);
      this.label = el;
    }
    const r = sc!.bounds();
    const p = g.r.worldToScreen((r.x0 + r.x1) / 2, r.y1 + 0.35);
    this.label.style.display = '';
    this.label.style.left = `${p.x}px`;
    this.label.style.top = `${p.y}px`;
  }
}
