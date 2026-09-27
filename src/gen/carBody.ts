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
  MAT_LAMP_HEAD,
  MAT_LAMP_TAIL,
  MAT_GRILLE,
  MAT_LENS,
  MAT_MIRROR,
  driverZ,
  MAT_INTAKE,
  MAT_DRL,
  MAT_PROJ,
  MAT_LED,
  box,
  emitGrid,
  orient,
  P3,
} from './car';

export type Knots = Array<[number, number]>; // (z, value)

// An opening in the skin, outlined in the front (end 'front', looking
// backward at the nose) or rear view: (x, y) points of a closed curve
// (x = car-left; a smooth closed spline goes through them). Mirrored
// openings are given for x >= 0 and duplicated at -x.
export interface Opening {
  // 'pocket': a body-colour recess (e.g. the licence plate's; a plate at
  // that end sits on its back face).
  kind: 'headlamp' | 'taillamp' | 'grille' | 'intake' | 'pocket';
  end: 'front' | 'rear';
  outline: Array<[number, number]>;
  // true: a copy at -x; 'merge': the outline (x >= 0, from the centre line
  // round and back to it) joined with its mirror image into ONE opening.
  mirror?: boolean | 'merge';
  depth?: number; // housing depth (m); default 0.04
  // Headlamp projector lenses: (x, y, radius), mirrored with the opening.
  projectors?: Array<[number, number, number]>;
  // LED strip (DRL / tail light guide) along part of the outline: the
  // [start, end] fraction of the outline's length (from its first point).
  strip?: [number, number];
  // Thin body-colour bars across the opening at these heights (m), e.g.
  // the horizontal bar through a grille.
  bars?: number[];
  barMat?: 'body' | 'black' | 'chrome'; // default body colour
  // Gloss-black surround instead of the body-colour collar (grilles).
  blackSurround?: boolean;
}

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
  doorBow?: number; // outward bow of the panel between door line and shoulder (m)
  // Inward dish of the lower door between rocker and door line (m): a
  // concave band that turns convex again at the sill.
  doorConcave?: number;
  archGap?: number; // wheel arch radius minus wheel radius (m, default 0.02)
  // Door mirror head: width (outboard), height, and gap from the belt (m).
  mirror?: {w: number; h: number; out: number};
  // Lamps, grille and intakes: real openings cut into the skin (see
  // buildOpenings).
  openings?: Opening[];
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
    // z range of a small fixed window in the A-pillar sail (ahead of
    // sideFront; a black divider fills the gap back to sideFront).
    frontQuarter?: [number, number];
    // z of a 2-door car's rear door shut line (one long door per side).
    doorRear?: number;
    // Painted A / C pillar band across the top of the windscreen and
    // backlight edges (m, measured inboard from the rail).
    aPillarWidth?: number;
    // Black ceramic frit band: [header / trailing edge, pillar sides] (m).
    frit?: [number, number];
  };
  chromeSill?: boolean; // thin chrome window seal
  // Gloss-black splitter band along the bottom of the front fascia: its
  // height (m) above the body bottom near the nose. Drawn per pixel at a
  // constant height from just ahead of the front arches.
  chinTrim?: number;
  // Tailgate bulge: pushes the rear face out by `depth` (m) around height
  // `y`, falling off smoothly over `width` above and below.
  tailBulge?: {y: number; depth: number; width?: number};
  // Licence plate centre heights (m); default from noseY / tailY.
  plateY?: {front?: number; rear?: number};
  // Hatch tailgate: half width of its shut line on the rear face and the
  // height of its bottom edge (m); replaces the trunk-lid seams.
  tailgate?: {halfWidth: number; bottom: number};
  // Roof spoiler lip over the rear window: overhang and drop (m).
  spoiler?: {length: number; drop: number};
  // Roof rails (satin metal) along the roof edges: rail height above the
  // roof, width, and inset inboard of the roof rail line (m).
  roofRails?: {height: number; width: number; inset: number};
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
  uAt: Array<number[] | undefined> = [],
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
      // Sample parameters: uniform unless the span has its own list.
      const u = uAt[s]?.[q] ?? q / cnt;
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
const SPAN_COUNTS = [4, 4, 8, 9, 7, 12, 6, 12];
const SPAN_GLASS = 5;

