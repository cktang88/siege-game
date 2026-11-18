import type { Game } from './game';
import { SET } from './settings';

/*
  The field camera: decides what the view frames each frame and eases it there.

  Why it used to zoom out too far: the overview was sized to the whole fortress (up to 115 m wide, so a
  soldier was ~18 px tall at 1600x900), a shell in flight widened the view to contain its whole arc
  (a high lob could double the view), Q/Ctrl+wheel allowed another 2x on top, and the ground line was only
  lifted above the fire-control panel at the gun's own height, so the valley in front of the redoubt,
  where the infantry halt and fire, sat lower and ended up under the panel and the rack.

  Now:
  - width limits come from the screen (soldiers stay readable): the overview spans at most
    clamp(screen px / 16, 64, 110) m, transients (aircraft, shells) may widen it by 30%, manual zoom out
    stops at 1.5x of it, and zoom in at 16 m;
  - the ground along the whole view is kept above whatever bottom plate (fire-control panel, rack) covers
    that part of the screen: the plates are measured and the view's bottom is solved against each column;
  - a threat-aware director picks the framing: (1) ground troops and vehicles near the gun frame tightly
    with the gun; (2) enemy aircraft coming at the gun widen the view to bring them in, then let it ease
    back; (3) otherwise the gun-and-castle overview, with the player's own pan and zoom, plus the round in
    flight. Entering a mode needs the condition for a moment and leaving it needs it gone for longer
    (hysteresis), and the view moves on a critically damped spring (~0.6 s to settle).
  - any manual pan, zoom or scroll hands the camera to the player for 8 s (auto-framing of threats and
    aircraft is suspended; shell-follow stays); R re-centres and hands it straight back. The auto-camera
    setting turns the director off altogether.
*/

export type CamMode = 'base' | 'threat' | 'air';

const SMOOTH = 0.2; // spring time constant, s
/**
  How close attackers must be before the camera drops everything for them. Infantry halt to fire 13–20 m
  in front of the gun (Soldier.stopX), so the radius never drops below 22 m; castle fronts stand 27–35 m
  out, so it scales to ~70% of that gap, which keeps men just leaving the castle from tripping it.
  Leaving takes 5 m more (hysteresis).
*/
const THREAT_MAX = 27, THREAT_MIN = 22, THREAT_HYST = 5;
const MANUAL_HOLD = 8;

interface Rect { left: number; right: number; top: number; bottom: number }

/** critically damped spring step (Game Programming Gems 4, "smooth damp") */
function damp(cur: number, target: number, vel: { v: number }, smooth: number, dt: number) {
  const o = 2 / smooth, x = o * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const ch = cur - target;
  const tmp = (vel.v + o * ch) * dt;
  vel.v = (vel.v - o * tmp) * e;
  return target + (ch + tmp) * e;
}

export class FieldCamera {
  mode: CamMode = 'base';
  /** short text for the on-screen cue while a mode other than the overview is framing */
  cue = '';
  /** seconds left of the player's manual control */
  manualT = 0;
  private threatT = 0; private threatGone = 0;
  private airT = 0; private airGone = 0;
  private last = { pan: 0, panY: 0, zoom: 1 };
  private vel = { h: { v: 0 }, x: { v: 0 }, y: { v: 0 } };
  /** bottom plates (screen rects), re-measured every 20 frames */
  plates: Rect[] = [];
  /** top plates (objectives, instruments, minimap, dev panel) */
  tops: Rect[] = [];
  private poll = 0;
  private frameTop = -Infinity;
  private frameKey: unknown = null;

  constructor(private g: Game) {}

  /** R: back to the default view and to automatic framing */
  recenter() {
    const g = this.g;
    g.zoom = 1; g.pan = 0; g.panY = 0;
    this.manualT = 0;
    this.last = { pan: 0, panY: 0, zoom: 1 };
  }

  reset() { this.mode = 'base'; this.cue = ''; this.manualT = 0; this.threatT = this.airT = 0; this.threatGone = this.airGone = 99; this.last = { pan: 0, panY: 0, zoom: 1 }; this.poll = 0; }

  /** the widest overview (m) at this screen size: a soldier stays about 21 px tall or more */
  spanCap() { return Math.max(64, Math.min(110, this.g.r.width / 16)); }

  private measure(force: boolean) {
    if (!force && --this.poll > 0) return;
    this.poll = 20;
    const hud = document.getElementById('hud');
    const out: Rect[] = [];
    if (hud && !hud.classList.contains('hidden')) {
      for (const q of ['#fcp', '#rack']) {
        const el = document.querySelector(q);
        const rc = el?.getBoundingClientRect();
        if (rc && rc.height > 0 && rc.width > 0) out.push({ left: rc.left, right: rc.right, top: rc.top, bottom: rc.bottom });
        if (q === '#fcp' && rc && rc.height < 50) this.poll = 1; // filled in on the HUD's first frame: measure again soon
      }
    }
    this.plates = out;
    this.tops = [];
    if (hud && !hud.classList.contains('hidden')) {
      for (const q of ['#hud-left', '#hud-right', '#minimap']) {
        const rc = document.querySelector(q)?.getBoundingClientRect();
        if (rc && rc.height > 0 && rc.width > 0) this.tops.push({ left: rc.left, right: rc.right, top: rc.top, bottom: rc.bottom });
      }
    }
  }

