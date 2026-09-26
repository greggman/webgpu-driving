// Camera director: a "car commercial" shot sequencer. Each shot computes an
// eye/target from the player car's pose (and the road, for roadside setups);
// the director cuts between shots with weights per environment and uses the
// road ahead (s look-ahead) to place roadside cameras.
import {Pose} from '../sim/pose';
import {Road} from '../world/road';
import {Rng} from '../math/noise';

export type ShotKind =
  | 'chase'
  | 'helicopter'
  | 'drone'
  | 'roadside'
  | 'dolly'
  | 'wheel'
  | 'interior'
  | 'passenger'
  | 'topdown'
  | 'hood'
  | 'front'
  | 'custom';

export const SHOT_KINDS: ShotKind[] = [
  'chase',
  'helicopter',
  'drone',
  'roadside',
  'dolly',
  'wheel',
  'interior',
  'passenger',
  'topdown',
  'hood',
  'front',
  'custom',
];

export interface CameraState {
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number; // vertical, radians
  focus: number; // DoF focus distance (m)
  aperture: number; // 0 = no DoF
  interior: boolean;
  shot: ShotKind;
}

interface ShotState {
  kind: ShotKind;
  t: number;
  duration: number;
  seed: number;
  anchor?: [number, number, number]; // roadside cameras
  anchorS?: number;
  side: number;
}

const DEG = Math.PI / 180;

export class Director {
  private shot: ShotState;
  private rng: Rng;
  private smoothEye: [number, number, number] | null = null;
  private smoothTarget: [number, number, number] | null = null;
  forced: ShotKind | null = null;
  // Car-relative eye/target (forward, left, up) for cam=custom.
  customEye: [number, number, number] = [-8, 3, 2];
  customTarget: [number, number, number] = [0, 0, 1];
  customFov = 50;
  private weights: Partial<Record<ShotKind, number>>;
  cutCount = 0;
  canopy = 12; // min aerial clearance above ground (m)
  // Driver eye in car-local (forward, left, up), set from the car's proportions.
  driverEye: [number, number, number] = [-0.35, 0.37, 1.1];

  constructor(
    private road: Road,
    seed: number,
    weights: Partial<Record<string, number>>,
  ) {
    this.rng = new Rng(seed * 977 + 13);
    this.weights = weights as Partial<Record<ShotKind, number>>;
    this.shot = this.newShot('chase', 0);
  }

  private newShot(kind: ShotKind, sCar: number): ShotState {
    const side = this.rng.next() < 0.5 ? 1 : -1;
    const st: ShotState = {
      kind,
      t: 0,
      duration: this.rng.range(7, 12),
      seed: this.rng.next(),
      side,
    };
    if (kind === 'roadside') {
      // Frame a bridge if one is coming up, otherwise a spot ahead.
      let s = sCar + this.rng.range(70, 110);
      for (let q = sCar + 50; q < sCar + 220; q += 10) {
        if (this.road.atS(q).bridge > 0.5) {
          s = q + 15;
          break;
        }
      }
      const hw = this.road.halfWidth;
      const p = this.road.pointAt(s, side * (hw + this.rng.range(3, 9)));
      const g = this.road.groundHeight(p.pos[0], p.pos[2]);
      st.anchor = [p.pos[0], g + this.rng.range(0.6, 2.0), p.pos[2]];
      st.anchorS = s;
      st.duration = 14;
    }
    if (kind === 'drone') st.duration = 9;
    if (kind === 'interior') st.duration = this.rng.range(8, 14);
    return st;
  }

  cut(sCar: number, kind?: ShotKind) {
    const k = kind ?? this.pickShot(sCar);
    this.shot = this.newShot(k, sCar);
    this.smoothEye = null;
    this.smoothTarget = null;
    this.cutCount++;
  }

  // Look ahead along the road for features worth a particular shot.
  private roadAhead(sCar: number): ShotKind | null {
    for (let s = sCar + 40; s < sCar + 220; s += 10) {
      if (this.road.atS(s).bridge > 0.5) return 'roadside';
    }
    const h0 = this.road.atS(sCar).heading,
      h1 = this.road.atS(sCar + 300).heading;
    if (Math.abs(h1 - h0) < 0.08 && this.rng.next() < 0.5) return 'helicopter';
    if (Math.abs(h1 - h0) > 0.6 && this.rng.next() < 0.5) return 'chase';
    return null;
  }

