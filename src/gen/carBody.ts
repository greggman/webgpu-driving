// Car bodies from a curve network (the way car bodies are designed: a set
// of character lines, surfaced between them).
//
// A vehicle's shape is data (see src/gen/bodies/*.ts): side-view heights
// and plan-view widths of its character lines as functions of z (car-local,
// +z forward, +x left, +y up, origin on the ground midway between the
// axles when axleShift = 0):
//
//   top      centre-line silhouette: nose, hood centre, windscreen, roof,
//            backlight, deck, tail
//   bottom   underside at the centre
//   belt     beltline: hood / fender edge -> window base -> deck edge
//   shoulder the shoulder crease (the widest line, just below the belt)
//   rocker   the sill corner
//   rail     roof side rail over the cabin (A pillar -> roof -> C pillar);
//            outside the cabin the rail is the belt
//   width    plan-view half width of the shoulder line (reaches 0 at the
//            nose and tail: the fascias are where the plan curve turns in)
//   *In      other lines' widths as fractions of `width`
//
// Every cross-section is one smooth interpolating spline through the
// points where those lines cross it (bottom centre -> sill -> lower door
// -> shoulder -> belt -> roof rail -> roof centre), so the lower body and
// the greenhouse are a single continuous skin. Windows, pillars and panels
// are regions of that skin, not separate shells. Wheel arches are trimmed
// out of it (the skin is pulled up onto the arch circle and a liner closes
// the well); flares come only from the width curve.
import {
  CarSpec,
  MeshData,
  MAT_CHROME,
  MAT_FRONT,
  MAT_GLASS,
  MAT_PAINT,
  MAT_PLATE,
  MAT_REAR,
  MAT_TRIM,
  MAT_UNDER,
  box,
  emitGrid,
  orient,
  P3,
} from './car';

export type Knots = Array<[number, number]>; // (z, value)

