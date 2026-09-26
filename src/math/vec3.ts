// Minimal vec3 helpers operating on plain tuples / Float32Arrays.

export type Vec3 = ArrayLike<number>;

export function v3(x = 0, y = 0, z = 0): [number, number, number] {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function addScaled(
  a: Vec3,
  b: Vec3,
  s: number,
): [number, number, number] {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): [number, number, number] {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function lerp(a: Vec3, b: Vec3, t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
