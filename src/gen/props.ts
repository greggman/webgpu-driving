// Procedural roadside prop meshes (unit-sized where they get stretched).
import {MeshBuilder} from './meshBuilder';

// Prop materials (see props.wgsl).
export const PM_WOOD = 0;
export const PM_METAL = 1;
export const PM_CONCRETE = 2;
export const PM_BARN = 3;
export const PM_WHITE = 4;
export const PM_ROOF = 5;
export const PM_SIGN = 6;
export const PM_REFLECTOR = 7;
export const PM_WINDOW = 8;
export const PM_WIRE = 9;
export const PM_DARKWOOD = 10;

export type PropKind =
  | 'post'
  | 'railPost'
  | 'guardPost'
  | 'pole'
  | 'pier'
  | 'barn'
  | 'house'
  | 'silo'
  | 'sign'
  | 'delineator'
  | 'mailbox'
  | 'tumbleweed';

export function box(
  mb: MeshBuilder,
  c: number[],
  h: number[],
  mat: number,
  yaw = 0,
) {
  const cs = Math.cos(yaw),
    sn = Math.sin(yaw);
  const R = (v: number[]) => [
    v[0] * cs + v[2] * sn,
    v[1],
    -v[0] * sn + v[2] * cs,
  ];
  const faces: Array<[number[], number[], number[]]> = [
    [
      [1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [1, 0, 0],
      [0, 1, 0],
    ],
  ];
  for (const [n, u, v] of faces) {
    const p = (a: number, b: number) => {
      const q = R([
        (n[0] + u[0] * a + v[0] * b) * h[0],
        (n[1] + u[1] * a + v[1] * b) * h[1],
        (n[2] + u[2] * a + v[2] * b) * h[2],
      ]);
      return [c[0] + q[0], c[1] + q[1], c[2] + q[2]];
    };
    const nn = R(n);
    const a = mb.vert(p(-1, -1), nn, 0, 0, mat, 0);
    const b = mb.vert(p(1, -1), nn, 1, 0, mat, 0);
    const cc = mb.vert(p(1, 1), nn, 1, 1, mat, 0);
    const d = mb.vert(p(-1, 1), nn, 0, 1, mat, 0);
    mb.quad(a, b, cc, d);
  }
}

function gableRoof(
  mb: MeshBuilder,
  w: number,
  l: number,
  y: number,
  rise: number,
  over: number,
  mat: number,
) {
  const hw = w / 2 + over,
    hl = l / 2 + over;
  const ridge = y + rise;
  const s = Math.hypot(hw, rise);
  const nL = [-rise / s, hw / s, 0],
    nR = [rise / s, hw / s, 0];
  let a = mb.vert([-hw, y, -hl], nL, 0, 0, mat, 0);
  let b = mb.vert([-hw, y, hl], nL, 1, 0, mat, 0);
  let c = mb.vert([0, ridge, hl], nL, 1, 1, mat, 0);
  let d = mb.vert([0, ridge, -hl], nL, 0, 1, mat, 0);
  mb.quad(a, b, c, d);
  a = mb.vert([hw, y, hl], nR, 0, 0, mat, 0);
  b = mb.vert([hw, y, -hl], nR, 1, 0, mat, 0);
  c = mb.vert([0, ridge, -hl], nR, 1, 1, mat, 0);
  d = mb.vert([0, ridge, hl], nR, 0, 1, mat, 0);
  mb.quad(a, b, c, d);
}

function gableEnds(
  mb: MeshBuilder,
  w: number,
  l: number,
  y: number,
  rise: number,
  mat: number,
) {
  for (const sz of [-1, 1]) {
    const n = [0, 0, sz];
    const a = mb.vert([-w / 2, y, (sz * l) / 2], n, 0, 0, mat, 0);
    const b = mb.vert([w / 2, y, (sz * l) / 2], n, 1, 0, mat, 0);
    const c = mb.vert([0, y + rise, (sz * l) / 2], n, 0.5, 1, mat, 0);
    if (sz > 0) mb.tri(a, b, c);
    else mb.tri(b, a, c);
  }
}

export function buildProp(kind: PropKind): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const mb = new MeshBuilder();
  switch (kind) {
    case 'post':
      box(mb, [0, 0.6, 0], [0.06, 0.65, 0.06], PM_DARKWOOD);
      break;
    case 'railPost':
      box(mb, [0, 0.6, 0], [0.08, 0.65, 0.08], PM_WOOD);
      break;
    case 'guardPost':
      box(mb, [0, 0.35, 0], [0.05, 0.4, 0.08], PM_METAL);
      break;
    case 'pole': {
      // Utility pole (10 m) with crossarm and insulators.
      mb.tube(
        [
          [0, -0.5, 0],
          [0, 10.5, 0],
        ],
        [0.16, 0.12],
        7,
        PM_DARKWOOD,
        () => 0,
      );
      box(mb, [0, 9.6, 0], [1.2, 0.06, 0.07], PM_DARKWOOD);
      for (const x of [-1.05, 0, 1.05])
        box(mb, [x, 9.75, 0], [0.04, 0.1, 0.04], PM_WHITE);
      break;
    }
    case 'pier':
      // Unit-height pier, stretched in the shader.
      box(mb, [0, 0.5, 0], [0.9, 0.5, 0.6], PM_CONCRETE);
      box(mb, [0, 0.98, 0], [2.6, 0.03, 0.8], PM_CONCRETE);
      break;
    case 'barn': {
      const w = 11,
        l = 16,
        h = 6;
      box(mb, [0, h / 2 - 0.5, 0], [w / 2, h / 2 + 0.5, l / 2], PM_BARN);
      gableEnds(mb, w, l, h, 4.5, PM_BARN);
      gableRoof(mb, w, l, h, 4.5, 0.5, PM_ROOF);
      box(mb, [0, 2.2, l / 2 + 0.02], [2.2, 2.2, 0.03], PM_WHITE);
      box(mb, [0, 2.2, l / 2 + 0.05], [1.9, 1.9, 0.03], PM_BARN);
      break;
    }
    case 'house': {
      const w = 9,
        l = 12,
        h = 5.5;
      box(mb, [0, h / 2 - 0.5, 0], [w / 2, h / 2 + 0.5, l / 2], PM_WHITE);
      gableEnds(mb, w, l, h, 3, PM_WHITE);
      gableRoof(mb, w, l, h, 3, 0.4, PM_ROOF);
      for (const z of [-3.5, 0, 3.5]) {
        for (const y of [1.6, 4.0]) {
          box(mb, [w / 2 + 0.02, y, z], [0.03, 0.6, 0.45], PM_WINDOW);
          box(mb, [-w / 2 - 0.02, y, z], [0.03, 0.6, 0.45], PM_WINDOW);
        }
      }
      box(mb, [2.5, h + 2.0, 2], [0.4, 1.2, 0.4], PM_CONCRETE); // chimney
      box(mb, [w / 2 + 1.5, 0.15, 0], [1.5, 0.15, 2.5], PM_WOOD); // porch
      break;
    }
    case 'silo':
      mb.tube(
        [
          [0, -0.5, 0],
          [0, 14, 0],
        ],
        [2.6, 2.6],
        14,
        PM_METAL,
        () => 0,
      );
      mb.tube(
        [
          [0, 14, 0],
          [0, 15.5, 0],
          [0, 16.2, 0],
        ],
        [2.6, 1.6, 0.05],
        14,
        PM_METAL,
        () => 0,
      );
      break;
    case 'sign': {
      box(mb, [0, 1.1, 0], [0.04, 1.2, 0.04], PM_METAL);
      // Diamond warning sign (rotated square), facing +z.
      const s = 0.42;
      const n = [0, 0, 1];
      const c = [0, 2.35, 0.05];
      const a = mb.vert([c[0], c[1] - s, c[2]], n, 0.5, 0, PM_SIGN, 0);
      const b = mb.vert([c[0] + s, c[1], c[2]], n, 1, 0.5, PM_SIGN, 0);
      const cc = mb.vert([c[0], c[1] + s, c[2]], n, 0.5, 1, PM_SIGN, 0);
      const d = mb.vert([c[0] - s, c[1], c[2]], n, 0, 0.5, PM_SIGN, 0);
      mb.quad(a, b, cc, d);
      box(mb, [0, 2.35, 0.02], [0.3, 0.3, 0.015], PM_METAL, Math.PI / 4);
      break;
    }
    case 'delineator':
      box(mb, [0, 0.55, 0], [0.05, 0.6, 0.02], PM_WHITE);
      box(mb, [0, 0.95, 0.025], [0.035, 0.08, 0.005], PM_REFLECTOR);
      break;
    case 'tumbleweed': {
      // A tangled ball of thin curved twigs.
      let seed = 12345;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let i = 0; i < 70; ++i) {
        const pts: number[][] = [];
        const a0 = rnd() * Math.PI * 2,
          b0 = Math.acos(2 * rnd() - 1);
        const a1 = a0 + (rnd() - 0.5) * 2.5,
          b1 = b0 + (rnd() - 0.5) * 2.0;
        const r = 0.28 + rnd() * 0.14;
        for (let k = 0; k <= 4; ++k) {
          const t = k / 4;
          const a = a0 + (a1 - a0) * t,
            b = b0 + (b1 - b0) * t;
          const rr = r * (0.8 + 0.2 * Math.sin(t * Math.PI));
          pts.push([
            Math.sin(b) * Math.cos(a) * rr,
            Math.cos(b) * rr,
            Math.sin(b) * Math.sin(a) * rr,
          ]);
        }
        mb.tube(
          pts,
          pts.map(() => 0.008),
          3,
          PM_DARKWOOD,
          () => 0,
        );
      }
      break;
    }
    case 'mailbox':
      box(mb, [0, 0.55, 0], [0.04, 0.55, 0.04], PM_WOOD);
      box(mb, [0, 1.15, 0.1], [0.12, 0.12, 0.25], PM_METAL);
      break;
  }
  // Fix winding against normals.
  const out = mb.build();
  const v = out.vertices,
    ix = out.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
    const P = (i: number) => [v[i * 10], v[i * 10 + 1], v[i * 10 + 2]];
    const pa = P(a),
      pb = P(b),
      pc = P(c);
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const n = [v[a * 10 + 3], v[a * 10 + 4], v[a * 10 + 5]];
    if (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] < 0) {
      ix[t + 1] = c;
      ix[t + 2] = b;
    }
  }
  return out;
}