export interface BodyGeom {
  belt: (z: number) => number;
  halfWidth: (z: number) => number; // skin half width at the shoulder
  beltX: (z: number) => number;
  rail: (z: number) => number;
  railX: (z: number) => number; // half width at the roof rail
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
  const railIn = asCurve(c.railIn);
  const cab = c.cabin;
  const inCabin = (z: number) =>
    z > cab.rearGlassBase && z < cab.windscreenBase;
  return {
    railX: z => Math.max(width(z), 0) * railIn(z),
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
  const pillarW = cab.aPillarWidth ?? 0.06;
  // The lower door-line crease dies out ahead of the front wheel (it
  // made a hard facet into the bumper).
  const doorCreaseW = (z: number) =>
    1 - sm(axles[0] + 0.1, axles[0] + R + 0.35, z);
  const fritW = cab.frit ?? [0, 0];

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
    // The rail -> roof span puts rows at the pillar band and frit edges.
    const railLen = Math.max(Math.hypot(rx - hoodPt[0], ry - hoodPt[1]), 0.05);
    const a = Math.min(pillarW / railLen, 0.4),
      b = Math.min(a + fritW[1] / railLen, 0.55);
    const n6 = SPAN_COUNTS[6];
    const u6 = fritW[1] > 0 ? [0, a, b] : [0, a];
    const e = u6[u6.length - 1],
      rest = n6 - u6.length + 1;
    for (let q = 1; q < rest; ++q) u6.push(e + ((1 - e) * q) / rest);
    const sp2 = spline2(
      pts,
      SPAN_COUNTS,
      [
        0,
        0,
        0,
        (cr.door ?? 0) * doorCreaseW(z),
        cr.shoulder ?? 0,
        cr.belt ?? 0,
        0,
        hoodCrease,
      ],
      SPAN_COUNTS.map((_, i) => (i === 6 ? u6 : undefined)),
    );
    // Door panel bow: a gentle outward belly between door line and
    // shoulder (a highlight gradient instead of a flat band).
    const bow = (span: number, amt: number) => {
      const n = SPAN_COUNTS[span];
      let q = 0;
      for (let k = 0; k < sp2.p.length; ++k)
        if (sp2.span[k] === span) {
          sp2.p[k][0] +=
            amt * Math.sin((Math.PI * q) / n) * (W > 0.3 ? 1 : W / 0.3);
          q++;
        }
    };
    if (c.doorBow) bow(3, c.doorBow);
    // The lower-door dish fades out before the fascias (where the section
    // turns toward the nose / tail it would make a shelf under the crease).
    if (c.doorConcave)
      bow(
        2,
        -c.doorConcave *
          sm(nose - 0.3, nose - 0.7, z) *
          sm(tail + 0.3, tail + 0.7, z),
      );
    return sp2;
  };

  // Stations: fine everywhere, finer at the ends (where the plan curve
  // turns in to form the fascias) and at the wheel arches.
  const archR = R + (c.archGap ?? 0.02);
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
  // Rows at the windscreen header / backlight frit edges.
  zs.push(cab.roofFront, cab.roofBack, cab.sideFront, cab.sideRear);
  if (cab.frontQuarter) zs.push(...cab.frontQuarter);
  if (fritW[0] > 0) zs.push(cab.roofFront + fritW[0], cab.roofBack - fritW[0]);
  // Where the plan curve turns in to close the ends it is nearly flat in
  // z: add stations until neighbours differ by <= 1.5 cm of width, so the
  // fascia faces are finely sampled across x too (else their quads span
  // tens of cm, and openings cut large holes).
  {
    const sorted = [...zs].sort((a, b) => a - b);
    for (let k = 0; k + 1 < sorted.length; ++k) {
      const split = (a: number, b: number, depth: number) => {
        if (depth > 10 || b - a < 1e-4) return;
        if (Math.abs(width(b) - width(a)) <= 0.015) return;
        const m = (a + b) / 2;
        zs.push(m);
        split(a, m, depth + 1);
        split(m, b, depth + 1);
      };
      split(sorted[k], sorted[k + 1], 0);
    }
  }
  const Z = [...new Set(zs.map(z => Math.round(z * 1e5) / 1e5))]
    .filter(z => z >= tail && z <= nose)
    .sort((a, b) => b - a);

  // Wheel arches: skin faces inside the arch opening are dropped (see
  // mat()) and a flared, rolled arch lip (below) covers the cut edge.
  // Inboard of xIn the skin stays, forming the well's inner wall.
  const xIn = sp.track / 2 - 0.2;

