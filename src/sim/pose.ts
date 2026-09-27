// World-space poses for vehicles (with body pitch/roll springs) from road
// coordinates.
import {Road} from '../world/road';
import {hash01, noise1} from '../math/noise';
import {Vehicle} from './traffic';

export interface Pose {
  pos: [number, number, number]; // world (f64)
  fwd: [number, number, number];
  up: [number, number, number];
  left: [number, number, number];
  heading: number;
  steer: number;
  speed: number;
  // Suspension bounce on rough roads: body heave (m, along up) and the
  // pitch / roll it adds (rad). fwd / up / left include them; base* are
  // the frame without them (for cameras that shouldn't bounce).
  heave: number;
  bumpPitch: number;
  bumpRoll: number;
  baseFwd: [number, number, number];
  baseLeft: [number, number, number];
  // Each wheel's offset along the body's up from where the (lagging)
  // sprung body puts it: wheels follow the road at once, the body a
  // moment later. Order: front right, front left, rear right, rear left.
  wheelDrop: [number, number, number, number];
}

// Height of a rough (dirt) road surface under a wheel at arc length s and
// lateral offset d: washboard ripples, rolling bumps and the odd pothole.
export function roadBump(road: Road, s: number, d: number): number {
  if (!road.biome.road.dirt) return 0;
  let h =
    noise1(s * 0.45, 11) * 0.028 +
    noise1(s * 1.7 + d * 0.9, 23) * 0.012 +
    Math.sin(s * 8.5 + noise1(s * 0.2, 5) * 3) *
      0.004 *
      (0.5 + 0.5 * noise1(s * 0.05, 7));
  // Potholes: ~1 per 25 m, on one wheel track or the other.
  const cell = Math.floor(s / 25);
  const hh = hash01(cell, 77);
  if (hh < 0.5) {
    const c = (cell + 0.2 + hh) * 25;
    const side = hash01(cell, 78) < 0.5 ? -1 : 1;
    const dd = d - side * 1.6;
    const r2 = ((s - c) / 0.9) ** 2 + (dd / 0.9) ** 2;
    h -= 0.08 * Math.exp(-r2 * 2);
  }
  return h;
}

