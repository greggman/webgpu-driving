// Road surface mesh, generated in 64 m chunks along the arc length s. Each
// chunk is a strip of cross-sections (skirts, lanes, bridge barriers and
// underside); only chunks inside the forward streaming window exist.
import {shaderModule} from '../gpu/gpu';
import {aabbInFrustum} from '../math/mat4';
import {Road} from '../world/road';
import {RENDER_PRELUDE} from './shaders';
import roadSrc from '../shaders/road.wgsl';
import {GBUFFER_TARGETS, DEPTH_FORMAT} from './targets';

export const CHUNK_LEN = 64;
const ROWS = 33; // 2 m spacing
const FLOATS = 9; // pos3 normal3 uv2 mat1
const SLOTS = 80;
const BEHIND = 400;
const AHEAD = 4200;

interface Chunk {
  k: number;
  slot: number;
  min: [number, number, number];
  max: [number, number, number];
  bridge: boolean;
}

export interface BridgePier {
  x: number;
  y: number;
  z: number;
  height: number;
  heading: number;
}

export class RoadMesh {
  private vbuf: GPUBuffer;
  private ibuf: GPUBuffer;
  private indexCount = 0;
  private vertsPerChunk = 0;
  private chunks = new Map<number, Chunk>();
  private freeSlots: number[] = [];
  private originX = 0;
  private originZ = 0;
  pipeline!: GPURenderPipeline;
  shadowPipeline!: GPURenderPipeline;
  visible: Chunk[] = [];
  piers = new Map<number, BridgePier[]>();

