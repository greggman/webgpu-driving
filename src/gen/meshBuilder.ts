// Indexed mesh builder for procedural geometry.
// Vertex: pos3 normal3 uv2 mat1 wind1 (10 floats).

export const VEG_FLOATS = 10;

export class MeshBuilder {
  v: number[] = [];
  i: number[] = [];

  get vertexCount(): number {
    return this.v.length / VEG_FLOATS;
  }

  vert(
    p: ArrayLike<number>,
    n: ArrayLike<number>,
    u: number,
    w: number,
    mat: number,
    wind: number,
  ): number {
    const idx = this.vertexCount;
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], u, w, mat, wind);
    return idx;
  }

  tri(a: number, b: number, c: number) {
    this.i.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.i.push(a, b, c, a, c, d);
  }

  // Tapered tube through a polyline with per-point radii.
  tube(
    pts: number[][],
    radii: number[],
    sides: number,
    mat: number,
    windAt: (p: number[]) => number,
    vScale = 1,
  ) {
    const rings: number[][] = [];
    let vAcc = 0;
    for (let k = 0; k < pts.length; ++k) {
      const p = pts[k];
      const next = pts[Math.min(k + 1, pts.length - 1)];
      const prev = pts[Math.max(k - 1, 0)];
      let t = sub(next, prev);
      t = norm(t);
      // Frame.
      const ref = Math.abs(t[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
      const b1 = norm(cross(t, ref));
      const b2 = cross(t, b1);
      if (k > 0) vAcc += len(sub(p, pts[k - 1]));
      const ring: number[] = [];
      for (let s = 0; s <= sides; ++s) {
        const a = (s / sides) * Math.PI * 2;
        const n = [
          b1[0] * Math.cos(a) + b2[0] * Math.sin(a),
          b1[1] * Math.cos(a) + b2[1] * Math.sin(a),
          b1[2] * Math.cos(a) + b2[2] * Math.sin(a),
        ];
        const r = radii[k];
        const q = [p[0] + n[0] * r, p[1] + n[1] * r, p[2] + n[2] * r];
        ring.push(this.vert(q, n, s / sides, vAcc * vScale, mat, windAt(q)));
      }
      rings.push(ring);
    }
    for (let k = 0; k < rings.length - 1; ++k) {
      for (let s = 0; s < sides; ++s) {
        this.quad(
          rings[k][s],
          rings[k][s + 1],
          rings[k + 1][s + 1],
          rings[k + 1][s],
        );
      }
    }
  }

  // Leaf / needle card: one quad, drawn without culling (seen from behind it
  // keeps its normal, which points out of the crown). A second, back-facing
  // quad never won the depth test but still cost its shading.
  card(
    center: number[],
    right: number[],
    up: number[],
    normal: number[],
    mat: number,
    wind: number,
  ) {
    const c = center;
    const p = (a: number, b: number) => [
      c[0] + right[0] * a + up[0] * b,
      c[1] + right[1] * a + up[1] * b,
      c[2] + right[2] * a + up[2] * b,
    ];
    // Cards encode a per-card random value in the wind slot:
    // 2 + windLevel (0..15) + rand in [0, 0.99). Used for LOD morphing.
    const h =
      Math.sin(c[0] * 12.9898 + c[1] * 78.233 + c[2] * 37.719) * 43758.5453;
    const rnd = (h - Math.floor(h)) * 0.99;
    wind = 2 + Math.round(Math.min(Math.max(wind, 0), 1) * 15) + rnd;
    const a = this.vert(p(-1, -1), normal, 0, 0, mat, wind);
    const b = this.vert(p(1, -1), normal, 1, 0, mat, wind);
    const cc = this.vert(p(1, 1), normal, 1, 1, mat, wind);
    const d = this.vert(p(-1, 1), normal, 0, 1, mat, wind);
    this.quad(a, b, cc, d);
  }

  build(): {vertices: Float32Array; indices: Uint32Array} {
    return {
      vertices: new Float32Array(this.v),
      indices: new Uint32Array(this.i),
    };
  }
}

export function sub(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function add(a: number[], b: number[]): number[] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function mul(a: number[], s: number): number[] {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function len(a: number[]): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function norm(a: number[]): number[] {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function lerp3(a: number[], b: number[], t: number): number[] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}
// Rotate v around unit axis k by angle a (Rodrigues).
export function rotate(v: number[], k: number[], a: number): number[] {
  const c = Math.cos(a),
    s = Math.sin(a);
  const kv = cross(k, v);
  const d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [
    v[0] * c + kv[0] * s + k[0] * d * (1 - c),
    v[1] * c + kv[1] * s + k[1] * d * (1 - c),
    v[2] * c + kv[2] * s + k[2] * d * (1 - c),
  ];
}