export function vehiclePose(
  road: Road,
  v: Vehicle,
  dt: number,
  wheelbase: number,
  track = 1.6,
): Pose {
  const s = v.s;
  const a = road.pointAt(s - 1.2, v.d);
  const b = road.pointAt(s + 1.2, v.d);
  const c = road.pointAt(s, v.d);
  let fx = b.pos[0] - a.pos[0],
    fy = b.pos[1] - a.pos[1],
    fz = b.pos[2] - a.pos[2];
  // Lane-change yaw.
  const lat = v.latVel / Math.max(v.speed, 1);
  const hl = Math.hypot(fx, fz);
  const lx = Math.cos(c.heading),
    lz = -Math.sin(c.heading);
  fx += lx * lat * hl * v.dir;
  fz += lz * lat * hl * v.dir;
  if (v.dir < 0) {
    fx = -fx;
    fy = -fy;
    fz = -fz;
  }
  const fl = Math.hypot(fx, fy, fz);
  let fwd: [number, number, number] = [fx / fl, fy / fl, fz / fl];
  // Curvature -> lateral acceleration -> roll; accel -> pitch.
  const h0 = road.atS(s - 4).heading,
    h1 = road.atS(s + 4).heading;
  const curv = ((h1 - h0) / 8) * v.dir;
  const latAcc = v.speed * v.speed * curv;
  const k = 9,
    damp = 2 * 0.55 * Math.sqrt(k);
  const rollT = -latAcc * 0.012;
  v.rollVel += (k * (rollT - v.roll) - damp * v.rollVel) * dt;
  v.roll += v.rollVel * dt;
  const pitchT = -v.accel * 0.008;
  v.pitchVel += (k * (pitchT - v.pitch) - damp * v.pitchVel) * dt;
  v.pitch += v.pitchVel * dt;
  // Basis.
  let up: [number, number, number] = [0, 1, 0];
  let left: [number, number, number] = [
    up[1] * fwd[2] - up[2] * fwd[1],
    up[2] * fwd[0] - up[0] * fwd[2],
    up[0] * fwd[1] - up[1] * fwd[0],
  ];
  let ll = Math.hypot(...left);
  left = [left[0] / ll, left[1] / ll, left[2] / ll];
  up = [
    fwd[1] * left[2] - fwd[2] * left[1],
    fwd[2] * left[0] - fwd[0] * left[2],
    fwd[0] * left[1] - fwd[1] * left[0],
  ];
  // Apply pitch (around left) and roll (around fwd).
  const rot = (
    vv: [number, number, number],
    axis: [number, number, number],
    ang: number,
  ): [number, number, number] => {
    const cs = Math.cos(ang),
      sn = Math.sin(ang);
    const d = vv[0] * axis[0] + vv[1] * axis[1] + vv[2] * axis[2];
    const cr = [
      axis[1] * vv[2] - axis[2] * vv[1],
      axis[2] * vv[0] - axis[0] * vv[2],
      axis[0] * vv[1] - axis[1] * vv[0],
    ];
    return [
      vv[0] * cs + cr[0] * sn + axis[0] * d * (1 - cs),
      vv[1] * cs + cr[1] * sn + axis[1] * d * (1 - cs),
      vv[2] * cs + cr[2] * sn + axis[2] * d * (1 - cs),
    ];
  };
  const baseFwd: [number, number, number] = [...fwd];
  const baseLeft: [number, number, number] = [...left];
  // Suspension over road bumps: the four wheel heights drive heave, pitch
  // and roll springs (~1.3 Hz body bounce, lightly damped).
  const bs = (v.bump ??= [0, 0, 0, 0, 0, 0]);
  const wheelDrop: [number, number, number, number] = [0, 0, 0, 0];
  if (road.biome.road.dirt && dt > 0) {
    const sf = s + (v.dir * wheelbase) / 2,
      sr = s - (v.dir * wheelbase) / 2;
    const hw = track / 2;
    const fl = roadBump(road, sf, v.d + hw),
      fr = roadBump(road, sf, v.d - hw),
      rl = roadBump(road, sr, v.d + hw),
      rr = roadBump(road, sr, v.d - hw);
    const targets = [
      (fl + fr + rl + rr) / 4,
      (fl + fr - rl - rr) / 2 / wheelbase,
      ((fl + rl - fr - rr) / 2 / track) * v.dir,
    ];
    const kk = 66,
      dd = 2 * 0.3 * Math.sqrt(kk);
    // Sub-step for stability at low frame rates.
    const n = Math.ceil(dt / (1 / 120));
    const h = dt / n;
    for (let it = 0; it < n; ++it)
      for (let k = 0; k < 3; ++k) {
        bs[k + 3] += (kk * (targets[k] - bs[k]) - dd * bs[k + 3]) * h;
        bs[k] += bs[k + 3] * h;
      }
    // Unsprung wheels: road height minus the sprung body at that wheel
    // (within the suspension travel).
    const body = (front: number, dside: number) =>
      bs[0] + bs[1] * front * (wheelbase / 2) + bs[2] * v.dir * dside * hw;
    const drop = (h0: number, front: number, dside: number) =>
      Math.max(-0.07, Math.min(0.07, h0 - body(front, dside)));
    // Which road side (d + hw or d - hw) is the car's left?
    const p0 = road.pointAt(s, v.d).pos,
      p1 = road.pointAt(s, v.d + 1).pos;
    const leftIsPlus =
      (p1[0] - p0[0]) * left[0] + (p1[2] - p0[2]) * left[2] > 0;
    const fL = leftIsPlus ? drop(fl, 1, 1) : drop(fr, 1, -1),
      fR = leftIsPlus ? drop(fr, 1, -1) : drop(fl, 1, 1),
      rL = leftIsPlus ? drop(rl, -1, 1) : drop(rr, -1, -1),
      rR = leftIsPlus ? drop(rr, -1, -1) : drop(rl, -1, 1);
    wheelDrop[0] = fR;
    wheelDrop[1] = fL;
    wheelDrop[2] = rR;
    wheelDrop[3] = rL;
  }
  fwd = rot(fwd, left, v.pitch - bs[1]);
  up = rot(up, left, v.pitch - bs[1]);
  up = rot(up, fwd, v.roll + bs[2]);
  left = rot(left, fwd, v.roll + bs[2]);
  ll = Math.hypot(...left);
  const camber = -0.015 * Math.abs(v.d);
  const pos: [number, number, number] = [c.pos[0], c.pos[1] + camber, c.pos[2]];
  const heading = Math.atan2(fwd[0], fwd[2]);
  const steer = Math.atan(wheelbase * curv) + lat * 0.5;
  return {
    pos,
    fwd,
    up,
    left,
    heading,
    steer,
    speed: v.speed,
    heave: bs[0],
    bumpPitch: bs[1],
    bumpRoll: bs[2],
    baseFwd,
    baseLeft,
    wheelDrop,
  };
}
