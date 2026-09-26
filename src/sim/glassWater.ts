// Water and snow on the player's windows (seen from the interior cameras):
// a small drop simulation on each pane, in glass-plane metres.
//
// Panes: 0 = windshield (u across, +u = car left; v up the glass from its
// base), 1 = left side windows, 2 = right side windows (u = car-local z,
// forward; v = height above the beltline).
//
// Rain lands at a rate that grows with speed. A drop starts to move when
// gravity + airflow beats its surface adhesion (big drops move first); a
// moving drop sticks and slips on dry glass, wanders, sheds small droplets
// and a wet trail, and swallows the drops it runs into. Wipers carry what
// they sweep and leave it at the end of the stroke and in a ridge along
// the outer edge of their arc. Snow flakes stick and clump; the defroster
// slowly melts them on the windshield; on the side windows the airflow
// occasionally drags them back or blows them off.

export const WIPE_PERIOD = 2.0;
export const WIPE_SWEEP = 1.2;
export const WIPE_MAX = 1.8; // radians
// Pivots and blade radial ranges (windshield metres); see car.wgsl.
export const WIPERS = [
  {pivot: [0.6, -0.04], r0: 0.14, r1: 0.8},
  {pivot: [-0.08, -0.04], r0: 0.12, r1: 0.7},
];

export function wiperAngle(t: number): number {
  const ph = t - Math.floor(t / WIPE_PERIOD) * WIPE_PERIOD;
  if (ph > WIPE_SWEEP) return 0;
  return Math.sin((ph / WIPE_SWEEP) * Math.PI) * WIPE_MAX;
}

export interface Pane {
  uMin: number;
  uMax: number;
  vMax: number;
}

export interface Drop {
  pane: number;
  u: number;
  v: number;
  r: number; // radius (m)
  snow: boolean;
  moving: boolean;
  hold: number; // seconds until it may move again (stick-slip)
  melt: number; // snow: seconds until it melts (windshield)
  phase: number; // wander
  du: number; // last motion (for stretching / trails)
  dv: number;
  fresh?: boolean; // landed this step (merge candidate)
}

export interface Trail {
  pane: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  w: number;
}

const MAX_DROPS = 6000;
const G = 9.8;

