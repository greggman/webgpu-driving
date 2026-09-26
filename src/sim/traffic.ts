// Vehicles and traffic. Everything lives in road coordinates (s = arc
// length, d = lateral offset, + = +x side). Driving is on the right: the
// player's direction uses d < 0 lanes, oncoming traffic d > 0.
//
// Collisions are impossible by construction:
//  * longitudinal motion follows the Intelligent Driver Model (IDM) with
//    respect to the nearest laterally-overlapping vehicle ahead (including
//    head-on oncoming vehicles, with the summed closing speed);
//  * lane changes only start when the target lane has safe gaps;
//  * a final hard constraint pass clamps any pair that gets closer than the
//    minimum gap (and stops head-on pairs), so overlap can never happen.
import {CarKind, CAR_KINDS, semiLayout} from '../gen/car';
import {Rng, clamp} from '../math/noise';
import {Biome} from '../world/biome';

export interface Vehicle {
  id: number;
  kind: CarKind;
  color: [number, number, number, number];
  dir: 1 | -1;
  s: number;
  d: number;
  dTarget: number;
  speed: number;
  desired: number;
  accel: number;
  length: number;
  spin: number;
  brake: number;
  // Body dynamics (springs).
  pitch: number;
  pitchVel: number;
  roll: number;
  rollVel: number;
  latVel: number;
  player: boolean;
}

const PAINTS: Array<[number, number, number, number]> = [
  [0.6, 0.02, 0.02, 0.6], // red
  [0.02, 0.05, 0.25, 0.7], // deep blue
  [0.8, 0.8, 0.82, 0.4], // white
  [0.02, 0.02, 0.02, 0.5], // black
  [0.35, 0.36, 0.38, 0.9], // silver
  [0.12, 0.14, 0.15, 0.8], // gunmetal
  [0.05, 0.18, 0.08, 0.6], // green
  [0.55, 0.35, 0.08, 0.7], // bronze
  [0.7, 0.55, 0.1, 0.6], // yellow
  [0.15, 0.3, 0.45, 0.8], // steel blue
];

export const MIN_GAP = 4.0; // bumper-to-bumper minimum (m)

export class Traffic {
  vehicles: Vehicle[] = [];
  player: Vehicle;
  private rng: Rng;
  private nextId = 1;
  readonly laneW: number;
  readonly lanes: number;
  autopilot = true;
  private manualLaneUntil = 0;
  time = 0;

  constructor(
    private biome: Biome,
    seed: number,
    sStart: number,
  ) {
    this.rng = new Rng(seed * 31 + 7);
    this.laneW = biome.road.laneWidth;
    this.lanes = biome.road.lanesPerDir;
    const kinds: CarKind[] = ['sedan', 'coupe', 'wagon', 'suv', 'hatch'];
    const pk =
      biome.id === 'desert' || biome.id === 'snow'
        ? 'suv'
        : kinds[seed % kinds.length];
    // Hero paint per environment (car-commercial palette).
    const hero: Record<string, [number, number, number, number]> = {
      country: [0.5, 0.015, 0.012, 0.55], // candy red
      desert: [0.62, 0.62, 0.6, 0.85], // liquid silver
      coast: [0.02, 0.09, 0.25, 0.75], // deep ocean blue
      forest: [0.75, 0.74, 0.7, 0.45], // pearl white
      snow: [0.01, 0.01, 0.012, 0.6], // gloss black
      lahonda: [0.55, 0.22, 0.03, 0.8], // burnt orange
      night: [0.4, 0.41, 0.43, 0.9], // gunmetal silver
    };
    this.player = this.make(
      pk,
      hero[biome.id] ?? [0.5, 0.015, 0.012, 0.55],
      1,
      sStart,
      this.laneD(1, 0),
      biome.road.cruise,
    );
    this.player.player = true;
    this.vehicles.push(this.player);
    // Initial traffic.
    for (let i = 0; i < 400; ++i) this.spawn(true);
  }

  // Lateral offset of lane i (0 = outermost/right) for a direction.
  laneD(dir: 1 | -1, i: number): number {
    const d = (this.lanes - i - 0.5) * this.laneW;
    return dir === 1 ? -d : d;
  }

  // The player picked a different car.
  setPlayerKind(kind: CarKind) {
    this.player.kind = kind;
    this.player.length = carLength(kind);
  }

