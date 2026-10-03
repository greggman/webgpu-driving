// The road: an endless centerline parameterized by world z. Because the road
// only trends forward (|heading| < maxHeading < 90 deg), z is monotonic along
// it, so x(z), y(z), heading(z) fully describe it and "nearest road point"
// queries become cheap 1D lookups. Everything else in the world is placed
// relative to this spine.
import {noise1, clamp, hash01, mix, smoothstep} from '../math/noise';
import {Biome, packTerrain} from './biome';
import {naturalHeight, roadBlend} from './terrain';

export const ROAD_DZ = 2; // meters between samples
export const ROAD_TEX_SAMPLES = 8192; // GPU window (16 km)
export const MAX_GRADE = 0.085;
export const ROAD_TEX_BEHIND = 2048; // samples kept behind the camera (4 km)

// Tunnel bore (the GPU twins are in terrain.wgsl): the walls stand
// TUNNEL_SIDE beyond the paved half width, TUNNEL_WALL high, under an
// elliptical vault whose crown is TUNNEL_H above the road.
export const TUNNEL_SIDE = 1.2;
export const TUNNEL_WALL = 3.5;
export const TUNNEL_H = 7;
// A tunnel runs where the ground stands more than TUNNEL_PORTAL m above the
// road, around a core at least TUNNEL_CORE_LEN m long where it stands more
// than biome.road.tunnelCover m above it.
const TUNNEL_PORTAL = 10;
// Sky light inside a bore falls off as exp(-distance / this) from the portal.
const TUNNEL_SKY_FALLOFF = 8;
const TUNNEL_CORE_LEN = 40;
// Dips in the cover shorter than this (m) don't split a tunnel in two.
const TUNNEL_MERGE = 60;

export interface Tunnel {
  s0: number; // arc length of the entry portal
  s1: number; // ... and of the exit portal
}

export interface RoadPoint {
  x: number;
  y: number;
  z: number;
  heading: number;
  bridge: number;
  // > 0 inside a tunnel: 1 + distance (m) from the nearer portal.
  tunnel: number;
  s: number;
}

export interface RoadInfo {
  d: number;
  y: number;
  bridge: number;
  tunnel: number;
  heading: number;
  along: number; // world z of nearest centerline point
}

class Grow {
  data = new Float64Array(4096);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const n = new Float64Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    this.data[this.length++] = v;
  }
}

export class Road {
  readonly biome: Biome;
  readonly terrainParams: Float32Array;
  readonly seed: number;
  readonly halfWidth: number; // paved half width (lanes + shoulder)

  // Raw integration state.
  private sCur = 0;
  private xCur = 0;
  private zCur = 0;
  private hCur = 0;
  private L1: number;
  private L2: number;
  private a2: number;

  // Per-sample (index i -> z = i * ROAD_DZ) arrays.
  private xs = new Grow();
  private headings = new Grow();
  private ss = new Grow();
  private natural = new Grow();
  private box1 = new Grow();
  private ys = new Grow(); // final, smoothed (valid < finalCount)
  private bridges = new Grow();
  private tunnelDepth = new Grow(); // see RoadPoint.tunnel
  private tunnelList: Tunnel[] = [];
  private finalCount = 0; // samples with every array final
  private smoothHalf: number;

  constructor(biome: Biome, seed: number) {
    this.biome = biome;
    this.seed = seed;
    this.terrainParams = packTerrain(biome.terrain, seed);
    const r = biome.road;
    this.halfWidth = r.lanesPerDir * r.laneWidth + r.shoulder;
    this.terrainParams[20] = this.halfWidth + 0.8; // flat corridor
    this.L1 = 1500 - 900 * r.wiggle;
    this.L2 = 520 - 340 * r.wiggle;
    this.a2 = 0.25 + 0.35 * r.wiggle;
    this.smoothHalf = Math.round(r.smoothing / ROAD_DZ);
    this.hCur = this.headingAt(0);
    this.ensure(ROAD_TEX_SAMPLES * ROAD_DZ);
  }

  private headingAt(s: number): number {
    const r = this.biome.road;
    const n =
      (1 - this.a2) * noise1(s / this.L1, this.seed) +
      this.a2 * noise1(s / this.L2 + 100, this.seed + 1);
    return r.maxHeading * clamp(n * 1.3, -1, 1);
  }

  get count(): number {
    return this.finalCount;
  }

  // Make sure samples exist up to world z.
  ensure(zMax: number) {
    const need = Math.ceil(zMax / ROAD_DZ) + 2;
    while (this.finalCount < need) this.generateBlock(512);
  }