// Deterministic PRNG so the sim is reproducible in tests.
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class GlassWater {
  drops: Drop[] = [];
  trails: Trail[] = [];
  private rnd: () => number;
  private carry = [0, 0, 0];

  constructor(
    public panes: Pane[],
    seed = 1,
  ) {
    this.rnd = mulberry(seed);
  }

  reset() {
    this.drops = [];
    this.trails = [];
  }

  // Forces on a pane (m/s^2): gravity along the glass + airflow.
  private force(pane: number, u: number, speed: number): [number, number] {
    const air = speed * speed;
    if (pane === 0) {
      // Raked windshield: gravity down the glass; the airflow runs up and
      // spreads out toward the pillars.
      const W = this.panes[0].uMax;
      return [(u / W) * air * 0.009, -G * 0.55 + air * 0.02];
    }
    // Side windows: airflow drags drops backward (and a little down).
    return [-air * 0.022, -G * 0.95 - air * 0.002];
  }

  update(
    dt: number,
    t: number,
    speed: number,
    rain: number,
    snow: number,
    wipers: boolean,
  ) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.07);
    this.trails = [];
    const rnd = this.rnd;
    // ---- Deposition ----
    for (let p = 0; p < 3; ++p) {
      const ws = p === 0;
      const rateRain = rain * (ws ? 420 + speed * 60 : 50 + speed * 4);
      const rateSnow = snow * (ws ? 40 + speed * 9 : 30 + speed * 3);
      for (const [rate, isSnow] of [
        [rateRain, false],
        [rateSnow, true],
      ] as Array<[number, boolean]>) {
        this.carry[p] += rate * dt;
        while (this.carry[p] >= 1) {
          this.carry[p] -= 1;
          const pn = this.panes[p];
          const x = rnd();
          this.add({
            pane: p,
            u: pn.uMin + rnd() * (pn.uMax - pn.uMin),
            v: rnd() * pn.vMax,
            r: isSnow ? 0.002 + x * x * 0.004 : 0.0008 + x * x * 0.0024,
            snow: isSnow,
            moving: false,
            hold: 0,
            melt: isSnow && ws ? 1 + rnd() * 2 : 1e9,
            phase: rnd() * 100,
            du: 0,
            dv: 0,
          });
        }
      }
    }
    // ---- Motion ----
    for (const d of this.drops) {
      d.du = 0;
      d.dv = 0;
      if (d.snow) {
        d.melt -= dt;
        if (d.melt <= 0) {
          // The defroster melts it into a drop.
          d.snow = false;
          d.r *= 0.55;
          d.hold = 0.5;
        }
      }
      if (d.hold > 0) {
        d.hold -= dt;
        continue;
      }
      const [fu, fv] = this.force(d.pane, d.u, speed);
      const a = Math.hypot(fu, fv);
      // Adhesion: small drops (and snow) hold on.
      const grip = d.snow ? 0.06 : 0.012;
      const excess = a - grip / Math.max(d.r, 1e-4);
      if (d.snow && d.pane === 0) continue;
      if (excess <= 0) {
        d.moving = false;
        continue;
      }
      if (d.snow && rnd() < dt * 0.15 * (speed / 25)) {
        d.r = 0; // blown off
        continue;
      }
      d.moving = true;
      // Stick-slip: catch on dry glass now and then.
      if (rnd() < dt * (d.snow ? 3 : 1.6)) {
        d.hold = 0.05 + rnd() * (d.snow ? 1.2 : 0.5);
        continue;
      }
      const vmag = Math.min(0.45, 0.012 + excess * (d.snow ? 0.006 : 0.025));
      // Wander around the force direction.
      d.phase += dt * (2 + vmag * 20);
      const wob = Math.sin(d.phase) * 0.35 + Math.sin(d.phase * 2.7) * 0.15;
      const c = Math.cos(wob),
        s = Math.sin(wob);
      const nu = fu / a,
        nv = fv / a;
      const mu = (nu * c - nv * s) * vmag * dt,
        mv = (nu * s + nv * c) * vmag * dt;
      if (!d.snow)
        this.trails.push({
          pane: d.pane,
          u0: d.u,
          v0: d.v,
          u1: d.u + mu,
          v1: d.v + mv,
          w: d.r * 0.7,
        });
      d.u += mu;
      d.v += mv;
      d.du = mu / dt;
      d.dv = mv / dt;
      // Shed small droplets behind (volume is conserved).
      if (!d.snow && d.r > 0.0012 && rnd() < dt * 5) {
        const rr = d.r * (0.25 + rnd() * 0.15);
        d.r = Math.cbrt(d.r ** 3 - rr ** 3);
        this.add({
          ...d,
          u: d.u - mu * 3,
          v: d.v - mv * 3,
          r: rr,
          moving: false,
          hold: 0.5,
        });
      }
    }
    // ---- Wipers ----
    if (wipers) {
      const a0 = wiperAngle(t - dt),
        a1 = wiperAngle(t);
      if (a0 !== a1) {
        const lo = Math.min(a0, a1) - 0.002,
          hi = Math.max(a0, a1) + 0.002;
        const dir = Math.sign(a1 - a0);
        for (const d of this.drops) {
          if (d.pane !== 0) continue;
          for (const w of WIPERS) {
            const qu = d.u - w.pivot[0],
              qv = d.v - w.pivot[1];
            const r = Math.hypot(qu, qv);
            if (r < w.r0 - 0.01 || r > w.r1 + 0.01) continue;
            const th = Math.atan2(qv, -qu);
            if (th < lo || th > hi) continue;
            let nr = r,
              nth = th;
            if (r > w.r1 - 0.025 && rnd() < 0.6) {
              // Squeezed out past the blade tip: the ridge on the arc.
              nr = w.r1 + 0.004 + rnd() * 0.012;
            } else {
              // Carried in front of the blade.
              nth = a1 + dir * (0.006 + rnd() * 0.012);
            }
            d.u = w.pivot[0] - Math.cos(nth) * nr;
            d.v = w.pivot[1] + Math.sin(nth) * nr;
            d.hold = 0.25;
            d.moving = false;
          }
        }
      }
    }
    // ---- Merge, cull ----
    this.merge();
    this.drops = this.drops.filter(d => {
      const pn = this.panes[d.pane];
      return (
        d.r > 0 &&
        d.u >= pn.uMin - 0.01 &&
        d.u <= pn.uMax + 0.01 &&
        d.v >= -0.02 &&
        d.v <= pn.vMax + 0.01
      );
    });
    if (this.drops.length > MAX_DROPS) {
      // The oldest (first added) evaporate.
      this.drops.splice(0, this.drops.length - MAX_DROPS);
    }
  }

  private add(d: Drop) {
    d.fresh = true;
    this.drops.push(d);
  }

  // Drops that touch coalesce (volume conserving); snow clumps.
  private merge() {
    const cell = 0.008;
    const grid = new Map<number, Drop[]>();
    const key = (p: number, i: number, j: number) =>
      p * 1e7 + (i + 2000) * 2000 + (j + 500);
    for (const d of this.drops) {
      if (d.r <= 0) continue;
      const k = key(d.pane, Math.floor(d.u / cell), Math.floor(d.v / cell));
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(d);
    }
    // Only drops that moved or just landed can newly touch another.
    for (const d of this.drops) {
      if (d.r <= 0 || !(d.fresh || d.du !== 0 || d.dv !== 0 || d.hold > 0.2))
        continue;
      d.fresh = false;
      const i0 = Math.floor(d.u / cell),
        j0 = Math.floor(d.v / cell);
      for (let i = i0 - 1; i <= i0 + 1; ++i)
        for (let j = j0 - 1; j <= j0 + 1; ++j) {
          const l = grid.get(key(d.pane, i, j));
          if (!l) continue;
          for (const o of l) {
            if (o === d || o.r <= 0 || o.snow !== d.snow) continue;
            const rr = d.r + o.r;
            if ((o.u - d.u) ** 2 + (o.v - d.v) ** 2 > rr * rr * 0.6) continue;
            // The bigger one swallows the other.
            const [big, small] = d.r >= o.r ? [d, o] : [o, d];
            big.r = Math.min(
              big.snow ? 0.01 : 0.006,
              Math.cbrt(big.r ** 3 + small.r ** 3),
            );
            small.r = 0;
          }
        }
    }
  }
}