  const maxHalfW = Math.max(...c.width.map(k => k[1]));
  // Raked fascias: the upper nose / tail leans back from the bumper.
  const rakeZ = (z: number, x: number, y: number) => {
    // Corners are measured against the body's full half width (near the
    // end stations the local width goes to 0, and a local measure made
    // every point a "corner": a fin at the centre line).
    let zz = z;
    const corner = sm(0.75, 1.0, Math.abs(x) / maxHalfW);
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
    if (c.tailBulge) {
      const tb = c.tailBulge;
      const wdt = tb.width ?? 0.12;
      zz -=
        tb.depth *
        Math.exp(-Math.pow((y - tb.y) / wdt, 2)) *
        sm(tail + 0.5, tail, z);
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
  // Skin half width at height y of the (unraked) section at z.
  const skinXAt = (z: number, y: number): number => {
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

  const grid: P3[][] = [];
  let spans: number[] = [];
  for (const z of Z) {
    const {p, span} = sectionHalf(z);
    spans = span;
    const ring: P3[] = [];
    const zr = (x: number, y: number) => rakeZ(z, x, y);
    for (let k = 0; k < p.length; ++k) {
      const y = p[k][1];
      ring.push([-p[k][0], y, zr(p[k][0], y)]);
    }
    for (let k = p.length - 2; k >= 0; --k) {
      const y = p[k][1];
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

  // Per arch and angle above the axle: how much of the arch flange fits
  // on the car's side (1 = all of it). A low hood / fender top cuts it
  // short; both the arch cut and the lip use this.
  const ARCH_N = 48;
  const archFit = axles.map(az =>
    Array.from({length: ARCH_N + 1}, (_, a) => {
      const th = (Math.PI * a) / ARCH_N;
      const onSide = (rr: number) =>
        skinXAt(az + Math.cos(th) * rr, R + Math.sin(th) * rr) > xIn;
      const rOut = archR + 0.15;
      if (onSide(rOut)) return 1;
      let lo = archR,
        hi = rOut;
      for (let it = 0; it < 14; ++it) {
        const m = (lo + hi) / 2;
        if (onSide(m)) lo = m;
        else hi = m;
      }
      return Math.max((lo - archR) / (rOut - archR), 0.12);
    }),
  );
  const archK = (ai: number, th: number) => {
    if (th <= 0 || th >= Math.PI) return 1;
    const u = (th / Math.PI) * ARCH_N,
      i0 = Math.floor(u),
      f = u - i0;
    const t = archFit[ai];
    return t[i0] * (1 - f) + t[Math.min(i0 + 1, ARCH_N)] * f;
  };
  const ops = prepareOpenings(
    c.openings ?? [],
    nose,
    tail,
    skinXAt,
    rakeZ,
    () => false, // (the chin trim is drawn per pixel: see chinTrimParams)
  );

  const mat = (i: number, j: number): number => {
    const z = (Z[i] + Z[i + 1]) / 2;
    const k = j < H ? j : RN - 2 - j;
    const s = spans[Math.min(k, H - 1)];
    const first = k === spanStart[s];
    // Lamp / grille openings: the skin inside them is replaced by the
    // opening's own geometry.
    if (ops.length) {
      const q = [
        grid[i][j],
        grid[i + 1][j],
        grid[i][j + 1],
        grid[i + 1][j + 1],
      ];
      const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
        cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
        cz = (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4;
      for (const o of ops) if (o.covers(cx, cy, cz)) return -1;
    }
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
      for (let ai = 0; ai < axles.length; ++ai) {
        const az = axles[ai];
        const k = archK(ai, Math.atan2(cy - R, cz - az));
        if (cx > xIn && Math.hypot(cz - az, cy - R) < archR + 0.09 * k)
          return -1;
      }
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
        // (Lower body only: a low hood above the axle is not a well wall.)
        if (
          s <= 3 &&
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
    // Sill line: only along the sills, between the wheel arches.
    if (
      s === 2 &&
      first &&
      z < axles[0] - archR - 0.03 &&
      z > axles[1] + archR + 0.03
    )
      return MAT_TRIM;
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
      const fq = cab.frontQuarter;
      if (fq && z > fq[0] && z < fq[1]) return MAT_GLASS;
      if (fq && z >= cab.sideFront && z <= fq[0]) return MAT_TRIM; // divider
      if (z > cab.sideFront || z < cab.sideRear) return MAT_PAINT; // A / C pillars
      for (const pz of cab.pillars)
        if (near(z, pz, cab.pillarWidth / 2)) return MAT_TRIM;
      return MAT_GLASS;
    }
    // Roof rail / roof: windscreen and backlight.
    const ws = z > cab.roofFront && z < cab.windscreenBase;
    const back = z < cab.roofBack && z > cab.rearGlassBase;
    if (ws || back) {
      if (s === 6 && first) return MAT_PAINT; // A / C pillar band
      // Black frit along the pillars and across the header / trailing edge.
      if (fritW[1] > 0 && s === 6 && k === spanStart[6] + 1) return MAT_TRIM;
      if (
        fritW[0] > 0 &&
        ((ws && z < cab.roofFront + fritW[0]) ||
          (back && z > cab.roofBack - fritW[0]))
      )
        return MAT_TRIM;
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
  const doorK = spanStart[3];
  emitSkin(push, grid, mat, H, creaseK, (i, k) =>
    k === doorK ? doorCreaseW(Z[i]) : 1,
  );
  for (const o of ops) o.emit(push);

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
  const skinX = skinXAt;

  // Profile (radius, x offset from the skin): on the skin, flare out, roll
  // under, then back up inside past the skin cut (a closed channel, so the
  // cut edge is never visible).
  // A gentle swell that blends tangentially into the skin (not a band).
  const LIP: Array<[number, number]> = [
    [archR + 0.15, 0.0],
    [archR + 0.1, 0.005],
    [archR + 0.055, 0.011],
    [archR + 0.02, 0.01],
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
        // The swell fades out at the ends of the arch (no flap).
        const fe = sm(0, 0.15, a / N) * sm(1, 0.85, a / N);
        const row: P3[] = [];
        // Keep the flange on the car's side: where the arch comes near a
        // low hood it is narrowed (scaled toward the arch) at that angle
        // (points past the bodywork collapsed onto the centre line).
        const kr = archK(axles.indexOf(az), th);
        for (const [r0, dx] of LIP) {
          const r = r0 > archR ? archR + (r0 - archR) * kr : r0;
          const z = az + Math.cos(th) * r,
            y = R + Math.sin(th) * r;
          // The outer rows follow the skin (where the plan turns in toward
          // a fascia the skin is narrower than xIn; clamping there made a
          // flat plate); the inner channel stays behind the skin.
          const sk = skinX(z, y);
          const x =
            dx >= 0
              ? sk + dx * fe
              : Math.max(sk + dx * fe, Math.min(xIn, sk - 0.012));
          row.push([sx * x, y, z]);
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
    const mc = c.mirror ?? {w: 0.17, h: 0.1, out: 0.085};
    const mw = mc.w,
      mh = mc.h,
      md = 0.08;
    const x0 = sx * (wz + mc.out);
    // Aimed at the driver's eye: the glass normal bisects the directions
    // to the eye and straight back (so it shows the road behind).
    const eye = [0.37, Math.min(sp.belt + 0.27, sp.roofY - 0.14), driverZ(sp)];
    const hc = [x0, y, z - 0.02];
    const aim = rotFromTo(
      [0, 0, -1],
      normalize3([
        (eye[0] - hc[0]) /
          Math.hypot(eye[0] - hc[0], eye[1] - hc[1], eye[2] - hc[2]),
        (eye[1] - hc[1]) /
          Math.hypot(eye[0] - hc[0], eye[1] - hc[1], eye[2] - hc[2]),
        (eye[2] - hc[2]) /
          Math.hypot(eye[0] - hc[0], eye[1] - hc[1], eye[2] - hc[2]) -
          1,
      ]),
    );
    const R = (p: P3): P3 => {
      const q = aim([p[0] - hc[0], p[1] - hc[1], p[2] - hc[2]]);
      return [q[0] + hc[0], q[1] + hc[1], q[2] + hc[2]];
    };
    const mg: P3[][] = [];
    for (let a = 0; a <= 10; ++a) {
      const t = a / 10;
      // A head that tapers toward its stalk and has a tight outboard cap,
      // not a round pod.
      const sc =
        (0.6 + 0.4 * sm(0, 0.5, t)) *
        Math.pow(Math.sin((Math.PI / 2) * Math.min(1, (1 - t) / 0.14)), 0.5) *
        Math.pow(Math.sin((Math.PI / 2) * Math.min(1, 0.1 + t / 0.06)), 0.5);
      const row: P3[] = [];
      for (let b = 0; b <= 16; ++b) {
        const th = (b / 16) * Math.PI * 2;
        const cz = Math.cos(th),
          s0 = Math.sin(th),
          sy = Math.sign(s0) * Math.pow(Math.abs(s0), 0.6); // squarer section
        const dz = cz > 0 ? cz * md : cz * 0.012;
        row.push(
          R([
            x0 + sx * (t - 0.5) * mw,
            y + sy * mh * 0.5 * sc,
            z - 0.02 + dz * sc,
          ]),
        );
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
    // Mirror glass across the back of the head (the driver sees it): a
    // rounded rectangle fan, and a thin black frame around it.
    {
      const gz = z - 0.02 - 0.0135;
      const ringAt = (k: number, sc2: number): P3 => {
        const th = (k / 24) * Math.PI * 2;
        const cx = Math.cos(th),
          cy = Math.sin(th);
        const ex = Math.sign(cx) * Math.pow(Math.abs(cx), 0.45),
          ey = Math.sign(cy) * Math.pow(Math.abs(cy), 0.45);
        return R([x0 + ex * mw * 0.44 * sc2, y + ey * mh * 0.36 * sc2, gz]);
      };
      for (let k = 0; k < 24; ++k) {
        const gn = aim([0, 0, -1]);
        const tri = (a: P3, b: P3, cc: P3, m: number) => {
          for (const p of [a, b, cc]) push(p, gn, m);
        };
        tri(
          R([x0, y, gz - 0.0005]),
          ringAt(k, 0.9),
          ringAt(k + 1, 0.9),
          MAT_MIRROR,
        );
        const o0 = ringAt(k, 1),
          o1 = ringAt(k + 1, 1),
          i0 = ringAt(k, 0.9),
          i1 = ringAt(k + 1, 0.9);
        tri(o0, o1, i1, MAT_TRIM);
        tri(o0, i1, i0, MAT_TRIM);
      }
    }
    // Black triangular base (sail) in the window's front corner and a
    // slim arm out to the head.
    {
      const bx = sx * (wz + 0.006);
      const by = g.belt(z);
      const zs0 = z - 0.06,
        zs1 = z + 0.16;
      // The tip stays under the window frame (near the windscreen base
      // the rail drops toward the belt).
      const sec1 = sectionHalf(zs1).p;
      const railP = sec1[spanStart[6]];
      const f = Math.min(1, 0.13 / Math.max(railP[1] - by, 0.01)) * 0.85;
      const pts: P3[] = [
        [bx, by + 0.005, zs0],
        [bx, by + 0.005, zs1],
        [
          sx * (Math.abs(bx) + (railP[0] + 0.006 - Math.abs(bx)) * f),
          by + (railP[1] - by) * f,
          zs1,
        ],
      ];
      for (const p of pts) push(p, [sx, 0, 0], MAT_TRIM);
      for (const p of [pts[0], pts[2], pts[1]]) push(p, [-sx, 0, 0], MAT_TRIM);
      box(
        push,
        [(bx + x0 - sx * mw * 0.35) / 2, y - 0.035, z - 0.01],
        [Math.abs(x0 - sx * mw * 0.35 - bx) / 2 + 0.01, 0.012, 0.022],
        MAT_PAINT,
      );
    }
  }
  // Door handles.
  const doorZ =
    cab.doorRear !== undefined
      ? [cab.doorRear + 0.15]
      : [
          (cab.sideFront + (cab.pillars[0] ?? cab.sideRear)) / 2 - 0.25,
          ...(cab.pillars.length ? [cab.pillars[0] - 0.35] : []),
        ];
  for (const sx of [-1, 1])
    for (const z of doorZ) {
      // Body-colour grip with a chrome strip, over a dark recess.
      const y = g.belt(z) - 0.1;
      const xs = width(z) * 0.985;
      box(push, [sx * (xs + 0.001), y, z], [0.003, 0.024, 0.085], MAT_TRIM);
      box(push, [sx * (xs + 0.009), y, z], [0.008, 0.012, 0.07], MAT_PAINT);
      box(
        push,
        [sx * (xs + 0.012), y + 0.011, z],
        [0.007, 0.0025, 0.066],
        MAT_CHROME,
      );
    }
  // Roof spoiler: a thin body-colour blade across the roof at the top of
  // the rear window, following the roof's crown and overhanging the glass.
  if (c.spoiler) {
    const z0 = cab.roofBack + 0.03;
    const {p} = sectionHalf(z0);
    const rail = p[spanStart[6]][0];
    const roofYAt = (x: number) => {
      let best = -1e9;
      for (let k = spanStart[6]; k + 1 < p.length; ++k) {
        const a = p[k],
          b = p[k + 1];
        if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0])
          best = Math.max(
            best,
            a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]),
          );
      }
      return best > -1e8 ? best : p[p.length - 1][1];
    };
    const L = c.spoiler.length,
      dr = c.spoiler.drop;
    // Closed thin section (z, y offsets from the roof point).
    const sec: Array<[number, number]> = [
      [0.04, -0.004],
      [0.0, 0.004],
      [-L * 0.6, -dr * 0.4],
      [-L, -dr],
      [-L + 0.004, -dr - 0.01],
      [-L * 0.5, -dr * 0.4 - 0.012],
      [0.02, -0.012],
    ];
    const rows: P3[][] = [];
    for (let k = 0; k <= 24; ++k) {
      const x = (-1 + (2 * k) / 24) * rail * 0.94;
      const ry = roofYAt(Math.abs(x));
      // Taper the blade at its ends.
      const e = Math.sqrt(1 - Math.pow(Math.abs(x) / (rail * 0.94), 8));
      rows.push(sec.map(([dz, dy]) => [x, ry + dy * e, z0 + dz * e] as P3));
    }
    // Body-colour top, dark underside (so it separates from the roof).
    emitGrid(
      push,
      rows,
      (_i, j) => (j >= 3 ? MAT_TRIM : MAT_PAINT),
      q => [0, q[1] - roofYAt(Math.abs(q[0])) + 0.006, q[2] - z0 + L * 0.3],
      false,
    );
  }
  // Roof rails: flush solid rails on the roof (no gap under them) that
  // taper down into the roof at both ends.
  if (c.roofRails) {
    const rr = c.roofRails;
    const z0 = cab.roofFront - 0.1,
      z1 = cab.roofBack + 0.05;
    // Roof point (x, y) inboard of the rail line at z.
    const roofAt = (z: number) => {
      const {p} = sectionHalf(z);
      const rail = p[spanStart[6]];
      const x = rail[0] - rr.inset;
      let y = rail[1];
      for (let k = spanStart[6]; k + 1 < p.length; ++k) {
        const a = p[k],
          b = p[k + 1];
        if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) {
          y = a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
          break;
        }
      }
      return [x, y];
    };
    const NZ = 40;
    for (const sx of [-1, 1]) {
      const rows: P3[][] = [];
      for (let i = 0; i <= NZ; ++i) {
        const z = z0 + ((z1 - z0) * i) / NZ;
        const [x, y] = roofAt(z);
        const u = i / NZ;
        const e = Math.sqrt(sm(0, 0.1, u) * sm(1, 0.9, u));
        const h = Math.max(rr.height * e, 0.002);
        const yc = y - 0.004 + h * 0.5;
        const row: P3[] = [];
        for (let k = 0; k <= 12; ++k) {
          const th = (k / 12) * Math.PI * 2;
          const cx = Math.cos(th),
            cy = Math.sin(th);
          row.push([
            sx *
              (x +
                Math.sign(cx) * Math.pow(Math.abs(cx), 0.5) * rr.width * 0.5),
            yc +
              Math.sign(cy) * Math.pow(Math.abs(cy), 0.4) * (h * 0.5 + 0.004),
            z,
          ]);
        }
        rows.push(row);
      }
      emitGrid(
        push,
        rows,
        () => MAT_CHROME,
        q => {
          const [x, y] = roofAt(q[2]);
          return [q[0] - sx * x, q[1] - y - rr.height, 0];
        },
        true,
      );
    }
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
  // A plate pocket at that end sets the plate back by its depth.
  const pocketDepth = (y: number, end: 'front' | 'rear') => {
    for (const o of c.openings ?? []) {
      if (o.kind !== 'pocket' || o.end !== end) continue;
      const ys = o.outline.map(p => p[1]);
      if (y > Math.min(...ys) && y < Math.max(...ys)) return o.depth ?? 0.04;
    }
    return 0;
  };
  box(
    push,
    [0, fy, faceZ(fy, true) - pocketDepth(fy, 'front') + 0.004],
    [0.26, 0.06, 0.006],
    MAT_PLATE,
  );
  box(
    push,
    [0, ry, faceZ(ry, false) + pocketDepth(ry, 'rear') - 0.004],
    [0.26, 0.065, 0.006],
    MAT_PLATE,
  );

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
  // Crease strength per station / row (0 = smooth there).
  creaseW: (i: number, k: number) => number = () => 1,
) {
  const NS = grid.length,
    NR = grid[0].length;
  const kOf = (j: number) => (j < H ? j : 2 * H - 2 - j);
  const sub = (a: P3, b: P3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  // The grid is parameterised consistently (stations along z, the ring
  // around the section), so one orientation fits the whole skin: taken at
  // the widest vertex, whose normal must face +x. (A per-vertex "outward"
  // guess flipped some normals on low, domed hoods.)
  let orient = 0;
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
    const l = Math.hypot(n[0], n[1], n[2]);
    const p = grid[i][j];
    if (l < 1e-9 || orient === 0) {
      // Degenerate (collapsed end / centre points) or not yet oriented:
      // fall back to a rough outward direction.
      n = n.map(x => x / (l || 1));
      const o = [p[0], p[1] - 0.6, p[2] * 0.25];
      if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0) n = n.map(x => -x);
      return n;
    }
    return n.map(x => (x / l) * orient);
  };
  {
    let bi = 0,
      bj = 0;
    for (let i = 0; i < NS; ++i)
      for (let j = 0; j < NR; ++j)
        if (grid[i][j][0] > grid[bi][bj][0]) {
          bi = i;
          bj = j;
        }
    const n0 = normalAt(bi, bj, 0); // (fallback path: faces +x there)
    orient = 1;
    const raw = normalAt(bi, bj, 0);
    orient = raw[0] * n0[0] + raw[1] * n0[1] + raw[2] * n0[2] < 0 ? -1 : 1;
  }
  // Normal of vertex (i, j) as used by a quad lying toward ring index
  // j + dir (dir = +1 or -1 along the ring).
  const vn = (i: number, j: number, dir: 1 | -1) => {
    const k = kOf(j);
    if (!creaseK.has(k)) return normalAt(i, j, 0);
    const w = creaseW(i, k);
    if (w >= 0.999) return normalAt(i, j, dir);
    const a = normalAt(i, j, dir),
      b = normalAt(i, j, 0);
    const n = a.map((x, q) => x * w + b[q] * (1 - w));
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return n.map(x => x / l);
  };
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

// ---- Openings (lamps, grille, intakes) ----

interface PreparedOpening {
  covers: (x: number, y: number, z: number) => boolean;
  emit: (push: (p: number[], n: number[], m: number) => void) => void;
}

// Closed uniform Catmull-Rom through the outline points, `n` samples.
function closedSpline(pts: Array<[number, number]>, n: number) {
  const out: Array<[number, number]> = [];
  const m = pts.length;
  for (let q = 0; q < n; ++q) {
    const t = (q / n) * m;
    const i = Math.floor(t);
    const u = t - i;
    const P = (k: number) => pts[(((i + k) % m) + m) % m];
    const p0 = P(-1),
      p1 = P(0),
      p2 = P(1),
      p3 = P(2);
    const f = (a: number, b: number, cc: number, d: number) =>
      0.5 *
      (2 * b +
        (-a + cc) * u +
        (2 * a - 5 * b + 4 * cc - d) * u * u +
        (-a + 3 * b - 3 * cc + d) * u * u * u);
    out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
  }
  return out;
}

function insidePoly(poly: Array<[number, number]>, x: number, y: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// Offsets a closed outline by d (positive = outward) along its 2D normals.
function offsetPoly(poly: Array<[number, number]>, d: number) {
  const n = poly.length;
  // Orientation: positive area = counter-clockwise.
  let area = 0;
  for (let i = 0; i < n; ++i) {
    const a = poly[i],
      b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area > 0 ? 1 : -1;
  // Outward normal of edge p -> q of a CCW polygon is (dy, -dx).
  const en = (p: [number, number], q: [number, number]) => {
    const dx = q[0] - p[0],
      dy = q[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    return [(dy / l) * sgn, (-dx / l) * sgn];
  };
  return poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n],
      b = poly[(i + 1) % n];
    // Mitred: the full distance d from both adjacent edges (so sharp
    // corners are covered), capped for very acute points.
    const n1 = en(a, p),
      n2 = en(p, b);
    let bx = n1[0] + n2[0],
      by = n1[1] + n2[1];
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) {
      bx = n1[0];
      by = n1[1];
    } else {
      bx /= bl;
      by /= bl;
    }
    const m = d / Math.max(bx * n1[0] + by * n1[1], 0.4);
    return [p[0] + bx * m, p[1] + by * m] as [number, number];
  });
}

// Openings sit on the fascia: the surface search runs this far in from the
// end (deeper, points near the top of the nose landed on a low hood and
// projected the housing onto it).
const FASCIA_DEPTH = 0.5;

function prepareOpenings(
  list: Opening[],
  nose: number,
  tail: number,
  skinX: (z: number, y: number) => number,
  rakeZ: (z: number, x: number, y: number) => number,
  // True where the skin at (y, z) is trim (e.g. the chin splitter): the
  // collar takes that material there.
  trimAt: (y: number, z: number) => boolean = () => false,
): PreparedOpening[] {
  const out: PreparedOpening[] = [];
  for (const op of list) {
    const sides = op.mirror === true ? [1, -1] : [1];
    for (const sx of sides) {
      const front = op.end === 'front';
      const endZ = front ? nose : tail;
      const dir = front ? 1 : -1; // outward along z
      const src =
        op.mirror === 'merge'
          ? [
              ...op.outline,
              ...op.outline
                .slice()
                .reverse()
                .filter(([x]) => Math.abs(x) > 1e-4)
                .map(([x, y]) => [-x, y] as [number, number]),
            ]
          : op.outline.map(([x, y]) => [x * sx, y] as [number, number]);
      const outline = closedSpline(src, op.mirror === 'merge' ? 120 : 72);
      // Skin surface z seen from the end at (x, y): the station where the
      // section just stops covering |x| (bisection), then the rake.
      const surfZ = (x: number, y: number): number => {
        let a = endZ - dir * FASCIA_DEPTH,
          b = endZ;
        // Beyond the body's silhouette: clamp onto it (no spikes).
        const ax = Math.min(Math.abs(x), skinX(a, y) * 0.999);
        for (let it = 0; it < 26; ++it) {
          const m = (a + b) / 2;
          if (skinX(m, y) >= ax) a = m;
          else b = m;
        }
        return rakeZ(a, x, y);
      };
      const depth = op.depth ?? 0.04;
      // The skin is removed a little beyond the outline; a body-colour
      // collar on the skin covers that (grid-shaped) cut edge.
      const cover = offsetPoly(outline, 0.02);
      const surfN = (x: number, y: number): number[] => {
        const e = 0.004;
        const fx = (surfZ(x + e, y) - surfZ(x - e, y)) / (2 * e);
        const fy = (surfZ(x, y + e) - surfZ(x, y - e)) / (2 * e);
        const n = [-fx * dir, -fy * dir, dir];
        const l = Math.hypot(n[0], n[1], n[2]);
        return n.map(v => v / l);
      };
      let reach = 0;
      for (const [x, y] of outline)
        reach = Math.max(reach, Math.abs(endZ - surfZ(x, y)));
      const isLamp = op.kind === 'headlamp' || op.kind === 'taillamp';
      const pocket = op.kind === 'pocket';
      const bodyMat = front ? MAT_FRONT : MAT_REAR;
      const backMat =
        op.kind === 'headlamp'
          ? MAT_LAMP_HEAD
          : op.kind === 'taillamp'
            ? MAT_LAMP_TAIL
            : op.kind === 'grille'
              ? MAT_GRILLE
              : pocket
                ? bodyMat
                : MAT_INTAKE;
      const wallMat = pocket
        ? bodyMat
        : op.kind === 'grille'
          ? MAT_CHROME
          : MAT_TRIM;
      const P = (x: number, y: number, dz: number): number[] => [
        x,
        y,
        surfZ(x, y) - dir * dz,
      ];
      out.push({
        covers: (x, y, z) =>
          Math.abs(z - endZ) < reach + 0.08 &&
          (z - (endZ - dir * (reach + 0.08))) * dir > 0 &&
          insidePoly(cover, x, y),
        emit: push => {
          const quad = (
            a: number[],
            b: number[],
            cc: number[],
            d: number[],
            m: number,
            inward = false,
          ) => {
            const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
            let n = [
              e1[1] * e2[2] - e1[2] * e2[1],
              e1[2] * e2[0] - e1[0] * e2[2],
              e1[0] * e2[1] - e1[1] * e2[0],
            ];
            const l = Math.hypot(n[0], n[1], n[2]) || 1;
            n = n.map(v => v / l);
            // Housing walls face into the opening (their front side shows).
            if (inward && n[0] * (ocx - a[0]) + n[1] * (ocy - a[1]) < 0)
              n = n.map(v => -v);
            // Faces across the opening (back plates, lenses) look out of
            // the car at either end.
            if (!inward && Math.abs(n[2]) > 0.7 && n[2] * dir < 0)
              n = n.map(v => -v);
            for (const p of [a, b, cc, a, cc, d]) push(p, n, m);
          };
          let pocketTop = -1e9;
          for (const [, y] of outline) pocketTop = Math.max(pocketTop, y);
          let ocx = 0,
            ocy = 0;
          for (const [x, y] of outline) {
            ocx += x / outline.length;
            ocy += y / outline.length;
          }
          // Rim: a thin dark gap on the skin, then the housing wall down
          // to the back.
          const rimOut = offsetPoly(outline, 0.006);
          // The collar stops at the body's silhouette seen from this end
          // (past it, surfZ has no skin to land on and made loose flaps
          // below the bumper).
          const onBody = (x: number, y: number) =>
            Math.max(
              skinX(endZ - dir * 0.3, y),
              skinX(endZ - dir * 0.45, y),
              skinX(endZ - dir * FASCIA_DEPTH, y),
            ) >
            Math.abs(x) + 0.004;
          const collar = offsetPoly(outline, 0.042).map((c, i) => {
            const r = rimOut[i];
            if (onBody(c[0], c[1]) || !onBody(r[0], r[1])) return c;
            let a = 0,
              b = 1;
            for (let it = 0; it < 12; ++it) {
              const m = (a + b) / 2;
              if (onBody(r[0] + (c[0] - r[0]) * m, r[1] + (c[1] - r[1]) * m))
                a = m;
              else b = m;
            }
            return [r[0] + (c[0] - r[0]) * a, r[1] + (c[1] - r[1]) * a] as [
              number,
              number,
            ];
          });
          const collarMat = front ? MAT_FRONT : MAT_REAR;
          const N = outline.length;
          for (let i = 0; i < N; ++i) {
            // Body-colour collar with the skin's own normals.
            const i3 = (i + 1) % N;
            const cq = [collar[i], collar[i3], rimOut[i3], rimOut[i]];
            // (A contrasting black surround sits further out so the body
            // skin under it can't show through.)
            const lift = op.blackSurround ? -0.005 : -0.0006;
            const pts = cq.map(([u, v]) => P(u, v, lift));
            const ns = cq.map(([u, v]) => surfN(u, v));
            const qy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4,
              qz = (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4;
            const cm =
              trimAt(qy, qz) || op.blackSurround ? MAT_TRIM : collarMat;
            for (const k of [0, 1, 2, 0, 2, 3]) push(pts[k], ns[k], cm);
            const i2 = (i + 1) % N;
            const [ax, ay] = outline[i],
              [bx, by] = outline[i2];
            const [ox, oy] = rimOut[i],
              [px, py] = rimOut[i2];
            quad(
              P(ox, oy, -0.001),
              P(px, py, -0.001),
              P(bx, by, -0.001),
              P(ax, ay, -0.001),
              // A pocket's rim is body colour except a thin shadow line
              // along its top edge (so a shallow recess reads head-on).
              pocket && (ay + by) / 2 < pocketTop - 0.01 ? bodyMat : MAT_TRIM,
            );
            quad(
              P(ax, ay, -0.001),
              P(bx, by, -0.001),
              P(bx, by, depth + 0.01),
              P(ax, ay, depth + 0.01),
              wallMat,
              pocket, // (convex outlines only)
            );
          }
          // Back plate and (lamps) a clear lens flush with the skin: filled
          // on a 2D grid clipped to the outline.
          let x0 = 1e9,
            x1 = -1e9,
            y0 = 1e9,
            y1 = -1e9;
          for (const [x, y] of outline) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
          const st = 0.012;
          const grow = offsetPoly(outline, st);
          for (let x = x0 - st; x < x1 + st; x += st)
            for (let y = y0 - st; y < y1 + st; y += st) {
              const cs = [
                [x, y],
                [x + st, y],
                [x + st, y + st],
                [x, y + st],
              ];
              if (!cs.some(([u, v]) => insidePoly(outline, u, v))) continue;
              if (!cs.every(([u, v]) => insidePoly(grow, u, v))) continue;
              const back = cs.map(([u, v]) => P(u, v, depth));
              quad(back[0], back[1], back[2], back[3], backMat);
              if (isLamp) {
                const lens = cs.map(([u, v]) => P(u, v, 0.002));
                quad(lens[0], lens[1], lens[2], lens[3], MAT_LENS);
              }
            }
          // Projector lenses: chrome ring + dark glass disc, set in.
          // Bars across the opening (body colour, on the skin surface).
          for (const by of op.bars ?? []) {
            let bx0 = 1e9,
              bx1 = -1e9;
            for (let i = 0; i < outline.length; ++i) {
              const [ax, ay] = outline[i],
                [cx2, cy2] = outline[(i + 1) % outline.length];
              if ((ay - by) * (cy2 - by) <= 0 && ay !== cy2) {
                const xx = ax + ((cx2 - ax) * (by - ay)) / (cy2 - ay);
                bx0 = Math.min(bx0, xx);
                bx1 = Math.max(bx1, xx);
              }
            }
            if (bx0 > bx1) continue;
            const hb = 0.007,
              NB = 24;
            for (let k = 0; k < NB; ++k) {
              const u0 = bx0 - 0.01 + ((bx1 - bx0 + 0.02) * k) / NB,
                u1 = bx0 - 0.01 + ((bx1 - bx0 + 0.02) * (k + 1)) / NB;
              const pts = [
                P(u0, by - hb, 0.002),
                P(u1, by - hb, 0.002),
                P(u1, by + hb, 0.002),
                P(u0, by + hb, 0.002),
              ];
              const ns = [
                surfN(u0, by),
                surfN(u1, by),
                surfN(u1, by),
                surfN(u0, by),
              ];
              const bm =
                op.barMat === 'black'
                  ? MAT_TRIM
                  : op.barMat === 'chrome'
                    ? MAT_CHROME
                    : bodyMat;
              for (const q of [0, 1, 2, 0, 2, 3]) push(pts[q], ns[q], bm);
            }
          }
          for (const [px0, py0, r] of op.projectors ?? []) {
            const cx = px0 * sx;
            const segs = 20;
            for (let k = 0; k < segs; ++k) {
              const a0 = (k / segs) * Math.PI * 2,
                a1 = ((k + 1) / segs) * Math.PI * 2;
              const ring = (rr: number, a: number, dz: number) =>
                P(cx + Math.cos(a) * rr, py0 + Math.sin(a) * rr, dz);
              quad(
                ring(r * 1.35, a0, depth * 0.5),
                ring(r * 1.35, a1, depth * 0.5),
                ring(r, a1, depth * 0.35),
                ring(r, a0, depth * 0.35),
                MAT_CHROME,
              );
              const cen = P(cx, py0, depth * 0.3);
              const n0 = [0, 0, dir];
              push(cen, n0, MAT_PROJ);
              push(ring(r, a0, depth * 0.35), n0, MAT_PROJ);
              push(ring(r, a1, depth * 0.35), n0, MAT_PROJ);
            }
          }
          // LED strip along part of the outline, just inside it.
          if (op.strip) {
            const [s0, s1] = op.strip;
            const inner = offsetPoly(outline, -0.012);
            const edge = offsetPoly(outline, -0.003);
            const i0 = Math.floor(s0 * N),
              i1 = Math.ceil(s1 * N);
            for (let i = i0; i < i1; ++i) {
              const a = i % N,
                b = (i + 1) % N;
              quad(
                P(edge[a][0], edge[a][1], 0.012),
                P(edge[b][0], edge[b][1], 0.012),
                P(inner[b][0], inner[b][1], 0.012),
                P(inner[a][0], inner[a][1], 0.012),
                op.kind === 'taillamp' ? MAT_LED : MAT_DRL,
              );
            }
          }
        },
      });
    }
  }
  return out;
}

function normalize3(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return v.map(x => x / l);
}

// Rotation taking unit vector a onto unit vector b (Rodrigues).
function rotFromTo(a: number[], b: number[]): (p: number[]) => P3 {
  const k = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const sn = Math.hypot(k[0], k[1], k[2]);
  const cs = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (sn < 1e-8) return p => [p[0], p[1], p[2]];
  const u = k.map(x => x / sn);
  return p => {
    const d = u[0] * p[0] + u[1] * p[1] + u[2] * p[2];
    const c = [
      u[1] * p[2] - u[2] * p[1],
      u[2] * p[0] - u[0] * p[2],
      u[0] * p[1] - u[1] * p[0],
    ];
    return [0, 1, 2].map(
      i => p[i] * cs + c[i] * sn + u[i] * d * (1 - cs),
    ) as P3;
  };
}

// Chin trim for the shader: [top height, start z] (0s when none).
export function chinTrimParams(sp: CarSpec): [number, number] {
  const c = sp.body;
  if (!c?.chinTrim) return [0, 0];
  const g = bodyGeom(c);
  return [
    g.bottom(sp.length / 2 - 0.15) + c.chinTrim,
    sp.wheelbase / 2 + sp.axleShift + sp.wheelR + (c.archGap ?? 0.02) + 0.05,
  ];
}