  private make(
    kind: CarKind,
    color: [number, number, number, number],
    dir: 1 | -1,
    s: number,
    d: number,
    desired: number,
  ): Vehicle {
    const len = carLength(kind);
    return {
      id: this.nextId++,
      kind,
      color,
      dir,
      s,
      d,
      dTarget: d,
      speed: desired,
      desired,
      accel: 0,
      length: len,
      spin: this.rng.range(0, 6),
      brake: 0,
      pitch: 0,
      pitchVel: 0,
      roll: 0,
      rollVel: 0,
      latVel: 0,
      player: false,
    };
  }

  private spawn(initial: boolean) {
    const density = this.biome.road.traffic; // cars per km per lane
    const p = this.player.s;
    const lo = p - 600,
      hi = p + 3000;
    const target = Math.round(((hi - lo) / 1000) * density * this.lanes * 2);
    if (this.vehicles.length - 1 >= target) return;
    const dir: 1 | -1 = this.rng.next() < 0.5 ? 1 : -1;
    const lane = this.rng.int(0, this.lanes - 1);
    let s: number;
    if (initial) {
      s = this.rng.range(lo, hi);
    } else if (dir === 1) {
      // Same direction: appear far ahead (slower) or far behind (faster).
      s =
        this.rng.next() < 0.7
          ? hi - this.rng.range(0, 200)
          : lo + this.rng.range(0, 100);
    } else {
      s = hi - this.rng.range(0, 300);
    }
    const d = this.laneD(dir, lane);
    if (Math.abs(s - p) < 40) return;
    for (const v of this.vehicles) {
      if (Math.abs(v.d - d) < 2.5 && Math.abs(v.s - s) < 40) return;
    }
    const cruise = this.biome.road.cruise;
    const desired =
      dir === 1
        ? cruise *
          this.rng.range(0.65, 1.05) *
          (lane === this.lanes - 1 && this.lanes > 1 ? 1.15 : 1)
        : cruise * this.rng.range(0.8, 1.1);
    let r =
      this.rng.next() * CAR_KINDS.reduce((a, k) => a + KIND_WEIGHTS[k], 0);
    let kind = CAR_KINDS[0];
    for (const k of CAR_KINDS) {
      r -= KIND_WEIGHTS[k];
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    // Dirt roads: no semis or buses.
    if (this.biome.road.dirt && (kind === 'semi' || kind === 'bus'))
      kind = 'pickup';
    const color = this.rng.pick(PAINTS);
    const heavy = kind === 'semi' || kind === 'bus' ? 0.85 : 1;
    this.vehicles.push(this.make(kind, color, dir, s, d, desired * heavy));
  }

  // Leader: nearest laterally-overlapping vehicle ahead of v in v's travel
  // direction. Returns gap (bumper to bumper) and closing speed.
  private leader(
    v: Vehicle,
    d = v.d,
  ): {gap: number; dv: number; other: Vehicle | null} {
    let best = Infinity;
    let dv = 0;
    let other: Vehicle | null = null;
    for (const o of this.vehicles) {
      if (o === v) continue;
      if (Math.abs(o.d - d) > 2.3) continue;
      const ds = (o.s - v.s) * v.dir;
      if (ds <= 0) continue;
      const gap = ds - (o.length + v.length) / 2;
      if (gap < best) {
        best = gap;
        // closing speed: our speed minus their speed along our direction.
        dv = v.speed - o.speed * o.dir * v.dir;
        other = o;
      }
    }
    return {gap: best, dv, other};
  }

  private follower(
    v: Vehicle,
    d: number,
  ): {gap: number; other: Vehicle | null} {
    let best = Infinity;
    let other: Vehicle | null = null;
    for (const o of this.vehicles) {
      if (o === v || o.dir !== v.dir) continue;
      if (Math.abs(o.d - d) > 2.3) continue;
      const ds = (v.s - o.s) * v.dir;
      if (ds <= 0) continue;
      const gap = ds - (o.length + v.length) / 2;
      if (gap < best) {
        best = gap;
        other = o;
      }
    }
    return {gap: best, other};
  }

  // Intelligent Driver Model acceleration.
  private idm(v: Vehicle, gap: number, dv: number): number {
    const a = 1.4,
      b = 2.5,
      T = 1.4,
      s0 = MIN_GAP + 1;
    const v0 = Math.max(v.desired, 0.1);
    const free = 1 - Math.pow(v.speed / v0, 4);
    if (!isFinite(gap)) return a * free;
    const sStar =
      s0 + Math.max(0, v.speed * T + (v.speed * dv) / (2 * Math.sqrt(a * b)));
    return a * (free - Math.pow(sStar / Math.max(gap, 0.1), 2));
  }

  // Is it safe for v to occupy lateral offset d now?
  laneClear(v: Vehicle, d: number): boolean {
    for (const o of this.vehicles) {
      if (o === v || Math.abs(o.d - d) > 2.3) continue;
      const ds = (o.s - v.s) * v.dir;
      const len = (o.length + v.length) / 2;
      if (o.dir === v.dir) {
        const ahead = ds > 0;
        const need = ahead
          ? len + Math.max(8, (v.speed - o.speed) * 2 + 6)
          : len + Math.max(8, (o.speed - v.speed) * 3 + 8);
        if (Math.abs(ds) < need) return false;
      } else {
        // Oncoming in that lane: need a long clear stretch ahead.
        if (ds > -len - 5 && ds < (v.speed + o.speed) * 14 + 60) return false;
      }
    }
    return true;
  }

  // Player controls.
  requestLane(delta: number) {
    const p = this.player;
    const all: number[] = [];
    for (let i = 0; i < this.lanes; ++i) all.push(this.laneD(1, i));
    for (let i = this.lanes - 1; i >= 0; --i) all.push(this.laneD(-1, i));
    all.sort((a, b) => a - b); // from -x (right) to +x (left)
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < all.length; ++i) {
      const e = Math.abs(all[i] - p.dTarget);
      if (e < best) {
        best = e;
        idx = i;
      }
    }
    // delta > 0 = move left (+x).
    const ni = clamp(idx + delta, 0, all.length - 1);
    const d = all[ni];
    if (d !== p.dTarget && this.laneClear(p, d)) {
      p.dTarget = d;
      this.manualLaneUntil = this.time + 8;
    }
  }