  /** fraction of the screen height covered from the bottom at screen x (bottom plates only) */
  private occAt(sx: number) {
    const H = this.g.r.height;
    let f = 0;
    for (const p of this.plates) if (sx >= p.left - 8 && sx <= p.right + 8) f = Math.max(f, (H - p.top) / H);
    return f;
  }

  /** fraction of the screen height covered from the top at screen x (top plates) */
  private occTopAt(sx: number) {
    const H = this.g.r.height;
    let f = 0;
    for (const p of this.tops) if (sx >= p.left - 8 && sx <= p.right + 8) f = Math.max(f, p.bottom / H);
    return Math.min(0.45, f);
  }

  /** ground units within `d` m in front of (or on) the gun */
  threats(d: number) {
    const g = this.g, cx = g.level.cannonX;
    const pts: { x: number; y: number }[] = [];
    for (const s of g.soldiers) if (!s.dead && !s.eng && s.x < cx + d && s.x > cx - 16) pts.push({ x: s.x, y: s.y + 1.4 });
    for (const u of g.motor.units) if (u.wreckT < 0 && u.x < cx + d && u.x > cx - 16) pts.push({ x: u.x, y: u.y + 2.4 });
    return pts;
  }

  /** enemy aircraft bearing on the gun (in the air, within ~75 m) */
  aircraft() {
    const g = this.g, cx = g.level.cannonX;
    const pts: { x0: number; x1: number; y: number }[] = [];
    for (const u of g.air.units) if (!u.down && !u.dead && u.x > cx - 40 && u.x < cx + 75) pts.push({ x0: u.x - u.rx - 3, x1: u.x + u.rx + 3, y: u.y + u.ry + 3 });
    return pts;
  }

