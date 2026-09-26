// Procedural car cabin (dashboard, instrument binnacle with gauges, center
// screen and console, steering wheel, seats, mirror, floor). Car-local frame:
// +z forward, +y up, +x left (US left-hand drive: driver at x > 0).
import {CarSpec, MeshData} from './car';

export const MI_DASH = 10;
export const MI_GAUGE = 11;
export const MI_SEAT = 12;
export const MI_WHEEL = 13;
export const MI_SCREEN = 14;
export const MI_ALU = 15;
export const MI_MIRROR = 16;
export const MI_CARPET = 17;

export interface Interior extends MeshData {
  wheelCenter: [number, number, number];
  wheelTilt: number;
}

export function buildInterior(spec: CarSpec): Interior {
  const v: number[] = [];
  const push = (p: number[], n: number[], m: number) =>
    v.push(p[0], p[1], p[2], n[0], n[1], n[2], m, 0);
  const quad = (
    a: number[],
    b: number[],
    c: number[],
    d: number[],
    m: number,
    uv = false,
  ) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map(x => x / l);
    // For gauge/screen quads the material id carries uv in the fractional
    // part of the pad slot: we encode uv via vertex order instead (a=00,b=10,c=11,d=01).
    const uvs = uv
      ? [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ]
      : [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ];
    const P = [a, b, c, d];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      v.push(
        P[i][0],
        P[i][1],
        P[i][2],
        n[0],
        n[1],
        n[2],
        m,
        uvs[i][0] + uvs[i][1] * 2,
      );
    }
  };
  const box = (c: number[], h: number[], m: number, tiltX = 0) => {
    const cs = Math.cos(tiltX),
      sn = Math.sin(tiltX);
    const R = (p: number[]) => [
      p[0],
      p[1] * cs - p[2] * sn,
      p[1] * sn + p[2] * cs,
    ];
    const corner = (x: number, y: number, z: number) => {
      const r = R([x * h[0], y * h[1], z * h[2]]);
      return [c[0] + r[0], c[1] + r[1], c[2] + r[2]];
    };
    const f = [
      [
        [1, -1, -1],
        [1, -1, 1],
        [1, 1, 1],
        [1, 1, -1],
      ],
      [
        [-1, -1, 1],
        [-1, -1, -1],
        [-1, 1, -1],
        [-1, 1, 1],
      ],
      [
        [-1, 1, -1],
        [1, 1, -1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
      [
        [-1, -1, 1],
        [1, -1, 1],
        [1, -1, -1],
        [-1, -1, -1],
      ],
      [
        [1, -1, 1],
        [-1, -1, 1],
        [-1, 1, 1],
        [1, 1, 1],
      ],
      [
        [-1, -1, -1],
        [1, -1, -1],
        [1, 1, -1],
        [-1, 1, -1],
      ],
    ];
    for (const q of f)
      quad(
        corner(q[0][0], q[0][1], q[0][2]),
        corner(q[1][0], q[1][1], q[1][2]),
        corner(q[2][0], q[2][1], q[2][2]),
        corner(q[3][0], q[3][1], q[3][2]),
        m,
      );
  };
  const hw = spec.width / 2 - 0.1;
  const belt = spec.belt;
  const ws = spec.wsBase;
  const dx = 0.37; // driver lateral position
  // Dashboard: top slab sloping from the windshield base toward the driver.
  const dashFront = 0.42;
  const dashTop = belt - 0.01;
  quad(
    [-hw, dashTop, ws - 0.02],
    [hw, dashTop, ws - 0.02],
    [hw, dashTop - 0.06, dashFront + 0.12],
    [-hw, dashTop - 0.06, dashFront + 0.12],
    MI_DASH,
  );
  // Rounded lip and front face toward the occupants.
  quad(
    [-hw, dashTop - 0.06, dashFront + 0.12],
    [hw, dashTop - 0.06, dashFront + 0.12],
    [hw, dashTop - 0.14, dashFront],
    [-hw, dashTop - 0.14, dashFront],
    MI_DASH,
  );
  quad(
    [-hw, dashTop - 0.14, dashFront],
    [hw, dashTop - 0.14, dashFront],
    [hw, 0.55, dashFront + 0.05],
    [-hw, 0.55, dashFront + 0.05],
    MI_DASH,
  );
  // Aluminium trim strip across the dash.
  quad(
    [-hw, dashTop - 0.16, dashFront - 0.005],
    [hw, dashTop - 0.16, dashFront - 0.005],
    [hw, dashTop - 0.19, dashFront - 0.004],
    [-hw, dashTop - 0.19, dashFront - 0.004],
    MI_ALU,
  );
  // Instrument binnacle (hood) and gauge face in front of the driver.
  box([dx, dashTop + 0.01, dashFront + 0.1], [0.2, 0.05, 0.1], MI_DASH);
  quad(
    [dx + 0.19, dashTop - 0.13, dashFront - 0.004],
    [dx - 0.19, dashTop - 0.13, dashFront - 0.004],
    [dx - 0.19, dashTop - 0.0, dashFront + 0.02],
    [dx + 0.19, dashTop - 0.0, dashFront + 0.02],
    MI_GAUGE,
    true,
  );
  // Center screen.
  quad(
    [0.14, dashTop - 0.05, dashFront + 0.02],
    [-0.14, dashTop - 0.05, dashFront + 0.02],
    [-0.14, dashTop + 0.1, dashFront + 0.06],
    [0.14, dashTop + 0.1, dashFront + 0.06],
    MI_SCREEN,
    true,
  );
  // Center console.
  box([0, 0.5, -0.1], [0.12, 0.18, 0.55], MI_DASH);
  box([0, 0.69, -0.45], [0.1, 0.02, 0.2], MI_ALU);
  // Seats (tan leather).
  const oy = belt - 1.0; // taller cars sit higher
  // Front seats follow the driver's eye (under the roof's middle).
  const sz = (spec.roofFront + spec.roofBack) / 2 - 0.15 + 0.6;
  for (const sx of [dx, -dx]) {
    box([sx, 0.45 + oy, -0.55 + sz], [0.25, 0.07, 0.26], MI_SEAT);
    box([sx, 0.82 + oy, -0.86 + sz], [0.25, 0.34, 0.07], MI_SEAT, -0.28);
    box([sx, 1.22 + oy, -0.98 + sz], [0.13, 0.09, 0.06], MI_SEAT, -0.2);
  }
  // Rear bench (visible through the side glass on the outside view).
  if (spec.kind !== 'pickup') {
    const rz = spec.rearBase + 0.25;
    box([0, 0.45 + oy, rz + 0.32], [hw - 0.05, 0.07, 0.24], MI_SEAT);
    box([0, 0.76 + oy, rz], [hw - 0.05, 0.3, 0.07], MI_SEAT, -0.25);
  }
  // Floor.
  quad(
    [-hw, 0.3, 0.9],
    [hw, 0.3, 0.9],
    [hw, 0.3, -1.6],
    [-hw, 0.3, -1.6],
    MI_CARPET,
  );
  // Rear-view mirror.
  box([0, belt + 0.33, ws - 0.42], [0.12, 0.035, 0.012], MI_DASH);
  quad(
    [0.115, belt + 0.3, ws - 0.435],
    [-0.115, belt + 0.3, ws - 0.435],
    [-0.115, belt + 0.36, ws - 0.435],
    [0.115, belt + 0.36, ws - 0.435],
    MI_MIRROR,
    true,
  );
  // Steering wheel (built around its own center; rotated in the shader).
  const wc: [number, number, number] = [dx, dashTop - 0.06, 0.16];
  const tilt = 0.4; // radians back from vertical
  const ringR = 0.185,
    tubeR = 0.017;
  const N = 36,
    M = 8;
  const axis = [0, Math.sin(tilt), -Math.cos(tilt)]; // toward driver
  const u = [1, 0, 0];
  const w = [
    axis[1] * u[2] - axis[2] * u[1],
    axis[2] * u[0] - axis[0] * u[2],
    axis[0] * u[1] - axis[1] * u[0],
  ];
  const ringPt = (a: number, b: number) => {
    const ca = Math.cos(a),
      sa = Math.sin(a);
    const cb = Math.cos(b),
      sb = Math.sin(b);
    const radial = [
      u[0] * ca + w[0] * sa,
      u[1] * ca + w[1] * sa,
      u[2] * ca + w[2] * sa,
    ];
    const n = [
      radial[0] * cb + axis[0] * sb,
      radial[1] * cb + axis[1] * sb,
      radial[2] * cb + axis[2] * sb,
    ];
    const p = [0, 1, 2].map(k => wc[k] + radial[k] * ringR + n[k] * tubeR);
    return {p, n};
  };
  for (let i = 0; i < N; ++i) {
    for (let j = 0; j < M; ++j) {
      const a0 = (i / N) * Math.PI * 2,
        a1 = ((i + 1) / N) * Math.PI * 2;
      const b0 = (j / M) * Math.PI * 2,
        b1 = ((j + 1) / M) * Math.PI * 2;
      const A = ringPt(a0, b0),
        B = ringPt(a1, b0),
        C = ringPt(a1, b1),
        D = ringPt(a0, b1);
      for (const q of [A, B, C, A, C, D]) push(q.p, q.n, MI_WHEEL);
    }
  }
  // Spokes (3) + hub.
  const spoke = (ang: number) => {
    const dir = [
      u[0] * Math.cos(ang) + w[0] * Math.sin(ang),
      u[1] * Math.cos(ang) + w[1] * Math.sin(ang),
      u[2] * Math.cos(ang) + w[2] * Math.sin(ang),
    ];
    const mid = [0, 1, 2].map(k => wc[k] + dir[k] * ringR * 0.5);
    const side = [
      dir[1] * axis[2] - dir[2] * axis[1],
      dir[2] * axis[0] - dir[0] * axis[2],
      dir[0] * axis[1] - dir[1] * axis[0],
    ];
    const e = (s: number, t: number, o: number) =>
      [0, 1, 2].map(
        k =>
          mid[k] + dir[k] * s * ringR * 0.5 + side[k] * t * 0.025 + axis[k] * o,
      );
    quad(
      e(-1, -1, 0.01),
      e(1, -1, 0.01),
      e(1, 1, 0.01),
      e(-1, 1, 0.01),
      MI_WHEEL,
    );
  };
  spoke(0);
  spoke(Math.PI);
  spoke(-Math.PI / 2);
  box([wc[0], wc[1], wc[2]], [0.06, 0.06, 0.035], MI_WHEEL, -tilt);
  const out = new Float32Array(v);
  return {
    vertices: out,
    count: out.length / 8,
    wheelCenter: wc,
    wheelTilt: tilt,
  };
}
