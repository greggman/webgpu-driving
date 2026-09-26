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
  // cornerDepth (optional) also pulls the lower outboard corners back so
  // the bumper wraps.
  noseRake?: {bumperY: number; depth: number; cornerDepth?: number};
  tailRake?: {bumperY: number; depth: number; cornerDepth?: number};
  // Crease sharpness (0 soft .. 1 crisp) at the lower-door line, the
  // shoulder and the beltline.
  creases?: {door?: number; shoulder?: number; belt?: number};
  // Two raised hood lines from the headlamp tops toward the A-pillar bases:
  // x as a fraction of width, raised `height` m, crease sharpness 0..1.
  hoodLines?: {x: number; height: number; crease: number};
  hoodDome?: number; // raise of the hood centre line (m), faded at cowl / nose
  chromeDLO?: boolean; // thin chrome trim along the top of the side glass
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
  sharp: number[] = [],
): {p: Array<[number, number]>; span: number[]} {
  // Hermite spline with Catmull-Rom tangents over a centripetal
  // parameterisation (no cusps or loops). `sharp[i]` (0..1) shrinks the
  // tangent at point i: 1 makes a crisp crease there. The ends are mirrored
  // across x = 0 so the section meets the centre line horizontally.
  const n = pts.length;
  const P = [
    [-pts[1][0], pts[1][1]] as [number, number],
    ...pts,
    [-pts[n - 2][0], pts[n - 2][1]] as [number, number],
  ];
  const t: number[] = [0];
  for (let i = 1; i < P.length; ++i)
    t.push(
      t[i - 1] +
        Math.max(
          Math.sqrt(Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1])),
          1e-4,
        ),
    );
  // Tangent (d/dt) at each real point (index i+1 in P).
  const m: Array<[number, number]> = [];
  for (let i = 0; i < n; ++i) {
    const a = P[i],
      b = P[i + 2];
    const dt = t[i + 2] - t[i];
    const k = 1 - Math.min(Math.max(sharp[i] ?? 0, 0), 1);
    m.push([((b[0] - a[0]) / dt) * k, ((b[1] - a[1]) / dt) * k]);
  }
  const out: Array<[number, number]> = [];
  const span: number[] = [];
  for (let s = 0; s < n - 1; ++s) {
    const p0 = pts[s],
      p1 = pts[s + 1];
    const h = t[s + 2] - t[s + 1];
    const cnt = counts[s];
    for (let q = 0; q < cnt; ++q) {
      const u = q / cnt;
      const u2 = u * u,
        u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1,
        h10 = u3 - 2 * u2 + u,
        h01 = -2 * u3 + 3 * u2,
        h11 = u3 - u2;
      out.push([
        h00 * p0[0] + h10 * h * m[s][0] + h01 * p1[0] + h11 * h * m[s + 1][0],
        h00 * p0[1] + h10 * h * m[s][1] + h01 * p1[1] + h11 * h * m[s + 1][1],
      ]);
      span.push(s);
    }
  }
  out.push(pts[n - 1]);
  span.push(n - 2);
  return {p: out, span};
}

