// World-space poses for vehicles (with body pitch/roll springs) from road
// coordinates.
import {Road} from '../world/road';
import {Vehicle} from './traffic';

export interface Pose {
  pos: [number, number, number]; // world (f64)
  fwd: [number, number, number];
  up: [number, number, number];
  left: [number, number, number];
  heading: number;
  steer: number;
  speed: number;
}

export function vehiclePose(
  road: Road,
  v: Vehicle,
  dt: number,
  wheelbase: number,
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
  fwd = rot(fwd, left, v.pitch);
  up = rot(up, left, v.pitch);
  up = rot(up, fwd, v.roll);
  left = rot(left, fwd, v.roll);
  ll = Math.hypot(...left);
  const camber = -0.015 * Math.abs(v.d);
  const pos: [number, number, number] = [c.pos[0], c.pos[1] + camber, c.pos[2]];
  const heading = Math.atan2(fwd[0], fwd[2]);
  const steer = Math.atan(wheelbase * curv) + lat * 0.5;
  return {pos, fwd, up, left, heading, steer, speed: v.speed};
}