function sm(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface BodyCurves {
  top: Knots;
  bottom: Knots;
  belt: Knots;
  shoulder: Knots;
  rocker: Knots;
  rail: Knots; // only over the cabin: from windscreen base to rear-glass base
  width: Knots;
  beltIn: Knots | number; // belt x / width (tumblehome starts here)
  railIn: Knots | number; // roof rail x / width over the cabin
  rockerIn: number; // sill corner x / width
  doorIn: Knots | number; // lower-door x / width (tuck under the shoulder)
  // Lower door character line height (the door section point sits on it);
  // default: 45% of the way from the rocker to the shoulder.
  doorLine?: Knots;
  // Raked fascias: above `bumperY` the upper nose / tail sits `depth`
  // metres behind the bumper face.
  noseRake?: {bumperY: number; depth: number};
  tailRake?: {bumperY: number; depth: number};
  cabin: {
    windscreenBase: number; // z where the windscreen meets the cowl
    roofFront: number; // z of the windscreen header
    roofBack: number; // z where the backlight starts
    rearGlassBase: number; // z where the backlight meets the deck
    sideFront: number; // z where the side glass starts (behind the A pillar)
    sideRear: number; // z where the side glass ends (C pillar)
    pillars: number[]; // z of the B (and other) pillars
    pillarWidth: number;
    quarterLight?: [number, number]; // z range of a small window behind the C pillar
  };
  chromeSill?: boolean; // thin chrome window seal
}

// ---- Curves ----

// Monotone cubic interpolation (Fritsch-Carlson) of knots sorted by z: no
// overshoot between knots, so a designer's line stays where it's put.
export function makeCurve(knots: Knots): (z: number) => number {
  const k = [...knots].sort((a, b) => a[0] - b[0]);
  const n = k.length;
  if (n === 1) return () => k[0][1];
  const d: number[] = [];
  for (let i = 0; i < n - 1; ++i)
    d.push((k[i + 1][1] - k[i][1]) / Math.max(k[i + 1][0] - k[i][0], 1e-6));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; ++i)
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; ++i) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i],
      b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (z: number) => {
    if (z <= k[0][0]) return k[0][1];
    if (z >= k[n - 1][0]) return k[n - 1][1];
    let i = 0;
    while (i < n - 2 && z > k[i + 1][0]) i++;
    const h = k[i + 1][0] - k[i][0];
    const t = (z - k[i][0]) / h;
    const t2 = t * t,
      t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * k[i][1] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * k[i + 1][1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

const asCurve = (v: Knots | number) =>
  typeof v === 'number' ? () => v : makeCurve(v);

// Centripetal Catmull-Rom through 2D points (no cusps or loops), sampled
// with `counts[i]` steps on span i. Returns the samples and the span index
// of each one.
function spline2(
  pts: Array<[number, number]>,
  counts: number[],
): {p: Array<[number, number]>; span: number[]} {
  // Mirror the ends across x = 0 so the section meets the centre line
  // horizontally (smooth across the symmetry plane).
  const P = [
    [-pts[1][0], pts[1][1]] as [number, number],
    ...pts,
    [-pts[pts.length - 2][0], pts[pts.length - 2][1]] as [number, number],
  ];
  const out: Array<[number, number]> = [];
  const span: number[] = [];
  const dist = (a: number[], b: number[]) =>
    Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-4);
  for (let s = 0; s < pts.length - 1; ++s) {
    const p0 = P[s],
      p1 = P[s + 1],
      p2 = P[s + 2],
      p3 = P[s + 3];
    const t0 = 0,
      t1 = t0 + dist(p0, p1),
      t2 = t1 + dist(p1, p2),
      t3 = t2 + dist(p2, p3);
    const n = counts[s];
    for (let q = 0; q < n; ++q) {
      const t = t1 + ((t2 - t1) * q) / n;
      const lerp = (a: number[], b: number[], ta: number, tb: number) => {
        const w = (t - ta) / Math.max(tb - ta, 1e-9);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const a1 = lerp(p0, p1, t0, t1),
        a2 = lerp(p1, p2, t1, t2),
        a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2),
        b2 = lerp(a2, a3, t1, t3);
      const c = lerp(b1, b2, t1, t2);
      out.push([c[0], c[1]]);
      span.push(s);
    }
  }
  out.push(pts[pts.length - 1]);
  span.push(pts.length - 2);
  return {p: out, span};
}

// Samples per span, bottom centre -> roof centre:
// underside, sill, lower door, door->shoulder, shoulder->belt, side glass,
// roof rail curve, roof.
const SPAN_COUNTS = [4, 4, 6, 7, 5, 12, 6, 7];
const SPAN_GLASS = 5;

export interface BodyGeom {
  belt: (z: number) => number;
  halfWidth: (z: number) => number; // skin half width at the shoulder
  beltX: (z: number) => number;
  rail: (z: number) => number;
  top: (z: number) => number;
  bottom: (z: number) => number;
}

export function bodyGeom(c: BodyCurves): BodyGeom {
  const top = makeCurve(c.top),
    bottom = makeCurve(c.bottom),
    belt = makeCurve(c.belt),
    width = makeCurve(c.width),
    beltIn = asCurve(c.beltIn);
  const railK = makeCurve(c.rail);
  const cab = c.cabin;
  const inCabin = (z: number) =>
    z > cab.rearGlassBase && z < cab.windscreenBase;
  return {
    belt,
    halfWidth: z => Math.max(width(z), 0),
    beltX: z => Math.max(width(z), 0) * beltIn(z),
    rail: z => (inCabin(z) ? Math.max(railK(z), belt(z)) : belt(z)),
    top,
    bottom,
  };
}

export function buildCurveBody(sp: CarSpec, c: BodyCurves): MeshData {
  const verts: number[] = [];
  const push = (p: number[], n: number[], m: number) => {
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], m, 0);
  };
  const L = sp.length,
    R = sp.wheelR;
  const nose = L / 2,
    tail = -L / 2;
  const axles = [
    sp.wheelbase / 2 + sp.axleShift,
    -sp.wheelbase / 2 + sp.axleShift,
  ];
  const g = bodyGeom(c);
  const shoulder = makeCurve(c.shoulder),
    rocker = makeCurve(c.rocker),
    doorIn = asCurve(c.doorIn),
    doorLine = c.doorLine ? makeCurve(c.doorLine) : null,
    width = makeCurve(c.width),
    beltIn = asCurve(c.beltIn),
    railIn = asCurve(c.railIn);
  const cab = c.cabin;
  const inCabin = (z: number) =>
    z > cab.rearGlassBase && z < cab.windscreenBase;

  // Section half (x >= 0) through the character lines at z.
  const sectionHalf = (z: number) => {
    const W = Math.max(width(z), 0);
    const bot = g.bottom(z),
      rk = Math.max(rocker(z), bot + 0.005),
      sh = Math.max(shoulder(z), rk + 0.01),
      bl = Math.max(g.belt(z), sh + 0.005);
    const bx = W * beltIn(z);
    const ry = Math.max(g.rail(z), bl);
    // The roof rail blends into the belt over 0.1 m at the cabin ends.
    const fr = inCabin(z)
      ? Math.min(
          1,
          (z - cab.rearGlassBase) / 0.1,
          (cab.windscreenBase - z) / 0.1,
        )
      : 0;
    const rx = bx + (W * railIn(z) - bx) * Math.max(fr, 0);
    const dl = doorLine
      ? Math.min(Math.max(doorLine(z), rk + 0.01), sh - 0.01)
      : rk + (sh - rk) * 0.45;
    const tp = Math.max(g.top(z), bot + 0.02);
    const pts: Array<[number, number]> = [
      [0, bot],
      [W * c.rockerIn * 0.82, bot + (rk - bot) * 0.15],
      [W * c.rockerIn, rk],
      [W * doorIn(z), dl],
      [W, sh],
      [bx, bl],
      [rx, ry + 0.0005],
      [rx * 0.5, ry + (tp - ry) * 0.82],
      [0, tp],
    ];
    return spline2(pts, SPAN_COUNTS);
  };

  // Stations: fine everywhere, finer at the ends (where the plan curve
  // turns in to form the fascias) and at the wheel arches.
  const archR = R + 0.02;
  const zs: number[] = [];
  for (let z = tail; z <= nose + 1e-6; z += 0.03) zs.push(z);
  for (const [a, b] of [
    [nose - 0.45, nose],
    [tail, tail + 0.45],
  ])
    for (let z = a; z <= b + 1e-6; z += 0.008) zs.push(z);
  for (const az of axles)
    for (let q = 0; q <= 40; ++q)
      zs.push(az + (archR + 0.06) * ((q / 40) * 2 - 1));
  zs.push(nose, tail);
  const Z = [...new Set(zs.map(z => Math.round(z * 1e4) / 1e4))]
    .filter(z => z >= tail && z <= nose)
    .sort((a, b) => b - a);

  // Wheel arches: pull the outer skin up onto the arch circle (this trims
  // the opening; inboard the skin stays, forming the well's inner wall).
  const xIn = sp.track / 2 - 0.2;
  const trimArch = (x: number, y: number, z: number): number => {
    for (const az of axles) {
      const dz = z - az;
      if (Math.abs(dz) >= archR) continue;
      const yA = R + Math.sqrt(archR * archR - dz * dz);
      if (y >= yA) continue;
      const w = Math.min(1, Math.max(0, (Math.abs(x) - xIn) / 0.015));
      y += (yA - y) * w;
    }
    return y;
  };

  const grid: P3[][] = [];
  let spans: number[] = [];
  for (const z of Z) {
    const {p, span} = sectionHalf(z);
    spans = span;
    const ring: P3[] = [];
    // Raked fascias: the upper nose / tail leans back from the bumper.
    const zr = (y: number) => {
      let zz = z;
      if (c.noseRake) {
        const r = c.noseRake;
        zz -=
          r.depth *
          sm(r.bumperY, r.bumperY + 0.25, y) *
          sm(nose - 0.5, nose, z);
      }
      if (c.tailRake) {
        const r = c.tailRake;
        zz +=
          r.depth *
          sm(r.bumperY, r.bumperY + 0.25, y) *
          sm(tail + 0.5, tail, z);
      }
      return zz;
    };
    for (let k = 0; k < p.length; ++k) {
      const y = trimArch(p[k][0], p[k][1], z);
      ring.push([-p[k][0], y, zr(y)]);
    }
    for (let k = p.length - 2; k >= 0; --k) {
      const y = trimArch(p[k][0], p[k][1], z);
      ring.push([p[k][0], y, zr(y)]);
    }
    grid.push(ring);
  }
  const H = spans.length; // half-ring samples
  const RN = grid[0].length;
  // First sample index of each span (for window seals / frames).
  const spanStart: number[] = [];
  spans.forEach((s, k) => {
    if (spanStart[s] === undefined) spanStart[s] = k;
  });
  const near = (z: number, zc: number, w: number) => Math.abs(z - zc) < w;

  const mat = (i: number, j: number): number => {
    const z = (Z[i] + Z[i + 1]) / 2;
    const k = j < H ? j : RN - 2 - j;
    const s = spans[Math.min(k, H - 1)];
    const first = k === spanStart[s];
    if (s <= 1) return MAT_UNDER;
    // Fascias (the shader draws lamps / grille / plates there).
    const end =
      z > nose - 0.35 ? MAT_FRONT : z < tail + 0.35 ? MAT_REAR : MAT_PAINT;
    if (s === 2 && first) return MAT_TRIM; // sill line
    if (s < SPAN_GLASS) return end;
    const cabin = inCabin(z);
    if (s === SPAN_GLASS) {
      if (!cabin) return end;
      const last = k === spanStart[s + 1] - 1;
      if (first) return c.chromeSill ? MAT_CHROME : MAT_TRIM; // window seal
      if (last) return MAT_TRIM; // frame / drip rail
      const ql = cab.quarterLight;
      if (ql && z > ql[0] && z < ql[1]) return MAT_GLASS;
      if (z > cab.sideFront || z < cab.sideRear) return MAT_PAINT; // A / C pillars
      for (const pz of cab.pillars)
        if (near(z, pz, cab.pillarWidth / 2)) return MAT_TRIM;
      return MAT_GLASS;
    }
    // Roof rail / roof: windscreen and backlight.
    const ws = z > cab.roofFront && z < cab.windscreenBase;
    const back = z < cab.roofBack && z > cab.rearGlassBase;
    if (ws || back) {
      if (s === 6 && first) return MAT_PAINT; // A / C pillar edge
      if (
        near(z, cab.windscreenBase, 0.035) ||
        near(z, cab.rearGlassBase, 0.035)
      )
        return MAT_TRIM; // cowl / deck seal
      return MAT_GLASS;
    }
    return end;
  };
  emitGrid(push, grid, mat, p => [p[0], p[1] - 0.6, p[2] * 0.25], true);

  // Wheel-well liners (dark half tubes) closing the trimmed arches.
  for (const az of axles) {
    for (const sx of [-1, 1]) {
      const rad = archR + 0.005;
      const x0 = sx * 0.2,
        x1 = sx * width(az) * c.rockerIn * 0.99;
      const lg: P3[][] = [];
      for (let a = 0; a <= 16; ++a) {
        const th = ((-25 + (a / 16) * 230) * Math.PI) / 180;
        lg.push([
          [x0, R + Math.sin(th) * rad, az + Math.cos(th) * rad],
          [x1, R + Math.sin(th) * rad, az + Math.cos(th) * rad],
        ]);
      }
      emitGrid(
        push,
        lg,
        () => MAT_UNDER,
        p => [0, R - p[1], az - p[2]],
        false,
      );
      const cn = [-sx, 0, 0];
      for (let a = 0; a < lg.length - 1; ++a) {
        push([x0, R, az], cn, MAT_UNDER);
        push(lg[a][0], cn, MAT_UNDER);
        push(lg[a + 1][0], cn, MAT_UNDER);
      }
    }
  }

  // ---- Details ----
  // Mirrors: rounded housings on stalks from the door sail.
  for (const sx of [-1, 1]) {
    const z = cab.windscreenBase - 0.16;
    const wz = g.beltX(z);
    const y = g.belt(z) + 0.1;
    const mw = 0.2,
      mh = 0.13,
      md = 0.09;
    const x0 = sx * (wz + 0.1);
    const mg: P3[][] = [];
    for (let a = 0; a <= 10; ++a) {
      const t = a / 10;
      const sc = Math.pow(
        Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.92)),
        0.35,
      );
      const row: P3[] = [];
      for (let b = 0; b <= 16; ++b) {
        const th = (b / 16) * Math.PI * 2;
        const cz = Math.cos(th),
          sy = Math.sin(th);
        const dz = cz > 0 ? cz * md : cz * 0.012;
        row.push([
          x0 + sx * (t - 0.5) * mw,
          y + sy * mh * 0.5 * sc,
          z - 0.02 + dz * sc,
        ]);
      }
      mg.push(row);
    }
    emitGrid(
      push,
      mg,
      () => MAT_PAINT,
      p => [p[0] - x0, p[1] - y, p[2] - z + 0.02],
      true,
    );
    box(push, [x0, y, z - 0.028], [mw * 0.38, mh * 0.32, 0.003], MAT_TRIM);
    box(push, [sx * (wz + 0.01), y - 0.06, z], [0.07, 0.03, 0.045], MAT_PAINT);
  }
  // Door handles.
  const doorZ = [
    (cab.sideFront + (cab.pillars[0] ?? cab.sideRear)) / 2 - 0.25,
    ...(cab.pillars.length ? [cab.pillars[0] - 0.35] : []),
  ];
  for (const sx of [-1, 1])
    for (const z of doorZ) {
      const y = g.belt(z) - 0.1;
      box(
        push,
        [sx * (width(z) * 0.985 + 0.004), y, z],
        [0.008, 0.013, 0.07],
        MAT_CHROME,
      );
    }
  // Plates.
  // Plates sit on the skin at their height (the fascias may be raked).
  const faceZ = (y: number, front: boolean) => {
    let best = front ? -1e9 : 1e9;
    for (const ring of grid)
      for (const q of ring)
        if (Math.abs(q[0]) < 0.12 && Math.abs(q[1] - y) < 0.04)
          best = front ? Math.max(best, q[2]) : Math.min(best, q[2]);
    return Math.abs(best) > 1e8 ? (front ? nose : tail) : best;
  };
  const fy = sp.headlightY - 0.32,
    ry = sp.taillightY - 0.3;
  box(push, [0, fy, faceZ(fy, true) + 0.004], [0.26, 0.06, 0.006], MAT_PLATE);
  box(push, [0, ry, faceZ(ry, false) - 0.004], [0.26, 0.065, 0.006], MAT_PLATE);

  const out = orient(new Float32Array(verts));
  return {vertices: out, count: out.length / 8};
}