// Samples per span, bottom centre -> roof centre:
// underside, sill, lower door, door->shoulder, shoulder->belt, side glass,
// roof rail curve, roof.
const SPAN_COUNTS = [4, 4, 8, 9, 7, 12, 6, 9];
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
    // Mid point between the rail and the centre line; over the hood it can
    // carry the hood lines.
    let hoodPt: [number, number] = [rx * 0.5, ry + (tp - ry) * 0.82];
    let hoodCrease = 0;
    let dome = 0;
    if (c.hoodLines && z > cab.windscreenBase) {
      const hl = c.hoodLines;
      const f =
        sm(cab.windscreenBase, cab.windscreenBase + 0.15, z) *
        sm(nose, nose - 0.35, z);
      hoodPt = [
        hoodPt[0] + (W * hl.x - hoodPt[0]) * f,
        hoodPt[1] + hl.height * f,
      ];
      hoodCrease = hl.crease * f;
      dome = (c.hoodDome ?? 0) * f;
    }
    const pts: Array<[number, number]> = [
      [0, bot],
      [W * c.rockerIn * 0.82, bot + (rk - bot) * 0.15],
      [W * c.rockerIn, rk],
      [W * doorIn(z), dl],
      [W, sh],
      [bx, bl],
      [rx, ry + 0.0005],
      hoodPt,
      [0, tp + dome],
    ];
    const cr = c.creases ?? {};
    return spline2(pts, SPAN_COUNTS, [
      0,
      0,
      0,
      cr.door ?? 0,
      cr.shoulder ?? 0,
      cr.belt ?? 0,
      0,
      hoodCrease,
    ]);
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

  // Wheel arches: skin faces inside the arch opening are dropped (see
  // mat()) and a flared, rolled arch lip (below) covers the cut edge.
  // Inboard of xIn the skin stays, forming the well's inner wall.
  const xIn = sp.track / 2 - 0.2;
  const trimArch = (_x: number, y: number, _z: number): number => y;

  const grid: P3[][] = [];
  let spans: number[] = [];
  for (const z of Z) {
    const {p, span} = sectionHalf(z);
    spans = span;
    const ring: P3[] = [];
    // Raked fascias: the upper nose / tail leans back from the bumper.
    const Wz = Math.max(width(z), 1e-3);
    const zr = (x: number, y: number) => {
      let zz = z;
      const corner = sm(0.75, 1.0, Math.abs(x) / Wz);
      if (c.noseRake) {
        const r = c.noseRake;
        const e = sm(nose - 0.5, nose, z);
        zz -= r.depth * sm(r.bumperY, r.bumperY + 0.25, y) * e;
        zz -=
          (r.cornerDepth ?? 0) *
          corner *
          (1 - sm(r.bumperY, r.bumperY + 0.1, y)) *
          e;
      }
      if (c.tailRake) {
        const r = c.tailRake;
        const e = sm(tail + 0.5, tail, z);
        zz += r.depth * sm(r.bumperY, r.bumperY + 0.25, y) * e;
        zz +=
          (r.cornerDepth ?? 0) *
          corner *
          (1 - sm(r.bumperY, r.bumperY + 0.1, y)) *
          e;
      }
      return zz;
    };
    for (let k = 0; k < p.length; ++k) {
      const y = trimArch(p[k][0], p[k][1], z);
      ring.push([-p[k][0], y, zr(p[k][0], y)]);
    }
    for (let k = p.length - 2; k >= 0; --k) {
      const y = trimArch(p[k][0], p[k][1], z);
      ring.push([p[k][0], y, zr(p[k][0], y)]);
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
    // Arch openings: drop the outer skin inside the arch (the lip covers
    // the edge).
    {
      const q = [
        grid[i][j],
        grid[i + 1][j],
        grid[i][j + 1],
        grid[i + 1][j + 1],
      ];
      const cx = Math.abs(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
        cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
        cz = (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4;
      for (const az of axles)
        if (cx > xIn && Math.hypot(cz - az, cy - R) < archR + 0.075) return -1;
    }
    if (s <= 1) return MAT_UNDER;
    // The skin left inboard of a trimmed arch is the wheel well's wall.
    {
      const q = [
        grid[i][j],
        grid[i + 1][j],
        grid[i][j + 1],
        grid[i + 1][j + 1],
      ];
      const cx = Math.abs(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
        cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
        cz = (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4;
      for (const az of axles) {
        const dz = cz - az;
        if (
          Math.abs(dz) < archR &&
          cx < xIn + 0.02 &&
          cy < R + Math.sqrt(archR * archR - dz * dz) - 0.005
        )
          return MAT_UNDER;
      }
    }
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
      if (last) return c.chromeDLO ? MAT_CHROME : MAT_TRIM; // frame / drip rail
      const ql = cab.quarterLight;
      if (ql && z > ql[0] && z < ql[1]) return MAT_GLASS;
      // Divider between the rear door glass and the quarter light.
      if (ql && z <= cab.sideRear && z >= ql[1]) return MAT_TRIM;
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
  // Crease rows (sample index within the half ring) get split normals.
  const cr = c.creases ?? {};
  const creaseK = new Set<number>();
  if ((cr.door ?? 0) >= 0.5) creaseK.add(spanStart[3]);
  if ((cr.shoulder ?? 0) >= 0.5) creaseK.add(spanStart[4]);
  if ((cr.belt ?? 0) >= 0.5) creaseK.add(spanStart[5]);
  if ((c.hoodLines?.crease ?? 0) >= 0.5) creaseK.add(spanStart[7]);
  emitSkin(push, grid, mat, H, creaseK);

  // Wheel-well liners (dark half tubes) closing the trimmed arches.
  for (const az of axles) {
    for (const sx of [-1, 1]) {
      const rad = archR + 0.015; // outside the lip's roll, inside its channel
      const x0 = sx * xIn,
        x1 = sx * width(az) * 0.995; // out to the lip (no gap to see through)
      const lg: P3[][] = [];
      for (let a = 0; a <= 64; ++a) {
        const th = ((-25 + (a / 64) * 230) * Math.PI) / 180;
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

  // Arch lips: a flange following the arch circle, flared out from the
  // skin and rolled under into the well (it covers the trimmed edge).
  const skinX = (z: number, y: number): number => {
    const {p} = sectionHalf(z);
    let best = 0;
    for (let k = 0; k + 1 < p.length; ++k) {
      const a = p[k],
        b = p[k + 1];
      if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) {
        const t = (y - a[1]) / (b[1] - a[1]);
        best = Math.max(best, a[0] + (b[0] - a[0]) * t);
      }
    }
    return best;
  };
  // Profile (radius, x offset from the skin): on the skin, flare out, roll
  // under, then back up inside past the skin cut (a closed channel, so the
  // cut edge is never visible).
  const LIP: Array<[number, number]> = [
    [archR + 0.095, 0.0],
    [archR + 0.055, 0.014],
    [archR + 0.02, 0.012],
    [archR, -0.012],
    [archR - 0.004, -0.06],
    [archR + 0.11, -0.06],
  ];
  for (const az of axles) {
    // The lip ends at the local body bottom on each side of the arch.
    const angAt = (zz: number) =>
      Math.asin(
        Math.min(
          1,
          Math.max(-1, (Math.max(rocker(zz), g.bottom(zz)) + 0.01 - R) / archR),
        ),
      );
    const th0 = angAt(az + archR),
      th1 = Math.PI - angAt(az - archR);
    for (const sx of [-1, 1]) {
      const lg: P3[][] = [];
      const N = 36;
      for (let a = 0; a <= N; ++a) {
        const th = th0 + ((th1 - th0) * a) / N;
        const row: P3[] = [];
        for (const [r, dx] of LIP) {
          const z = az + Math.cos(th) * r,
            y = R + Math.sin(th) * r;
          row.push([sx * Math.max(skinX(z, y) + dx, xIn), y, z]);
        }
        lg.push(row);
      }
      emitGrid(
        push,
        lg,
        (_i, j) => (j >= 3 ? MAT_UNDER : MAT_PAINT),
        () => [sx, 0, 0],
        false,
        true,
      );
    }
  }

  // ---- Details ----
  // Mirrors: rounded housings on stalks from the door sail.
  for (const sx of [-1, 1]) {
    // On the door sail, just behind the A-pillar base.
    const z = cab.windscreenBase - 0.28;
    const wz = g.beltX(z);
    const y = g.belt(z) + 0.07;
    const mw = 0.17,
      mh = 0.1,
      md = 0.08;
    const x0 = sx * (wz + 0.085);
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

// Emits the skin grid [station][ring] with smooth normals, except along
// crease rows (half-ring sample indices in `creaseK`), where the faces on
// either side get their own one-sided normals so the highlight breaks.
function emitSkin(
  push: (p: number[], n: number[], m: number) => void,
  grid: P3[][],
  mat: (i: number, j: number) => number,
  H: number,
  creaseK: Set<number>,
) {
  const NS = grid.length,
    NR = grid[0].length;
  const kOf = (j: number) => (j < H ? j : 2 * H - 2 - j);
  const sub = (a: P3, b: P3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const normalAt = (i: number, j: number, side: -1 | 0 | 1): number[] => {
    const a = grid[Math.max(i - 1, 0)][j],
      b = grid[Math.min(i + 1, NS - 1)][j];
    const jm = (j - 1 + NR) % NR,
      jp = (j + 1) % NR;
    const c0 = side > 0 ? grid[i][j] : grid[i][jm];
    const c1 = side < 0 ? grid[i][j] : grid[i][jp];
    const du = sub(b, a),
      dv = sub(c1, c0);
    let n = [
      du[1] * dv[2] - du[2] * dv[1],
      du[2] * dv[0] - du[0] * dv[2],
      du[0] * dv[1] - du[1] * dv[0],
    ];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map(x => x / l);
    const p = grid[i][j];
    const o = [p[0], p[1] - 0.6, p[2] * 0.25];
    if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0) n = n.map(x => -x);
    return n;
  };
  // Normal of vertex (i, j) as used by a quad lying toward ring index
  // j + dir (dir = +1 or -1 along the ring).
  const vn = (i: number, j: number, dir: 1 | -1) =>
    creaseK.has(kOf(j)) ? normalAt(i, j, dir) : normalAt(i, j, 0);
  for (let i = 0; i < NS - 1; ++i) {
    for (let j = 0; j < NR - 1; ++j) {
      const m = mat(i, j);
      if (m < 0) continue;
      const q: Array<[number, number, 1 | -1]> = [
        [i, j, 1],
        [i + 1, j, 1],
        [i, j + 1, -1],
        [i, j + 1, -1],
        [i + 1, j, 1],
        [i + 1, j + 1, -1],
      ];
      for (const [a, b, d] of q) push(grid[a][b], vn(a, b, d), m);
    }
  }
}