  constructor(
    private device: GPUDevice,
    private road: Road,
  ) {
    const cols = this.profile(0).length;
    // Each profile segment gets its own pair of columns (flat normals).
    const segs = cols - 1;
    this.vertsPerChunk = ROWS * segs * 2;
    this.vbuf = device.createBuffer({
      label: 'road-vertices',
      size: this.vertsPerChunk * FLOATS * 4 * SLOTS,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const idx: number[] = [];
    for (let r = 0; r < ROWS - 1; ++r) {
      for (let sg = 0; sg < segs; ++sg) {
        const a = r * segs * 2 + sg * 2;
        const b = a + 1;
        const c = a + segs * 2;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    this.indexCount = idx.length;
    const ia = new Uint16Array(idx);
    this.ibuf = device.createBuffer({
      label: 'road-indices',
      size: ia.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.ibuf, 0, ia);
    for (let i = SLOTS - 1; i >= 0; --i) this.freeSlots.push(i);
  }

  // Cross-section, from the +x side (d > 0) to the -x side. [d, dy, mat]
  // mat: 0 = pavement, 1 = concrete barrier/deck, 2 = shoulder skirt.
  private profile(b: number): Array<[number, number, number]> {
    const hw = this.road.halfWidth;
    const p: Array<[number, number, number]> = [];
    const edge = (sgn: number) => [
      [sgn * (hw + 1.4 - 0.8 * b), -0.7 - 1.0 * b, b > 0.5 ? 1 : 2],
      [sgn * (hw + 0.35 + 0.25 * b), -0.04 + 0.94 * b, b > 0.5 ? 1 : 2],
    ];
    const L = edge(1) as Array<[number, number, number]>;
    p.push(L[0], L[1]);
    const n = 8;
    for (let i = 0; i <= n; ++i) {
      const d = hw - (2 * hw * i) / n;
      p.push([d, -0.015 * Math.abs(d), 0]);
    }
    const R = edge(-1) as Array<[number, number, number]>;
    p.push(R[1], R[0]);
    // Underside back to the start (visible only on bridges).
    p.push([L[0][0], L[0][1], 1]);
    return p;
  }

  setOrigin(ox: number, oz: number) {
    if (ox !== this.originX || oz !== this.originZ) {
      this.originX = ox;
      this.originZ = oz;
      // Positions are stored relative to the origin: rebuild everything.
      for (const c of this.chunks.values()) this.freeSlots.push(c.slot);
      this.chunks.clear();
    }
  }

  private build(k: number, slot: number): Chunk {
    const segsProfile = this.profile(0).length - 1;
    const data = new Float32Array(this.vertsPerChunk * FLOATS);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let anyBridge = false;
    let o = 0;
    for (let r = 0; r < ROWS; ++r) {
      const s = k * CHUNK_LEN + r * 2;
      const c = this.road.atS(s);
      const a = this.road.atS(s - 1),
        bpt = this.road.atS(s + 1);
      const T = [bpt.x - a.x, bpt.y - a.y, bpt.z - a.z];
      const tl = Math.hypot(T[0], T[1], T[2]);
      T[0] /= tl;
      T[1] /= tl;
      T[2] /= tl;
      const L = [Math.cos(c.heading), 0, -Math.sin(c.heading)];
      // Up = T x L.
      const U = [
        T[1] * L[2] - T[2] * L[1],
        T[2] * L[0] - T[0] * L[2],
        T[0] * L[1] - T[1] * L[0],
      ];
      const bridge = c.bridge > 0.5 ? 1 : 0;
      if (bridge) anyBridge = true;
      const prof = this.profile(bridge);
      const v = s % 1024;
      for (let sg = 0; sg < segsProfile; ++sg) {
        const p0 = prof[sg],
          p1 = prof[sg + 1];
        const dd = p1[0] - p0[0],
          dy = p1[1] - p0[1];
        const nl = Math.hypot(dd, dy) || 1;
        const n2 = [dy / nl, -dd / nl];
        const nx = L[0] * n2[0] + U[0] * n2[1];
        const ny = L[1] * n2[0] + U[1] * n2[1];
        const nz = L[2] * n2[0] + U[2] * n2[1];
        const mat = sg === segsProfile - 1 ? p1[2] : Math.max(p0[2], p1[2]);
        for (const p of [p0, p1]) {
          const x = c.x + L[0] * p[0] + U[0] * p[1] - this.originX;
          const y = c.y + L[1] * p[0] + U[1] * p[1];
          const z = c.z + L[2] * p[0] + U[2] * p[1] - this.originZ;
          data.set([x, y, z, nx, ny, nz, p[0], v, mat], o);
          o += FLOATS;
          min[0] = Math.min(min[0], x);
          min[1] = Math.min(min[1], y);
          min[2] = Math.min(min[2], z);
          max[0] = Math.max(max[0], x);
          max[1] = Math.max(max[1], y);
          max[2] = Math.max(max[2], z);
        }
      }
    }
    this.device.queue.writeBuffer(
      this.vbuf,
      slot * this.vertsPerChunk * FLOATS * 4,
      data,
    );
    // Bridge piers every 32 m.
    const piers: BridgePier[] = [];
    if (anyBridge) {
      for (let s = k * CHUNK_LEN; s < (k + 1) * CHUNK_LEN; s += 32) {
        const c = this.road.atS(s);
        if (c.bridge < 0.5) continue;
        const ground = this.road.terrainHeight(c.x, c.z);
        const h = c.y - 1.7 - ground;
        if (h > 1) {
          piers.push({
            x: c.x,
            y: ground,
            z: c.z,
            height: h + 1,
            heading: c.heading,
          });
        }
      }
    }
    this.piers.set(k, piers);
    min[1] -= 2;
    return {k, slot, min, max, bridge: anyBridge};
  }

  update(sCam: number, planes: Float32Array) {
    const k0 = Math.floor((sCam - BEHIND) / CHUNK_LEN);
    const k1 = Math.floor((sCam + AHEAD) / CHUNK_LEN);
    for (const [k, c] of this.chunks) {
      if (k < k0 || k > k1) {
        this.freeSlots.push(c.slot);
        this.chunks.delete(k);
        this.piers.delete(k);
      }
    }
    // Build nearest-first, a limited number per frame (all on first frame).
    let budget = this.chunks.size === 0 ? 1000 : 8;
    const kc = Math.floor(sCam / CHUNK_LEN);
    for (let dk = 0; dk <= k1 - k0 && budget > 0; ++dk) {
      for (const k of [kc + dk, kc - dk]) {
        if (k < k0 || k > k1 || this.chunks.has(k) || budget <= 0) continue;
        const slot = this.freeSlots.pop();
        if (slot === undefined) break;
        this.chunks.set(k, this.build(k, slot));
        budget--;
      }
    }
    this.visible = [];
    for (const c of this.chunks.values()) {
      if (
        aabbInFrustum(
          planes,
          c.min[0],
          c.min[1],
          c.min[2],
          c.max[0],
          c.max[1],
          c.max[2],
        )
      ) {
        this.visible.push(c);
      }
    }
  }

  allChunks(): Chunk[] {
    return [...this.chunks.values()];
  }

  createPipelines(
    frameLayout: GPUBindGroupLayout,
    shadowLayout: GPUBindGroupLayout,
  ) {
    const d = this.device;
    const module = shaderModule(d, RENDER_PRELUDE + '\n' + roadSrc, 'road');
    const buffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: FLOATS * 4,
        attributes: [
          {shaderLocation: 0, offset: 0, format: 'float32x3'},
          {shaderLocation: 1, offset: 12, format: 'float32x3'},
          {shaderLocation: 2, offset: 24, format: 'float32x2'},
          {shaderLocation: 3, offset: 32, format: 'float32'},
        ],
      },
    ];
    this.pipeline = d.createRenderPipeline({
      label: 'road',
      layout: d.createPipelineLayout({
        label: 'road-layout',
        bindGroupLayouts: [frameLayout],
      }),
      vertex: {module, entryPoint: 'vs', buffers},
      fragment: {module, entryPoint: 'fs', targets: GBUFFER_TARGETS},
      primitive: {topology: 'triangle-list', cullMode: 'back'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    });
    this.shadowPipeline = d.createRenderPipeline({
      label: 'road-shadow',
      layout: d.createPipelineLayout({
        label: 'road-shadow-layout',
        bindGroupLayouts: [
          frameLayout,
          d.createBindGroupLayout({label: 'empty', entries: []}),
          shadowLayout,
        ],
      }),
      vertex: {module, entryPoint: 'vsShadow', buffers},
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
        depthBias: -2,
        depthBiasSlopeScale: -2,
      },
    });
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    this.drawChunks(pass, this.visible);
  }

  drawShadow(pass: GPURenderPassEncoder, emptyBG: GPUBindGroup) {
    pass.setPipeline(this.shadowPipeline);
    pass.setBindGroup(1, emptyBG);
    // Only bridges cast meaningful shadows.
    this.drawChunks(
      pass,
      this.allChunks().filter(c => c.bridge),
    );
  }

  private drawChunks(pass: GPURenderPassEncoder, list: Chunk[]) {
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, 'uint16');
    for (const c of list) {
      pass.drawIndexed(this.indexCount, 1, 0, c.slot * this.vertsPerChunk);
    }
  }
}