  private generateBlock(n: number) {
    const P = this.terrainParams;
    const target = this.xs.length + n;
    const ds = 0.5;
    while (this.xs.length < target) {
      const i = this.xs.length;
      const zi = i * ROAD_DZ;
      // Integrate until we pass zi.
      while (this.zCur < zi) {
        const h = this.headingAt(this.sCur + ds * 0.5);
        this.xCur += Math.sin(h) * ds;
        this.zCur += Math.cos(h) * ds;
        this.sCur += ds;
        this.hCur = h;
      }
      // Step back fractionally to land exactly on zi.
      const over = (this.zCur - zi) / Math.max(Math.cos(this.hCur), 1e-3);
      const x = this.xCur - Math.sin(this.hCur) * over;
      const s = this.sCur - over;
      this.xs.push(x);
      this.headings.push(this.hCur);
      this.ss.push(s);
      this.natural.push(naturalHeight(P, x, zi, 0));
    }
    // Finalize samples whose smoothing window is complete: two box-filter
    // passes (≈ triangle filter), clamped at the start of the road.
    const W = this.smoothHalf;
    const nat = this.natural.data;
    const end1 = this.xs.length - W - 1;
    for (let i = this.box1.length; i < end1; ++i) {
      let sum = 0;
      for (let k = -W; k <= W; ++k) sum += nat[Math.max(0, i + k)];
      let y = sum / (2 * W + 1);
      // Grade limit (forward clamp); the second box pass smooths the kinks.
      if (i > 0) {
        const prev = this.box1.data[i - 1];
        const g = MAX_GRADE * ROAD_DZ;
        y = clamp(y, prev - g, prev + g);
      }
      this.box1.push(y);
    }
    const end = end1 - W;
    const b1 = this.box1.data;
    for (let i = this.ys.length; i < end; ++i) {
      let sum = 0;
      for (let k = -W; k <= W; ++k) sum += b1[Math.max(0, i + k)];
      let y = sum / (2 * W + 1);
      if (this.biome.ocean) y = Math.max(y, 6);
      this.ys.push(y);
    }
    // Bridges where the ground falls well below the deck, dilated.
    const ys = this.ys.data;
    for (let i = this.bridges.length; i < end; ++i) {
      let b = 0;
      for (let k = -5; k <= 5; ++k) {
        const j = Math.max(0, Math.min(end - 1, i + k));
        if (j < this.ys.length && nat[j] < ys[j] - 7) b = 1;
      }
      this.bridges.push(b);
    }
    this.classifyTunnels(end);
    this.finalCount = this.tunnelDepth.length;
  }

  // Tunnels over samples [tunnelDepth.length, end): each run where the
  // ground stands more than TUNNEL_PORTAL above the road (bridging dips
  // shorter than TUNNEL_MERGE) becomes a tunnel if it holds a deep enough
  // core. A run still open at `end` waits for more samples (so finalCount
  // can lag the smoothed heights).
  private classifyTunnels(end: number) {
    const cover = this.biome.road.tunnelCover;
    const nat = this.natural.data;
    const ys = this.ys.data;
    const out = this.tunnelDepth;
    const coreN = TUNNEL_CORE_LEN / ROAD_DZ;
    const mergeN = TUNNEL_MERGE / ROAD_DZ;
    const covered = (k: number) => nat[k] - ys[k] > TUNNEL_PORTAL;
    let i = out.length;
    while (i < end) {
      if (cover <= 0 || !covered(i)) {
        out.push(0);
        i++;
        continue;
      }
      let j = i;
      let run = 0,
        core = 0;
      for (;;) {
        while (j < end && covered(j)) {
          run = nat[j] - ys[j] > cover ? run + 1 : 0;
          core = Math.max(core, run);
          j++;
        }
        // A short dip: the run goes on past it.
        let k = j;
        while (k < end && k - j < mergeN && !covered(k)) k++;
        if (k === end) return;
        if (k - j >= mergeN) break;
        j = k;
      }
      const tunnel = core >= coreN;
      for (let k = i; k < j; ++k)
        out.push(tunnel ? 1 + Math.min(k - i, j - 1 - k) * ROAD_DZ : 0);
      if (tunnel)
        this.tunnelList.push({s0: this.ss.data[i], s1: this.ss.data[j - 1]});
      i = j;
    }
  }

  // Tunnels overlapping arc lengths [s0, s1].
  tunnelsBetween(s0: number, s1: number): Tunnel[] {
    this.ensure(this.zAtS(s1) + 100);
    return this.tunnelList.filter(t => t.s1 >= s0 && t.s0 <= s1);
  }

  // Interpolated centerline sample at world z.
  atZ(z: number): RoadPoint {
    this.ensure(z + 100);
    const fi = Math.max(0, z / ROAD_DZ);
    const i = Math.min(Math.floor(fi), this.finalCount - 2);
    const t = fi - i;
    const l = (a: Grow) => a.data[i] + (a.data[i + 1] - a.data[i]) * t;
    return {
      x: l(this.xs),
      y: l(this.ys),
      z,
      heading: l(this.headings),
      bridge: l(this.bridges),
      tunnel: l(this.tunnelDepth),
      s: l(this.ss),
    };
  }