  adjustSpeed(delta: number) {
    const c = this.biome.road.cruise;
    this.player.desired = clamp(this.player.desired + delta, 3, c * 1.6);
  }

  // Overtake state: the car being passed and when the manoeuvre began.
  private passTarget: Vehicle | null = null;
  private laneChangeAt = -1e9;
  laneFlips = 0; // for tests: number of autopilot lane-target changes

  private setTarget(d: number) {
    const p = this.player;
    if (Math.abs(d - p.dTarget) > 0.1) {
      p.dTarget = d;
      this.laneChangeAt = this.time;
      this.laneFlips++;
    }
  }

  private autopilotStep() {
    const p = this.player;
    if (this.time < this.manualLaneUntil) return;
    const home = this.laneD(1, 0);
    const cruise = this.biome.road.cruise;
    const passD = this.lanes === 1 ? this.laneD(-1, 0) : this.laneD(1, 1);
    const sinceChange = this.time - this.laneChangeAt;
    const inHome = Math.abs(p.dTarget - home) < 0.1;
    if (inHome) {
      this.passTarget = null;
      p.desired = cruise;
      // Slow car ahead? Pass it when the passing lane is clear.
      if (sinceChange < 3) return;
      const {gap, other} = this.leader(p, home);
      const slow = this.lanes === 1 ? 0.9 : 0.92;
      if (
        other &&
        other.dir === 1 &&
        gap < (this.lanes === 1 ? 45 : 50) &&
        other.speed < cruise * slow &&
        this.laneClear(p, passD)
      ) {
        this.passTarget = other;
        this.setTarget(passD);
      }
      return;
    }
    // Passing: commit for a while, then return once the passed car is well
    // behind and the home lane has room. (Returning as soon as the home lane
    // looked clear made the target flip every frame: the car ended up
    // straddling the centre line, jittering.)
    const t = this.passTarget;
    const passed =
      !t ||
      !this.vehicles.includes(t) ||
      p.s - t.s > (p.length + t.length) / 2 + 12;
    if (sinceChange > 2 && passed && this.laneClear(p, home)) {
      this.setTarget(home);
      return;
    }
    if (this.lanes === 1 && !this.laneClear(p, passD)) {
      // Oncoming traffic: abort — drop back and tuck in behind the car.
      p.desired = cruise * 0.5;
      if (
        t &&
        t.s - p.s > (p.length + t.length) / 2 + 4 &&
        this.laneClear(p, home)
      ) {
        this.setTarget(home);
      }
    } else {
      p.desired = cruise;
    }
  }

