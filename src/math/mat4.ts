// Column-major 4x4 matrices (WebGPU / WGSL convention).
import {Vec3, cross, normalize, sub, dot} from './vec3';

export type Mat4 = Float32Array;

export function identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; ++c) {
    for (let row = 0; row < 4; ++row) {
      let s = 0;
      for (let k = 0; k < 4; ++k) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  }
  out.set(r);
  return out;
}

// Reverse-Z infinite perspective: near maps to depth 1, infinity to 0.
export function perspectiveReverseZInfinite(
  fovY: number,
  aspect: number,
  near: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  out[14] = near;
  return out;
}

// Orthographic for shadow maps, reverse-Z (near -> 1, far -> 0).
export function orthoReverseZ(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  out.fill(0);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = 1 / (far - near);
  out[12] = (right + left) / (left - right);
  out[13] = (top + bottom) / (bottom - top);
  out[14] = far / (far - near);
  out[15] = 1;
  return out;
}

export function lookAt(
  eye: Vec3,
  target: Vec3,
  up: Vec3,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const z = normalize(sub(eye, target));
  let x = cross(up, z);
  if (Math.hypot(x[0], x[1], x[2]) < 1e-6) x = cross([0, 0, 1], z);
  x = normalize(x);
  const y = cross(z, x);
  out[0] = x[0];
  out[1] = y[0];
  out[2] = z[0];
  out[3] = 0;
  out[4] = x[1];
  out[5] = y[1];
  out[6] = z[1];
  out[7] = 0;
  out[8] = x[2];
  out[9] = y[2];
  out[10] = z[2];
  out[11] = 0;
  out[12] = -dot(x, eye);
  out[13] = -dot(y, eye);
  out[14] = -dot(z, eye);
  out[15] = 1;
  return out;
}

export function invert(m: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  const a00 = m[0],
    a01 = m[1],
    a02 = m[2],
    a03 = m[3];
  const a10 = m[4],
    a11 = m[5],
    a12 = m[6],
    a13 = m[7];
  const a20 = m[8],
    a21 = m[9],
    a22 = m[10],
    a23 = m[11];
  const a30 = m[12],
    a31 = m[13],
    a32 = m[14],
    a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const id = det ? 1 / det : 0;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * id;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * id;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * id;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * id;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * id;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * id;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * id;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * id;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * id;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * id;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * id;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * id;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * id;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * id;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * id;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * id;
  return out;
}

export function transformPoint(
  m: Mat4,
  p: Vec3,
): [number, number, number, number] {
  const x = p[0],
    y = p[1],
    z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

// Builds a model matrix from a basis (right, up, forward) and translation.
export function fromBasis(
  right: Vec3,
  up: Vec3,
  fwd: Vec3,
  pos: Vec3,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  out[0] = right[0];
  out[1] = right[1];
  out[2] = right[2];
  out[3] = 0;
  out[4] = up[0];
  out[5] = up[1];
  out[6] = up[2];
  out[7] = 0;
  out[8] = fwd[0];
  out[9] = fwd[1];
  out[10] = fwd[2];
  out[11] = 0;
  out[12] = pos[0];
  out[13] = pos[1];
  out[14] = pos[2];
  out[15] = 1;
  return out;
}

// Extracts 6 frustum planes (ax+by+cz+d >= 0 is inside) from a view-projection
// matrix using reverse-Z infinite projection (no far plane; returns 5 planes + a
// degenerate far).
export function frustumPlanes(vp: Mat4): Float32Array {
  const planes = new Float32Array(24);
  const row = (r: number) => [vp[r], vp[4 + r], vp[8 + r], vp[12 + r]];
  const r0 = row(0),
    r1 = row(1),
    r2 = row(2),
    r3 = row(3);
  const set = (i: number, p: number[]) => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    for (let k = 0; k < 4; ++k) planes[i * 4 + k] = p[k] / l;
  };
  set(
    0,
    r3.map((v, i) => v + r0[i]),
  );
  set(
    1,
    r3.map((v, i) => v - r0[i]),
  );
  set(
    2,
    r3.map((v, i) => v + r1[i]),
  );
  set(
    3,
    r3.map((v, i) => v - r1[i]),
  );
  set(
    4,
    r3.map((v, i) => v - r2[i]),
  ); // near (reverse-Z: z <= w)
  set(5, [0, 0, 0, 1e30]); // no far plane
  return planes;
}

export function aabbInFrustum(
  planes: Float32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  for (let i = 0; i < 6; ++i) {
    const a = planes[i * 4],
      b = planes[i * 4 + 1],
      c = planes[i * 4 + 2],
      d = planes[i * 4 + 3];
    const x = a >= 0 ? maxX : minX;
    const y = b >= 0 ? maxY : minY;
    const z = c >= 0 ? maxZ : minZ;
    if (a * x + b * y + c * z + d < 0) return false;
  }
  return true;
}