  // World z at arc length s (binary search).
  zAtS(s: number): number {
    while (this.ss.data[this.finalCount - 1] < s + 200) {
      this.ensure(this.finalCount * ROAD_DZ + 1000);
    }
    let lo = 0,
      hi = this.finalCount - 1;
    const ss = this.ss.data;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ss[mid] < s) lo = mid;
      else hi = mid;
    }
    const t = (s - ss[lo]) / Math.max(ss[hi] - ss[lo], 1e-6);
    return (lo + t) * ROAD_DZ;
  }

  atS(s: number): RoadPoint {
    return this.atZ(this.zAtS(s));
  }

  // Canopy sections (0-1) at world z: where trees crowd the shoulder and
  // lean over the road, on about biome.scatter.canopy of it, except near
  // bridges. The GPU twin is
  // canopyAt in veg_scatter.wgsl (seeded with canopySeed).
  get canopySeed(): number {
    return this.seed + 7;
  }
  canopyAt(z: number): number {
    const share = this.biome.scatter.canopy;
    if (share <= 0) return 0;
    const x = z / 400;
    const i = Math.floor(x);
    const f = x - i;
    const v = mix(
      hash01(i, this.canopySeed),
      hash01(i + 1, this.canopySeed),
      f * f * (3 - 2 * f),
    );
    const thr = mix(0.75, 0.25, share);
    const c = smoothstep(thr - 0.04, thr + 0.04, v);
    // None near a bridge (trees from the ground below would grow through
    // the deck).
    if (c > 0) {
      for (let k = -2; k <= 2; ++k) {
        if (this.atZ(z + k * 15).bridge > 0) return 0;
      }
    }
    return c;
  }

  // Position of a point at arc length s and lateral offset d (+ = +x side),
  // on the road surface.
  pointAt(
    s: number,
    d: number,
  ): {pos: [number, number, number]; heading: number} {
    const p = this.atS(s);
    const c = Math.cos(p.heading),
      sn = Math.sin(p.heading);
    return {pos: [p.x + c * d, p.y, p.z - sn * d], heading: p.heading};
  }

  info(x: number, z: number): RoadInfo {
    let z1 = z;
    let r = this.atZ(z1);
    for (let i = 0; i < 2; ++i) {
      const s = Math.sin(r.heading),
        c = Math.cos(r.heading);
      const along = (x - r.x) * s + (z - z1) * c;
      z1 += clamp(along * c, -60, 60);
      r = this.atZ(z1);
    }
    const s = Math.sin(r.heading),
      c = Math.cos(r.heading);
    return {
      d: (x - r.x) * c - (z - z1) * s,
      y: r.y,
      bridge: r.bridge,
      tunnel: r.tunnel,
      heading: r.heading,
      along: z1,
    };
  }

  terrainHeight(x: number, z: number): number {
    const ri = this.info(x, z);
    const n = naturalHeight(this.terrainParams, x, z, ri.d);
    return roadBlend(this.terrainParams, n, ri.d, ri.y, ri.bridge, ri.tunnel);
  }

  // Ground height including the road deck (for camera collision); inside a
  // tunnel's bore, the road (not the hill above).
  groundHeight(x: number, z: number): number {
    const ri = this.info(x, z);
    if (ri.tunnel >= 1 && Math.abs(ri.d) < this.boreHalfWidth) return ri.y;
    const t = this.terrainHeight(x, z);
    if (Math.abs(ri.d) < this.halfWidth + 1) return Math.max(t, ri.y);
    return t;
  }

  // How much of the sky a point sees: 1 outside, falling off with the
  // distance from the portal inside a tunnel's bore (GPU twin: tunnelSkyVis
  // in lighting.wgsl).
  skyVisibility(x: number, y: number, z: number): number {
    const ri = this.info(x, z);
    if (ri.tunnel < 1) return 1;
    const h = y - ri.y;
    if (Math.abs(ri.d) > this.boreHalfWidth + 0.5) return 1;
    if (h > this.tunnelRoof(ri.d) + 0.5 || h < -3) return 1;
    return Math.exp(-(ri.tunnel - 1) / TUNNEL_SKY_FALLOFF);
  }

  get boreHalfWidth(): number {
    return this.halfWidth + TUNNEL_SIDE;
  }

  // Height of the bore's lining above the road at lateral offset d.
  tunnelRoof(d: number): number {
    const u = Math.min(Math.abs(d) / this.boreHalfWidth, 1);
    return TUNNEL_WALL + (TUNNEL_H - TUNNEL_WALL) * Math.sqrt(1 - u * u);
  }

  // Fills a GPU texture row: (x - originX, y, heading, bridge - tunnel) for
  // ROAD_TEX_SAMPLES samples starting at sample index i0 (bridges and
  // tunnels never meet, so one channel holds both; see roadSample).
  fillTexture(out: Float32Array, i0: number, originX: number) {
    this.ensure((i0 + ROAD_TEX_SAMPLES + 4) * ROAD_DZ);
    for (let k = 0; k < ROAD_TEX_SAMPLES; ++k) {
      const i = Math.max(0, i0 + k);
      out[k * 4] = this.xs.data[i] - originX;
      out[k * 4 + 1] = this.ys.data[i];
      out[k * 4 + 2] = this.headings.data[i];
      out[k * 4 + 3] = this.bridges.data[i] - this.tunnelDepth.data[i];
    }
  }
}