  update(dt: number) {
    this.time += dt;
    if (this.autopilot) this.autopilotStep();
    // Traffic AI lane choice for same-direction multi-lane roads.
    for (const v of this.vehicles) {
      if (v.player) continue;
      if (this.lanes > 1 && v.dir === 1 && this.rng.next() < dt * 0.05) {
        const alt =
          Math.abs(v.dTarget - this.laneD(1, 0)) < 0.1
            ? this.laneD(1, 1)
            : this.laneD(1, 0);
        if (this.laneClear(v, alt)) v.dTarget = alt;
      }
    }
    // Longitudinal (IDM), also considering the lane being moved into.
    for (const v of this.vehicles) {
      const l1 = this.leader(v, v.d);
      let acc = this.idm(v, l1.gap, l1.dv);
      if (Math.abs(v.dTarget - v.d) > 0.3) {
        const l2 = this.leader(v, v.dTarget);
        acc = Math.min(acc, this.idm(v, l2.gap, l2.dv));
      }
      acc = clamp(acc, -8, 2.5);
      v.accel = acc;
      v.brake = acc < -1 ? 1 : 0;
      v.speed = Math.max(0, v.speed + acc * dt);
      v.s += v.speed * dt * v.dir;
      // Lateral: critically damped spring toward target lane.
      const k = 1.6;
      const ax = k * k * (v.dTarget - v.d) - 2 * k * v.latVel;
      v.latVel += ax * dt;
      v.d += v.latVel * dt;
    }
    this.enforceGaps();
    // Despawn and respawn.
    const p = this.player.s;
    this.vehicles = this.vehicles.filter(
      v => v.player || (v.s > p - 700 && v.s < p + 3200),
    );
    for (let i = 0; i < 4; ++i) this.spawn(false);
  }

  // Hard guarantee: no two laterally-overlapping vehicles closer than MIN_GAP.
  private enforceGaps() {
    const vs = this.vehicles;
    for (let iter = 0; iter < 2; ++iter) {
      for (let i = 0; i < vs.length; ++i) {
        for (let j = i + 1; j < vs.length; ++j) {
          const a = vs[i],
            b = vs[j];
          if (Math.abs(a.d - b.d) > 2.3) continue;
          const len = (a.length + b.length) / 2 + MIN_GAP;
          const ds = b.s - a.s;
          if (Math.abs(ds) >= len) continue;
          if (a.dir === b.dir) {
            // Push the follower back behind the leader.
            const leadIsB = ds * a.dir > 0;
            const lead = leadIsB ? b : a;
            const fol = leadIsB ? a : b;
            fol.s = lead.s - fol.dir * len;
            fol.speed = Math.min(fol.speed, lead.speed);
          } else {
            // Head-on: both stop in place, separated.
            const mid = (a.s + b.s) / 2;
            const sign = Math.sign(ds) || 1;
            a.s = mid - (sign * len) / 2;
            b.s = mid + (sign * len) / 2;
            a.speed = 0;
            b.speed = 0;
          }
        }
      }
    }
  }

  // Minimum bumper gap between laterally-overlapping vehicles (for tests).
  minGap(): number {
    let m = Infinity;
    const vs = this.vehicles;
    for (let i = 0; i < vs.length; ++i) {
      for (let j = i + 1; j < vs.length; ++j) {
        const a = vs[i],
          b = vs[j];
        if (Math.abs(a.d - b.d) > 2.3) continue;
        m = Math.min(m, Math.abs(a.s - b.s) - (a.length + b.length) / 2);
      }
    }
    return m;
  }
}

export function carLength(kind: CarKind): number {
  if (kind === 'semi') return semiLayout().total;
  if (kind === 'bus') return 12.2;
  return kind === 'pickup' ? 5.4 : kind === 'hatch' ? 4.1 : 4.8;
}

// Traffic mix (relative weights).
const KIND_WEIGHTS: Record<string, number> = {
  sedan: 3,
  hatch: 2,
  suv: 3,
  coupe: 1,
  wagon: 2,
  pickup: 1.5,
  semi: 1,
  bus: 0.4,
};