  private pickShot(sCar = 0): ShotKind {
    const ahead = this.roadAhead(sCar);
    if (ahead && ahead !== this.shot.kind && this.rng.next() < 0.6) return ahead;
    const base: Record<ShotKind, number> = {
      chase: 1.5,
      helicopter: 1.3,
      drone: 1,
      roadside: 1.3,
      dolly: 1,
      wheel: 0.6,
      interior: 1,
      passenger: 0.4,
      topdown: 0.4,
      hood: 0.5,
      front: 0.8,
      custom: 0,
    };
    let total = 0;
    const w = SHOT_KINDS.map(k => {
      const v = k === this.shot.kind ? 0 : base[k] * (this.weights[k] ?? 1);
      total += v;
      return v;
    });
    let r = this.rng.next() * total;
    for (let i = 0; i < w.length; ++i) {
      r -= w[i];
      if (r <= 0) return SHOT_KINDS[i];
    }
    return 'chase';
  }

  // Advance and compute the camera. sCar is the player's arc length.
  update(dt: number, car: Pose, sCar: number, carLen: number): CameraState {
    const sh = this.shot;
    sh.t += dt;
    if (!this.forced) {
      const passed =
        sh.kind === 'roadside' &&
        sh.anchorS !== undefined &&
        sCar > sh.anchorS + 45;
      if (sh.t > sh.duration || passed) this.cut(sCar);
    } else if (sh.kind !== this.forced) {
      this.cut(sCar, this.forced);
    } else if (
      sh.kind === 'roadside' &&
      sh.anchorS !== undefined &&
      sCar > sh.anchorS + 45
    ) {
      this.cut(sCar, this.forced);
    }
    const s = this.shot;
    const P = car.pos,
      Fw = car.fwd,
      L = car.left,
      U: [number, number, number] = [0, 1, 0];
    const at = (f: number, l: number, u: number): [number, number, number] => [
      P[0] + Fw[0] * f + L[0] * l + U[0] * u,
      P[1] + Fw[1] * f + L[1] * l + U[1] * u,
      P[2] + Fw[2] * f + L[2] * l + U[2] * u,
    ];
    // Car-local (rigid, includes body roll/pitch) for mounted cameras.
    const rigid = (
      f: number,
      l: number,
      u: number,
    ): [number, number, number] => [
      P[0] + Fw[0] * f + L[0] * l + car.up[0] * u,
      P[1] + Fw[1] * f + L[1] * l + car.up[1] * u,
      P[2] + Fw[2] * f + L[2] * l + car.up[2] * u,
    ];
    let eye: [number, number, number];
    let target: [number, number, number];
    let fov = 50 * DEG;
    let aperture = 0.0;
    let interior = false;
    let smooth = 0; // spring smoothing rate (0 = rigid)
    let up: [number, number, number] = [0, 1, 0];
    const t = s.t;
    switch (s.kind) {
      case 'chase': {
        const sway = Math.sin(t * 0.4 + s.seed * 10) * 0.8;
        eye = at(-7.5, sway, 2.3);
        target = at(3, 0, 0.9);
        fov = 52 * DEG;
        smooth = 4;
        break;
      }
      case 'helicopter': {
        // Wide aerial that keeps the horizon in frame: the car sits in the
        // lower third with the landscape ahead of it.
        const r = 55 + s.seed * 35;
        const a = s.side * (0.5 + t * 0.05) + (s.seed - 0.5) * 1.2;
        eye = at(-Math.cos(a) * r, Math.sin(a) * r * 0.7, 14 + s.seed * 16);
        target = at(40, 0, 2);
        fov = 38 * DEG;
        aperture = 0.0;
        smooth = 1.5;
        break;
      }
      case 'drone': {
        // Starts ahead and low, sweeps back over the car and rises.
        const u = t / s.duration;
        eye = at(40 - u * 70, s.side * (6 - u * 3), 2.5 + u * u * 25);
        target = at(0, 0, 0.8);
        fov = 45 * DEG;
        smooth = 3;
        break;
      }
      case 'roadside': {
        eye = s.anchor!;
        target = at(0, 0, 0.8);
        const dist = Math.hypot(eye[0] - P[0], eye[1] - P[1], eye[2] - P[2]);
        fov = Math.max(12, Math.min(45, 900 / Math.max(dist, 1))) * DEG;
        aperture = 0.35;
        smooth = 6;
        break;
      }
      case 'dolly': {
        eye = at(0.5 + Math.sin(t * 0.3) * 2, s.side * 7, 1.0);
        target = at(0, 0, 0.7);
        fov = 38 * DEG;
        aperture = 0.25;
        smooth = 5;
        break;
      }
      case 'wheel': {
        eye = rigid(1.9, s.side * 1.15, 0.45);
        target = rigid(-3, s.side * 0.9, 0.35);
        fov = 62 * DEG;
        aperture = 0.15;
        up = car.up;
        break;
      }
      case 'interior': {
        const de = this.driverEye;
        eye = rigid(de[0], de[1], de[2]);
        const look = Math.sin(t * 0.2 + s.seed * 5) * 0.12;
        target = rigid(12, de[1] + look * 10, de[2] - 0.35);
        fov = 62 * DEG;
        interior = true;
        up = car.up;
        break;
      }
      case 'passenger': {
        const de = this.driverEye;
        eye = rigid(de[0], -de[1], de[2]);
        target = rigid(3, -6, de[2] - 0.2);
        fov = 55 * DEG;
        interior = true;
        up = car.up;
        break;
      }
      case 'topdown': {
        eye = at(-4, 0.01, 28);
        target = at(4, 0, 0);
        fov = 40 * DEG;
        smooth = 2;
        break;
      }
      case 'hood': {
        eye = rigid(1.2, 0, 1.25);
        target = rigid(20, 0, 0.8);
        fov = 60 * DEG;
        up = car.up;
        break;
      }
      case 'custom': {
        eye = at(...this.customEye);
        target = at(...this.customTarget);
        fov = this.customFov * DEG;
        break;
      }
      case 'front': {
        // Ahead of the car, looking back at it (tracking).
        eye = at(9 + Math.sin(t * 0.3) * 2, s.side * 1.5, 1.2);
        target = at(0, 0, 0.8);
        fov = 42 * DEG;
        aperture = 0.3;
        smooth = 4;
        break;
      }
    }
    // Keep the eye above the ground (and, for aerial shots, above the
    // canopy: vegetation is GPU-scattered, so use a per-biome clearance).
    if (!interior && s.kind !== 'wheel' && s.kind !== 'hood') {
      const g = this.road.groundHeight(eye[0], eye[2]);
      const aerial =
        s.kind === 'helicopter' || s.kind === 'topdown' || s.kind === 'drone';
      const offRoad =
        Math.abs(this.road.info(eye[0], eye[2]).d) > this.road.halfWidth + 2;
      const clear = aerial ? this.canopy : offRoad ? 1.0 : 0.5;
      if (eye[1] < g + clear) eye = [eye[0], g + clear, eye[2]];
    }
    if (smooth > 0 && this.smoothEye && this.smoothTarget) {
      const k = 1 - Math.exp(-smooth * dt);
      // Smooth relative to the car so the shot follows at speed.
      const rel = (
        a: [number, number, number],
        b: [number, number, number],
      ) => [
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
      ];
      if (s.kind !== 'roadside') {
        const mv = car.fwd.map(x => x * car.speed * dt);
        this.smoothEye = [
          this.smoothEye[0] + mv[0],
          this.smoothEye[1] + mv[1],
          this.smoothEye[2] + mv[2],
        ];
        this.smoothTarget = [
          this.smoothTarget[0] + mv[0],
          this.smoothTarget[1] + mv[1],
          this.smoothTarget[2] + mv[2],
        ];
      }
      eye = rel(this.smoothEye, eye) as [number, number, number];
      target = rel(this.smoothTarget, target) as [number, number, number];
    }
    this.smoothEye = eye;
    this.smoothTarget = target;
    const focus = Math.hypot(eye[0] - P[0], eye[1] - P[1], eye[2] - P[2]);
    void carLen;
    return {eye, target, up, fov, focus, aperture, interior, shot: s.kind};
  }

  get shotKind(): ShotKind {
    return this.shot.kind;
  }

  setShotTime(t: number) {
    this.shot.t = t;
  }
}
