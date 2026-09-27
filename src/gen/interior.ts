// Procedural car cabin (dashboard, instrument binnacle with gauges, center
// screen and console, steering wheel, seats, mirror, floor). Car-local frame:
// +z forward, +y up, +x left (US left-hand drive: driver at x > 0).
import {CarSpec, MeshData, P3, driverZ, emitGrid} from './car';
import {bodyGeom} from './carBody';

// Catmull-Rom through pts (z, y), `per` samples per segment (+ the end).
function crPath(pts: Array<[number, number]>, per: number) {
  const out: Array<[number, number]> = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; ++i) {
    const p0 = pts[Math.max(i - 1, 0)],
      p1 = pts[i],
      p2 = pts[i + 1],
      p3 = pts[Math.min(i + 2, n - 1)];
    for (let k = 0; k < per; ++k) {
      const t = k / per,
        t2 = t * t,
        t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (-a + c) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

export const MI_DASH = 10;
export const MI_GAUGE = 11;
export const MI_SEAT = 12;
export const MI_WHEEL = 13;
export const MI_SCREEN = 14;
export const MI_ALU = 15;
export const MI_MIRROR = 16;
export const MI_CARPET = 17;
export const MI_FABRIC = 18; // headliner-matching fabric (sun visors)

export interface Interior extends MeshData {
  wheelCenter: [number, number, number];
  wheelTilt: number;
}

export function buildInterior(spec: CarSpec): Interior {
  if (spec.kind === 'trailer')
    return {
      vertices: new Float32Array(0),
      count: 0,
      wheelCenter: [0.37, 1, 0],
      wheelTilt: 0,
    };
  if (spec.kind === 'semi' || spec.kind === 'bus') {
    // A car-style cockpit moved up behind the (far forward) windscreen,
    // plus rows of seats down a bus.
    const ws = 0.95;
    const cab = buildInterior({
      ...spec,
      kind: 'sedan',
      wsBase: ws,
      roofFront: 0.05,
      roofBack: -0.95,
      rearBase: -1.6,
    });
    const dz = spec.wsBase - ws;
    const out: number[] = Array.from(cab.vertices);
    for (let i = 2; i < out.length; i += 8) out[i] += dz;
    if (spec.kind === 'bus') {
      const extra = buildBusSeats(spec);
      for (const x of extra) out.push(x);
    }
    return {
      vertices: new Float32Array(out),
      count: out.length / 8,
      wheelCenter: [
        cab.wheelCenter[0],
        cab.wheelCenter[1],
        cab.wheelCenter[2] + dz,
      ],
      wheelTilt: cab.wheelTilt,
    };
  }
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
  // Dashboard: one lofted surface across the cabin (windscreen base ->
  // top -> rounded lip -> face -> knee area), recessed behind the gauges
  // in front of the driver, with a curved cowl over them.
  const dashFront = ws - 0.44;
  const dashTop = belt - 0.01;
  const zf = dashFront,
    dT = dashTop;
  const bump = (x: number, c: number, r: number) => {
    const u = Math.min(Math.abs(x - c) / r, 1);
    return Math.pow(1 - u * u, 2);
  };
  {
    const cols: number[] = [];
    for (let k = 0; k <= 40; ++k) cols.push(-hw + (2 * hw * k) / 40);
    const rows: P3[][] = [];
    for (const x of cols) {
      const bz = bump(x, dx, 0.26);
      // The lip wraps back a little into the doors.
      const wrap =
        0.06 * Math.pow(Math.max(0, (Math.abs(x) - hw + 0.2) / 0.2), 2);
      const prof = crPath(
        [
          [ws - 0.01, dT - 0.01],
          [ws - 0.18, dT + 0.004],
          [zf + 0.16 + wrap, dT],
          [zf + 0.06 + 0.03 * bz + wrap, dT - 0.016 - 0.004 * bz],
          [zf - 0.004 + 0.034 * bz + wrap, dT - 0.06 + 0.01 * bz],
          [zf + 0.02 * bz + wrap, dT - 0.165],
          [zf + 0.05 + wrap, dT - 0.3],
          [zf + 0.2 + wrap, 0.55],
        ],
        5,
      );
      rows.push(prof.map(([z, y]) => [x, y, z] as P3));
    }
    emitGrid(
      push,
      rows,
      () => MI_DASH,
      p => [0, p[1] - 0.3, zf - p[2] - 0.3],
      false,
    );
    // Cowl over the gauges: its profile collapses onto the dash top at
    // its ends.
    const cowl: P3[][] = [];
    for (let k = 0; k <= 16; ++k) {
      const x = dx - 0.25 + (0.5 * k) / 16;
      const e = Math.pow(Math.sin((Math.PI * k) / 16), 0.6);
      const base: [number, number] = [zf + 0.2, dT - 0.004];
      const prof = crPath(
        [
          [zf + 0.2, dT - 0.004],
          [zf + 0.11, dT + 0.038],
          [zf + 0.02, dT + 0.034],
          [zf - 0.026, dT - 0.004],
          [zf - 0.012, dT - 0.022],
        ],
        4,
      ).map(
        ([z, y]) =>
          [x, base[1] + (y - base[1]) * e, base[0] + (z - base[0]) * e] as P3,
      );
      cowl.push(prof);
    }
    emitGrid(
      push,
      cowl,
      () => MI_DASH,
      () => [0, 1, -0.4],
      false,
    );
  }
  // Aluminium trim strip across the dash.
  quad(
    [-hw, dashTop - 0.16, dashFront - 0.005],
    [hw, dashTop - 0.16, dashFront - 0.005],
    [hw, dashTop - 0.19, dashFront - 0.004],
    [-hw, dashTop - 0.19, dashFront - 0.004],
    MI_ALU,
  );
  // Gauge face in front of the driver, under the cowl.
  quad(
    [dx + 0.19, dashTop - 0.155, dashFront - 0.004],
    [dx - 0.19, dashTop - 0.155, dashFront - 0.004],
    [dx - 0.19, dashTop - 0.025, dashFront + 0.008],
    [dx + 0.19, dashTop - 0.025, dashFront + 0.008],
    MI_GAUGE,
    true,
  );
  // Center screen on a slim bezel.
  box(
    [0, dashTop + 0.025, dashFront + 0.054],
    [0.152, 0.086, 0.01],
    MI_DASH,
    0.26,
  );
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

  // Seats (tan leather).
  const oy = belt - 1.0; // taller cars sit higher
  // Front seats follow the driver's eye (under the roof's middle).
  const sz = driverZ(spec) + 0.6;
  // Lofted seat parts in a local frame (x across, y up the part, z
  // toward its face), tilted back about x like the old boxes.
  // (Tilted about x, then turned by `yaw` about y.)
  const place = (c: number[], tilt: number, yaw = 0) => {
    const cs = Math.cos(tilt),
      sn = Math.sin(tilt);
    const cy = Math.cos(yaw),
      sy = Math.sin(yaw);
    return (p: number[]): P3 => {
      const y = p[1] * cs - p[2] * sn,
        z = p[1] * sn + p[2] * cs;
      return [c[0] + p[0] * cy + z * sy, c[1] + y, c[2] - p[0] * sy + z * cy];
    };
  };
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  // A padded slab: rows along y (-h..h), each a closed section whose face
  // (+z) rises into side bolsters; the top is rounded.
  const pad = (
    c: number[],
    tilt: number,
    hwid: number,
    h: number,
    front: number,
    back: number,
    bolster: number,
    // bolsters from this fraction of the half width (ends of a bench)
    bFrom = 0.55,
    mat = MI_SEAT,
    yaw = 0,
  ) => {
    const T = place(c, tilt, yaw);
    const rows: P3[][] = [];
    const NY = 16;
    for (let i = 0; i <= NY; ++i) {
      const t = i / NY;
      // Rounded ends (top and bottom).
      const endK = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(t * 2 - 1), 6)));
      const wv = hwid * (1 - 0.1 * t) * Math.max(endK, 0.05);
      const y = -h + 2 * h * t;
      const row: P3[] = [];
      for (let k = 0; k <= 32; ++k) {
        const th = (k / 32) * Math.PI * 2;
        const cx = Math.cos(th),
          cz = Math.sin(th);
        const x = Math.sign(cx) * Math.pow(Math.abs(cx), 0.45) * wv;
        const b =
          bolster * smooth(bFrom, 0.95, Math.abs(x) / Math.max(wv, 1e-3));
        const zf = (front + b) * Math.max(endK, 0.3);
        const z =
          cz > 0
            ? Math.pow(cz, 0.4) * zf
            : -Math.pow(-cz, 0.4) * back * Math.max(endK, 0.3);
        row.push(T([x, y, z]));
      }
      rows.push(row);
    }
    const ctr = T([0, 0, 0]);
    emitGrid(
      push,
      rows,
      () => mat,
      p => [p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]] as P3,
      false,
    );
  };
  for (const sx of [dx, -dx]) {
    // Cushion: a pad lying down (its face up), back = underside.
    pad(
      [sx, 0.45 + oy, -0.55 + sz],
      -Math.PI / 2,
      0.25,
      0.26,
      0.05,
      0.06,
      0.04,
    );
    // Back and headrest.
    pad([sx, 0.82 + oy, -0.86 + sz], -0.28, 0.25, 0.34, 0.04, 0.05, 0.06);
    pad(
      [sx, Math.min(1.22 + oy, spec.roofY - 0.16), -0.98 + sz],
      -0.2,
      0.13,
      0.09,
      0.03,
      0.035,
      0.0,
    );
  }
  // Rear bench (visible through the side glass on the outside view).
  if (spec.kind !== 'pickup' && spec.kind !== 'coupe') {
    const rz = spec.rearBase + 0.3;
    pad(
      [0, 0.45 + oy, rz + 0.3],
      -Math.PI / 2,
      hw * 0.8,
      0.22,
      0.05,
      0.06,
      0.03,
      0.85,
    );
    pad([0, 0.72 + oy, rz], -0.25, hw * 0.8, 0.24, 0.04, 0.05, 0.04, 0.85);
  }
  // Console top: leather armrest lid at the back, a gear selector and two
  // cupholders ahead of it.
  pad([0, 0.695, -0.42], -Math.PI / 2, 0.11, 0.2, 0.025, 0.012, 0.01);
  box([0, 0.7, 0.12], [0.012, 0.03, 0.012], MI_ALU);
  pad([0, 0.745, 0.12], -Math.PI / 2, 0.028, 0.04, 0.02, 0.012, 0);
  for (const cz of [0.3, 0.38]) {
    const n = [0, 1, 0];
    for (let k = 0; k < 16; ++k) {
      const a0 = (k / 16) * Math.PI * 2,
        a1 = ((k + 1) / 16) * Math.PI * 2;
      const P = (a: number, r: number) => [
        Math.cos(a) * r,
        0.682,
        cz + Math.sin(a) * r,
      ];
      for (const p of [[0, 0.682, cz], P(a1, 0.036), P(a0, 0.036)])
        push(p, n, MI_CARPET);
      for (const p of [
        P(a0, 0.036),
        P(a1, 0.036),
        P(a1, 0.044),
        P(a0, 0.036),
        P(a1, 0.044),
        P(a0, 0.044),
      ])
        push(p, n, MI_ALU);
    }
  }
  // Door cards: armrest, pull handle, window switches, speaker grille and
  // a trim strip on each door; seatbelts on the B pillars; floor mats.
  {
    const bp = (spec.roofFront + spec.roofBack) / 2;
    const xIn = spec.width / 2 - 0.07; // inner face of the door card
    const ay = belt - 0.26; // armrest top
    const dz = driverZ(spec);
    const doors: Array<[number, number, number, boolean]> = [
      // [armrest centre z, door front z, door back z, front door]
      [dz + 0.18, ws - 0.42, bp + 0.06, true],
    ];
    if (spec.kind !== 'coupe' && spec.kind !== 'pickup')
      doors.push([spec.rearBase + 0.6, bp - 0.06, spec.rearBase + 0.25, false]);
    for (const sgn of [1, -1])
      for (const [az, zf, zb, front] of doors) {
        // Leather armrest pad lying along the door.
        pad(
          [sgn * (xIn - 0.045), ay, az],
          -Math.PI / 2,
          0.045,
          0.19,
          0.018,
          0.03,
          0,
          0.55,
          MI_SEAT,
        );
        // Pull handle recessed above the armrest's front.
        box(
          [sgn * (xIn - 0.012), ay + 0.075, az + 0.12],
          [0.012, 0.012, 0.06],
          MI_ALU,
        );
        if (front)
          box(
            [sgn * (xIn - 0.05), ay + 0.022, az + 0.14],
            [0.028, 0.006, 0.045],
            MI_DASH,
          );
        // Trim strip along the upper door card.
        quad(
          [sgn * (xIn + 0.004), belt - 0.075, zb],
          [sgn * (xIn + 0.004), belt - 0.075, zf],
          [sgn * (xIn + 0.004), belt - 0.09, zf],
          [sgn * (xIn + 0.004), belt - 0.09, zb],
          MI_ALU,
        );
        // Speaker grille (dark disc in a bright ring) low on the door.
        const scz = front ? zf - 0.18 : (zf + zb) / 2,
          scy = 0.47;
        const ring = (r: number, k: number): P3 => {
          const a = (k / 20) * Math.PI * 2;
          return [
            sgn * (xIn - 0.004),
            scy + Math.sin(a) * r,
            scz + Math.cos(a) * r,
          ];
        };
        for (let k = 0; k < 20; ++k) {
          const n = [-sgn, 0, 0];
          for (const p of [
            [sgn * (xIn - 0.005), scy, scz],
            ring(0.07, k),
            ring(0.07, k + 1),
          ])
            push(p, n, MI_DASH);
          for (const p of [
            ring(0.08, k),
            ring(0.08, k + 1),
            ring(0.07, k + 1),
            ring(0.08, k),
            ring(0.07, k + 1),
            ring(0.07, k),
          ])
            push(p, n, MI_ALU);
        }
      }
    // Seatbelts hanging down the B pillars, with the D-ring at the top.
    // The strap's top follows the pillar's inside face (the greenhouse
    // tapers in toward the roof).
    const y0 = spec.roofY - 0.2,
      y1 = belt - 0.32;
    let xTop = xIn - 0.01;
    if (spec.body) {
      const gb = bodyGeom(spec.body);
      const b0 = gb.belt(bp),
        r0 = gb.rail(bp);
      const f = Math.min(Math.max((y0 - b0) / Math.max(r0 - b0, 0.05), 0), 1);
      const xs = gb.beltX(bp) + (gb.railX(bp) - gb.beltX(bp)) * f;
      xTop = Math.min(xTop, xs - 0.04);
    }
    for (const sgn of [1, -1]) {
      const xt = sgn * xTop,
        xb = sgn * (xIn - 0.03);
      quad(
        [xt, y0, bp + 0.025],
        [xt, y0, bp - 0.02],
        [xb, y1, bp - 0.02],
        [xb, y1, bp + 0.025],
        MI_DASH,
      );
      box([xt - sgn * 0.004, y0 + 0.015, bp], [0.006, 0.02, 0.035], MI_ALU);
    }
    // Front floor mats.
    for (const sgn of [1, -1])
      quad(
        [sgn * 0.12, 0.306, ws - 0.55],
        [sgn * 0.62, 0.306, ws - 0.55],
        [sgn * 0.62, 0.306, dz + 0.3],
        [sgn * 0.12, 0.306, dz + 0.3],
        MI_DASH,
      );
  }
  // Floor.
  quad(
    [-hw, 0.3, 0.9],
    [hw, 0.3, 0.9],
    [hw, 0.3, -1.6],
    [-hw, 0.3, -1.6],
    MI_CARPET,
  );
  // Rear-view mirror: a rounded housing on a stem up to the glass, and
  // sun visors folded up under the header.
  {
    // Windscreen height at z (roughly straight from cowl to header).
    const glassY = (z: number) =>
      belt +
      (spec.roofY - belt) *
        Math.min(Math.max((ws - z) / (ws - spec.roofFront), 0), 1);
    // Just under the header, near the top of the windscreen.
    const mz = spec.roofFront + 0.09,
      my = Math.min(spec.roofY - 0.105, glassY(mz) - 0.05);
    // Aimed at the driver's eye, looking back and a little down so the
    // rear window fills it (the mirror sits at roof height).
    const eye = [dx, Math.min(belt + 0.27, spec.roofY - 0.14), driverZ(spec)];
    const e = [eye[0], eye[1] - my, eye[2] - mz];
    const el = Math.hypot(e[0], e[1], e[2]);
    const back = [0, 0.01, -1]; // horizon about mid-mirror
    const bl = Math.hypot(back[0], back[1], back[2]);
    const nv = [
      e[0] / el + back[0] / bl,
      e[1] / el + back[1] / bl,
      e[2] / el + back[2] / bl,
    ];
    const nl = Math.hypot(nv[0], nv[1], nv[2]);
    const [nx, ny, nz] = nv.map(x => x / nl);
    const pitch = Math.asin(ny),
      yaw = Math.atan2(-nx, -nz);
    pad(
      [0, my, mz],
      Math.PI + pitch,
      0.125,
      0.038,
      0.012,
      0.024,
      0,
      0.55,
      MI_DASH,
      yaw,
    );
    // The glass follows the housing's own (rounded, tapering) outline,
    // inset so a rim of the housing frames it, just proud of its face.
    const G = place([0, my, mz], Math.PI + pitch, yaw);
    const gRow = (t: number) => {
      const endK = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(t * 2 - 1), 6)));
      const w = 0.86 * 0.125 * (1 - 0.1 * t) * endK;
      const y = (-0.038 + 0.076 * t) * 0.97;
      // A flat pane (a curved one gave every strip its own normal: the
      // reflection broke into bands).
      const z = 0.0125;
      return {w, y, z};
    };
    const GN = 14;
    for (let i = 0; i < GN; ++i) {
      const a = gRow(0.06 + (0.88 * i) / GN),
        b = gRow(0.06 + (0.88 * (i + 1)) / GN);
      quad(
        G([-a.w, a.y, a.z]),
        G([a.w, a.y, a.z]),
        G([b.w, b.y, b.z]),
        G([-b.w, b.y, b.z]),
        MI_MIRROR,
      );
    }
    // Short stem up and forward to the glass.
    const top = [0, Math.min(spec.roofY - 0.05, glassY(mz + 0.03)), mz + 0.03];
    const bot = [0, my + 0.02, mz + 0.012];
    const r = 0.011;
    const d = [top[0] - bot[0], top[1] - bot[1], top[2] - bot[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const ax = d.map(x => x / len);
    const s1 = [1, 0, 0];
    const s2 = [
      ax[1] * s1[2] - ax[2] * s1[1],
      ax[2] * s1[0] - ax[0] * s1[2],
      ax[0] * s1[1] - ax[1] * s1[0],
    ];
    const P = (e: number[], a: number, b: number) =>
      [0, 1, 2].map(k => e[k] + s1[k] * a * r + s2[k] * b * r);
    const sq = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ];
    for (let k = 0; k < 4; ++k) {
      const [a0, b0] = sq[k],
        [a1, b1] = sq[(k + 1) % 4];
      quad(
        P(bot, a0, b0),
        P(bot, a1, b1),
        P(top, a1, b1),
        P(top, a0, b0),
        MI_DASH,
      );
    }
    for (const sx of [dx, -dx])
      pad(
        [sx * 0.9, spec.roofY - 0.028, spec.roofFront - 0.13],
        Math.PI / 2,
        0.14,
        0.068,
        0.007,
        0.008,
        0,
        0.55,
        MI_FABRIC,
      );
  }
  // Steering wheel (built around its own center; rotated in the shader).
  const wc: [number, number, number] = [dx, dashTop - 0.06, dashFront - 0.26];
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
  // Padded airbag hub: a rounded cushion bulging toward the driver.
  const at = (du: number, dw: number, da: number): P3 => [
    wc[0] + u[0] * du + w[0] * dw + axis[0] * da,
    wc[1] + u[1] * du + w[1] * dw + axis[1] * da,
    wc[2] + u[2] * du + w[2] * dw + axis[2] * da,
  ];
  {
    const rows: P3[][] = [];
    const rho = [0, 0.3, 0.55, 0.75, 0.88, 0.96, 1, 1.02];
    for (const r of rho) {
      const off =
        r <= 1 ? 0.012 + 0.03 * Math.sqrt(Math.max(0, 1 - r ** 4)) : -0.015;
      const row: P3[] = [];
      for (let k = 0; k <= 24; ++k) {
        const th = (k / 24) * Math.PI * 2;
        const cx = Math.cos(th),
          cy = Math.sin(th);
        const ex = Math.sign(cx) * Math.pow(Math.abs(cx), 0.7),
          ey = Math.sign(cy) * Math.pow(Math.abs(cy), 0.7);
        row.push(at(ex * 0.085 * r, ey * 0.065 * r, off));
      }
      rows.push(row);
    }
    emitGrid(
      push,
      rows,
      () => MI_WHEEL,
      p => [0, 1, 2].map(k => p[k] - wc[k] + axis[k] * 0.05) as P3,
      false,
    );
  }
  // Three spokes: lofted bars with an elliptical section, tapering from
  // the hub to the rim and set back slightly (a shallow dish).
  for (const ang of [0, Math.PI, Math.PI / 2]) {
    const ca = Math.cos(ang),
      sa = Math.sin(ang);
    const rows: P3[][] = [];
    for (let i = 0; i <= 6; ++i) {
      const t = i / 6;
      const r = 0.07 + (ringR - 0.075) * t;
      const half = (ang === Math.PI / 2 ? 0.035 : 0.028) * (1 - 0.35 * t);
      const thick = 0.009;
      const off = 0.012 * (1 - t);
      const row: P3[] = [];
      for (let k = 0; k <= 10; ++k) {
        const th = (k / 10) * Math.PI * 2;
        const sd = Math.cos(th) * half,
          ax = Math.sin(th) * thick;
        // radial dir (ca, sa) in the (u, w) plane; side dir perpendicular.
        row.push(at(ca * r - sa * sd, sa * r + ca * sd, off + ax));
      }
      rows.push(row);
    }
    emitGrid(
      push,
      rows,
      () => MI_WHEEL,
      p => {
        const c = at(ca * 0.12, sa * 0.12, 0.006);
        return [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      },
      false,
    );
  }
  // Steering column shroud from the wheel back into the dash.
  {
    const c0 = [0, 1, 2].map(k => wc[k] - axis[k] * 0.03);
    const c1 = [0, 1, 2].map(k => wc[k] - axis[k] * 0.32);
    const ring = (c: number[], r: number, a: number): P3 =>
      [0, 1, 2].map(
        k => c[k] + (u[k] * Math.cos(a) + w[k] * Math.sin(a)) * r,
      ) as P3;
    const rows: P3[][] = [];
    for (const [c, r] of [
      [c0, 0.032],
      [c1, 0.05],
    ] as Array<[number[], number]>) {
      const row: P3[] = [];
      for (let k = 0; k <= 12; ++k)
        row.push(ring(c, r, (k / 12) * Math.PI * 2));
      rows.push(row);
    }
    emitGrid(
      push,
      rows,
      () => MI_DASH,
      p => [p[0] - wc[0], p[1] - wc[1], 0] as P3,
      false,
    );
  }
  const out = new Float32Array(v);
  return {
    vertices: out,
    count: out.length / 8,
    wheelCenter: wc,
    wheelTilt: tilt,
  };
}