  frame(snap: boolean, dt: number) {
    const g = this.g, r = this.r;
    this.measure(snap);
    if (snap) this.reset();
    const aspect = r.width / r.height;
    const fb = g.fortressBounds;
    const cap = this.spanCap();
    const gunX = g.level.cannonX;
    const x0 = gunX - 5;
    const ground = Math.min(g.groundY(gunX), g.groundY(fb.x0));

    // the player's hand on the camera
    if (g.pan !== this.last.pan || g.panY !== this.last.panY || g.zoom !== this.last.zoom) this.manualT = MANUAL_HOLD;
    else this.manualT = Math.max(0, this.manualT - dt);
    const auto = SET.autoCam && this.manualT <= 0;

    // ── which framing: hysteresis on entering and leaving each mode
    const gap = Math.max(0, fb.x0 - gunX);
    const threatIn = Math.max(THREAT_MIN, Math.min(THREAT_MAX, gap * 0.7));
    const near = this.threats(this.mode === 'threat' ? threatIn + THREAT_HYST : threatIn);
    if (near.length) { this.threatT += dt; this.threatGone = 0; } else { this.threatGone += dt; this.threatT = 0; }
    const air = this.aircraft();
    if (air.length) { this.airT += dt; this.airGone = 0; } else { this.airGone += dt; this.airT = 0; }
    let mode: CamMode = 'base';
    if (auto) {
      const threatOn = this.mode === 'threat' ? this.threatGone < 1.5 : this.threatT > 0.6 || snap && near.length > 0;
      const airOn = this.mode === 'air' || this.mode === 'threat' ? this.airGone < 1.2 : this.airT > 0.25;
      mode = threatOn ? 'threat' : airOn ? 'air' : 'base';
    }
    this.mode = mode;
    this.cue = mode === 'threat' ? (near.some((p) => p.y - g.groundY(p.x) > 2) ? 'Armour at the gun' : 'Infantry at the gun') : mode === 'air' ? 'Aircraft inbound' : '';

    // ── the frame: a span [fx0, fx1] that must be on screen and a height `top` that should be
    let fx0 = x0, fx1: number, top: number;
    let maxW = cap * 1.3, minW = 16;
    if (snap || this.frameKey !== g.level) {
      this.frameKey = g.level;
      this.frameTop = -Infinity;
      for (const b of g.level.blocks) if (b.x + b.w / 2 < x0 + cap) this.frameTop = Math.max(this.frameTop, b.y + b.h);
    }
    // the overview: the gun and the near works (pan, zoom or use the minimap for the rest)
    const ox1 = Math.max(x0 + 16 * aspect, Math.min(x0 + cap, Math.max(fb.x1 + 4, ...g.level.houses.filter((h) => h.x < fb.x1 + 10).map((h) => h.x + h.w + 1))));
    const vh0 = Math.max(16, (ox1 - x0) / aspect, Math.min(40, (fb.y1 - g.groundY(fb.x0)) * 1.7));
    const ow = Math.min(cap, vh0 * aspect);
    const otop = ground + Math.min(this.frameTop - ground + vh0 * 0.18, vh0 * 0.8);
    g.baseCx = x0 + ow / 2;
    // the overview's pan stops with the view centre between the gun and the far end of the works
    g.pan = Math.max(x0 - g.baseCx, Math.min(Math.max(x0 + ow, fb.x1 + 8) - g.baseCx, g.pan));
    // the zoom can't wind past the width limits (else the wheel would first have to unwind it)
    g.zoom = Math.max(ow / (cap * 1.5), Math.min(ow / 16, g.zoom));
    if (mode === 'threat') {
      // tight on the gun and the men or vehicles in front of it (wider for a far one)
      const tight = Math.max(40, cap * 0.5);
      fx1 = Math.max(x0 + tight, ...near.map((p) => p.x + 6));
      top = Math.max(ground + 8, ...near.map((p) => p.y + 3));
      // an aircraft right over the gun widens it just enough
      for (const a of air) if (a.x0 < gunX + 30) { fx0 = Math.min(fx0, a.x0); fx1 = Math.max(fx1, a.x1); top = Math.max(top, a.y); }
      minW = tight;
    } else if (mode === 'air') {
      fx1 = x0 + ow; top = otop;
      for (const a of air) { fx0 = Math.min(fx0, a.x0); fx1 = Math.max(fx1, a.x1); top = Math.max(top, a.y); }
    } else {
      // the player's zoom and pan apply to the overview
      const w = ow / g.zoom, c = g.baseCx + g.pan;
      fx0 = c - w / 2; fx1 = c + w / 2;
      top = ground + (otop - ground) / g.zoom;
      maxW = cap * 1.5;
    }
    // the player's own round (or bomber, drone, saboteur) in flight
    const f = g.focus;
    if (f) { fx0 = Math.min(fx0, f.x - 6); fx1 = Math.max(fx1, f.x + 6); top = Math.max(top, f.y + 5); }

    // ── width within the limits; if the frame is wider than allowed keep the focus (or the gun) in view
    let w = Math.max(minW, Math.min(maxW, fx1 - fx0));
    let cx = (fx0 + fx1) / 2;
    if (fx1 - fx0 > w) {
      const keep = f ? f.x : gunX;
      cx = Math.max(keep - w / 2 + 7, Math.min(keep + w / 2 - 7, cx));
    }
    // ── height: solve the view's bottom so that the ground in every column clears the plate over it
    let vh = w / aspect;
    let bottom = 0;
    const maxH = maxW / aspect;
    for (let it = 0; it < 2; it++) {
      const left = cx - (vh * aspect) / 2;
      bottom = ground - 0.1 * vh;
      let need = vh;
      for (let i = 0; i <= 48; i++) {
        const x = left + ((vh * aspect) * i) / 48;
        const occ = Math.min(0.45, this.occAt((i / 48) * r.width) + (this.plates.length ? 0.035 : 0));
        const gy = g.groundY(x);
        bottom = Math.min(bottom, gy - Math.max(0.1, occ) * vh);
        need = Math.max(need, (top - gy) / (1 - Math.max(0.1, occ)));
      }
      vh = Math.min(maxH, Math.max(vh, need));
    }
    // (re-solve the bottom at the final height)
    const solveBottom = (h: number) => {
      const left = cx - (h * aspect) / 2;
      let b = ground - 0.1 * h;
      for (let i = 0; i <= 48; i++) {
        const occ = Math.min(0.45, this.occAt((i / 48) * r.width) + (this.plates.length ? 0.035 : 0));
        b = Math.min(b, g.groundY(left + ((h * aspect) * i) / 48) - Math.max(0.1, occ) * h);
      }
      return b;
    };
    bottom = solveBottom(vh);
    // aircraft being framed must clear the top plates (objectives, instruments, minimap) over their column
    if (mode !== 'base') {
      for (let it = 0; it < 3 && vh < maxH; it++) {
        let deficit = 0;
        for (const a of air) {
          const ax = (a.x0 + a.x1) / 2;
          const sx = ((ax - cx) / (vh * aspect) + 0.5) * r.width;
          if (sx < 0 || sx > r.width) continue;
          const occT = this.occTopAt(sx) + 0.03;
          deficit = Math.max(deficit, (a.y - (bottom + vh * (1 - occT))) / Math.max(0.3, 1 - occT - 0.2));
        }
        if (deficit <= 0.05) break;
        vh = Math.min(maxH, vh + deficit);
        bottom = solveBottom(vh);
      }
    }
    let cy = bottom + vh / 2;
    if (mode === 'base') cy += g.panY;

    this.last = { pan: g.pan, panY: g.panY, zoom: g.zoom };

    if (snap) { r.viewH = vh; r.cx = cx; r.cy = cy; this.vel.h.v = this.vel.x.v = this.vel.y.v = 0; return; }
    const st = mode === 'base' && !f ? SMOOTH * 1.4 : SMOOTH;
    r.viewH = damp(r.viewH, vh, this.vel.h, st, dt);
    r.cx = damp(r.cx, cx, this.vel.x, st, dt);
    r.cy = damp(r.cy, cy, this.vel.y, st, dt);
  }

  private get r() { return this.g.r; }
}
