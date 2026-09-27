// CPU twin of the GPU terrain height function (src/shaders/terrain.wgsl).
// The height is a function of world (x, z) plus the road-relative lateral
// distance d, which lets environments shape land relative to the road
// (valleys, coastlines, distant mountains) and lets the road carve cuts and
// embankments into the terrain.
import {noised, smoothstep, mix} from '../math/noise';

// P is packTerrain() output (32 floats).
export function naturalHeight(
  P: Float32Array,
  x: number,
  z: number,
  d: number,
): number {
  const px = x + P[23],
    pz = z + P[24];
  const ad = Math.abs(d);

  // Erosion-style fBm: derivative damping gives sharp ridges, smooth valleys.
  let qx = px * P[1],
    qz = pz * P[1];
  let a = 0,
    b = 1,
    dx = 0,
    dz = 0;
  const oct = P[2];
  for (let i = 0; i < oct; ++i) {
    const n = noised(qx, qz);
    dx += n[1];
    dz += n[2];
    a += (b * n[0]) / (1 + dx * dx + dz * dz);
    b *= 0.5;
    const nx = 1.6 * qx - 1.2 * qz;
    const nz = 1.2 * qx + 1.6 * qz;
    qx = nx;
    qz = nz;
  }
  let h = P[3] + P[0] * a;
  h += P[10] * noised(px * P[11], pz * P[11])[0];

  // Distant mountains (ridged noise), faded in away from the road.
  if (P[4] > 0) {
    const mf = smoothstep(P[6], P[7], ad);
    if (mf > 0) {
      let rx = px * P[5],
        rz = pz * P[5];
      let r = 0,
        rb = 0.5,
        prev = 1;
      for (let i = 0; i < 6; ++i) {
        let n = 1 - Math.abs(noised(rx, rz)[0]) * 1.4;
        n *= n;
        r += n * rb * prev;
        prev = n;
        rb *= 0.5;
        const nx = 1.6 * rx - 1.2 * rz;
        const nz = 1.2 * rx + 1.6 * rz;
        rx = nx;
        rz = nz;
      }
      h += P[4] * mf * r;
    }
  }

  // Valleys: land rises away from the road.
  h += P[25] * smoothstep(0, P[26], ad);

  // Mesas / terraces.
  if (P[8] > 0) {
    const k = h / P[9];
    const fk = k - Math.floor(k);
    const t = (Math.floor(k) + smoothstep(0.35, 0.65, fk)) * P[9];
    h = mix(h, t, P[8]);
  }

  // Dunes.
  if (P[27] > 0) {
    const n = noised(px * 0.012 + pz * 0.004, pz * 0.01)[0];
    h += P[27] * (1 - Math.abs(n) * 1.4);
  }

  // Canyons crossing the road.
  if (P[16] > 0) {
    const n = noised(pz * P[17], px * P[17] * 0.35 + 17.3)[0];
    const c = 1 - smoothstep(0, P[18], Math.abs(n));
    h -= P[16] * c * c;
  }

  // Coastline: beyond the shoreline offset on the ocean side, drop to seabed.
  if (P[12] !== 0) {
    // Rugged coasts (P[28] > 0): coves and headlands along the shore.
    const o =
      P[13] +
      50 * noised(pz * 0.004, 3.1)[0] +
      P[28] * noised(pz * 0.013, 7.7)[0];
    const sd = d * P[12] - o;
    const t = smoothstep(-P[15], P[15] * 0.3, sd);
    const beach = P[14] + 6 * noised(px * 0.01, pz * 0.01)[0];
    h = mix(h, beach, t);
    if (P[28] > 0) {
      // Gullies and buttresses down the cliff face.
      const face = t * (1 - t) * 4;
      const g = 1 - Math.abs(noised(px * 0.045, pz * 0.045)[0]) * 1.6;
      h += P[28] * 0.45 * face * g;
    }
    if (P[29] > 0) {
      // Sea stacks and rock shelves off the cliff foot.
      const off = sd - P[15] * 0.3;
      if (off > 0 && off < P[29]) {
        const n = noised(px * 0.06 + 5.3, pz * 0.06)[0];
        const k = smoothstep(0.42, 0.52, n) * (1 - off / P[29]);
        const top =
          3 + 30 * smoothstep(-0.4, 0.8, noised(px * 0.05, pz * 0.05)[0]);
        h = mix(h, top, k);
      }
    }
  }
  return h;
}

// Polynomial smooth-min.
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// Applies the road corridor: cut/fill slopes toward the road surface.
export function roadBlend(
  P: Float32Array,
  natural: number,
  d: number,
  roadY: number,
  bridge: number,
): number {
  const target = roadY - 0.12;
  const excess = Math.max(Math.abs(d) - P[20], 0);
  const delta = natural - target;
  const cutLim = excess * P[21];
  const fillLim = mix(excess * P[22], 1e5, bridge);
  // clamp(delta, -fillLim, cutLim), smoothed; the smoothing width shrinks to
  // zero inside the corridor so the terrain sits exactly under the road.
  const k = Math.min(Math.max(excess * 0.5, 0.001), 2);
  const c = smin(delta, cutLim, k);
  return target - smin(-c, fillLim, k);
}