// Pairs of seats down both sides of a bus (cushion + back), as flat-shaded
// boxes in the interior vertex format.
function buildBusSeats(spec: CarSpec): number[] {
  const v: number[] = [];
  const box = (c: number[], h: number[]) => {
    const faces: Array<[number[], number[], number[]]> = [
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [-1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      [
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 0],
      ],
      [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
      [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, -1],
        [0, 1, 0],
        [1, 0, 0],
      ],
    ];
    for (const [n, u, w] of faces) {
      const p = (a: number, b: number) => [
        c[0] + (n[0] + u[0] * a + w[0] * b) * h[0],
        c[1] + (n[1] + u[1] * a + w[1] * b) * h[1],
        c[2] + (n[2] + u[2] * a + w[2] * b) * h[2],
      ];
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, -1],
        [1, 1],
        [-1, 1],
      ])
        v.push(...p(a, b), ...n, MI_SEAT, 0);
    }
  };
  for (let z = spec.wsBase - 2.7; z > spec.rearBase + 0.7; z -= 0.85) {
    for (const sx of [-1, 1]) {
      box([sx * 0.78, 0.92, z], [0.44, 0.06, 0.22]);
      box([sx * 0.78, 1.3, z - 0.22], [0.44, 0.34, 0.05]);
    }
  }
  return v;
}
