// Roadside props placed deterministically per road chunk: fences (posts +
// rails/boards/wires), guardrails, utility poles with sagging wires, farm
// buildings, curve warning signs, delineators and bridge piers.
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
import {aabbInFrustum} from '../math/mat4';
import {Rng} from '../math/noise';
import {Biome} from '../world/biome';
import {Road} from '../world/road';
import {
  PropKind,
  buildProp,
  PM_METAL,
  PM_WIRE,
  PM_WOOD,
  PM_DARKWOOD,
} from '../gen/props';
import {MeshBuilder, VEG_FLOATS} from '../gen/meshBuilder';
import {RENDER_PRELUDE} from './shaders';
import propsSrc from '../shaders/props.wgsl';
import {CHUNK_LEN, RoadMesh} from './roadMesh';
import {DEPTH_FORMAT, GBUFFER_TARGETS} from './targets';

const KINDS: PropKind[] = [
  'post',
  'railPost',
  'guardPost',
  'pole',
  'pier',
  'barn',
  'house',
  'silo',
  'sign',
  'delineator',
  'mailbox',
  'tumbleweed',
];
const MAX_INST = 16384;
const LIN_SLOTS = 80;
const LIN_MAX_VERTS = 8000;
const LIN_MAX_IDX = 14000;
const PROP_RANGE = 1600;

interface WorldInst {
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  stretch: number;
  scale: number;
  tint: number;
  roll?: number;
}

interface ChunkProps {
  k: number;
  insts: WorldInst[];
  lin: {vertices: Float32Array; indices: Uint32Array} | null;
  slot: number;
  indexCount: number;
  min: number[];
  max: number[];
}

export class Props {
  private kindMesh = new Map<
    PropKind,
    {firstIndex: number; count: number; baseVertex: number}
  >();
  private vbuf: GPUBuffer;
  private ibuf: GPUBuffer;
  private instBuf: GPUBuffer;
  private instData = new Float32Array(MAX_INST * 8);
  private linV: GPUBuffer;
  private linI: GPUBuffer;
  private layout: GPUBindGroupLayout;
  private bg: GPUBindGroup;
  private identityBG: GPUBindGroup;
  private pipe!: GPURenderPipeline;
  private shadowPipe!: GPURenderPipeline;
  private chunks = new Map<number, ChunkProps>();
  private freeSlots: number[] = [];
  private road: Road | null = null;
  private biome: Biome | null = null;
  private originX = 0;
  private originZ = 0;
  private draws: Array<{kind: PropKind; first: number; count: number}> = [];
  private visibleLin: ChunkProps[] = [];
  private shadowLin: ChunkProps[] = [];
  // Per-frame dynamic props (tumbleweeds), world coordinates.
  dynamic: WorldInst[] = [];
  // Built prop meshes (CPU copies, for regrowing the GPU buffers).
  private built: Array<{
    v: Float32Array;
    i: Uint32Array;
    vo: number;
    io: number;
  }> = [];
  private vUsed = 0;
  private iUsed = 0;

  private makeVBuf(floats: number) {
    return this.device.createBuffer({
      label: 'prop-vertices',
      size: floats * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }
  private makeIBuf(count: number) {
    return this.device.createBuffer({
      label: 'prop-indices',
      size: count * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
  }

  // Builds a prop kind's mesh the first time it is needed, appending it to
  // the shared buffers (regrown and rewritten when full).
  private ensureKind(kind: PropKind) {
    if (this.kindMesh.has(kind)) return;
    const m = buildProp(kind);
    const q = this.device.queue;
    const vNeed = this.vUsed + m.vertices.length,
      iNeed = this.iUsed + m.indices.length;
    if (vNeed * 4 > this.vbuf.size || iNeed * 4 > this.ibuf.size) {
      this.vbuf.destroy();
      this.ibuf.destroy();
      this.vbuf = this.makeVBuf(Math.max(vNeed, (this.vbuf.size / 4) * 2));
      this.ibuf = this.makeIBuf(Math.max(iNeed, (this.ibuf.size / 4) * 2));
      for (const b of this.built) {
        q.writeBuffer(this.vbuf, b.vo * 4, b.v);
        q.writeBuffer(this.ibuf, b.io * 4, b.i);
      }
    }
    q.writeBuffer(this.vbuf, this.vUsed * 4, m.vertices);
    q.writeBuffer(this.ibuf, this.iUsed * 4, m.indices);
    this.built.push({
      v: m.vertices,
      i: m.indices,
      vo: this.vUsed,
      io: this.iUsed,
    });
    this.kindMesh.set(kind, {
      firstIndex: this.iUsed,
      count: m.indices.length,
      baseVertex: this.vUsed / VEG_FLOATS,
    });
    this.vUsed = vNeed;
    this.iUsed = iNeed;
  }

  constructor(
    private device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    shadowLayout: GPUBindGroupLayout,
  ) {
    const d = device;
    // Static prop meshes are built on first use (see ensureKind): a biome
    // only pays for the fences, poles and buildings it actually has.
    this.vbuf = this.makeVBuf(4096 * VEG_FLOATS);
    this.ibuf = this.makeIBuf(16384);
    this.instBuf = d.createBuffer({
      label: 'prop-instances',
      size: MAX_INST * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.linV = d.createBuffer({
      label: 'prop-linear-vertices',
      size: LIN_SLOTS * LIN_MAX_VERTS * VEG_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.linI = d.createBuffer({
      label: 'prop-linear-indices',
      size: LIN_SLOTS * LIN_MAX_IDX * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    for (let i = LIN_SLOTS - 1; i >= 0; --i) this.freeSlots.push(i);
    this.layout = d.createBindGroupLayout({
      label: 'prop-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: {type: 'read-only-storage'},
        },
      ],
    });
    this.bg = d.createBindGroup({
      label: 'prop-bg',
      layout: this.layout,
      entries: [{binding: 0, resource: {buffer: this.instBuf}}],
    });
    const ident = d.createBuffer({
      label: 'prop-identity-instance',
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(ident, 0, new Float32Array([0, 0, 0, 0, 1, 1, 0.5, 0]));
    this.identityBG = d.createBindGroup({
      label: 'prop-identity-bg',
      layout: this.layout,
      entries: [{binding: 0, resource: {buffer: ident}}],
    });
    const module = shaderModule(d, RENDER_PRELUDE + '\n' + propsSrc, 'props');
    const vtx: GPUVertexBufferLayout[] = [
      {
        arrayStride: VEG_FLOATS * 4,
        attributes: [
          {shaderLocation: 0, offset: 0, format: 'float32x3'},
          {shaderLocation: 1, offset: 12, format: 'float32x3'},
          {shaderLocation: 2, offset: 24, format: 'float32x2'},
          {shaderLocation: 3, offset: 32, format: 'float32'},
          {shaderLocation: 4, offset: 36, format: 'float32'},
        ],
      },
    ];
    const empty = d.createBindGroupLayout({label: 'prop-empty', entries: []});
    deferRenderPipeline(
      d,
      {
        label: 'props',
        layout: d.createPipelineLayout({
          label: 'props-pl',
          bindGroupLayouts: [frameLayout, this.layout, empty],
        }),
        vertex: {module, entryPoint: 'vs', buffers: vtx},
        fragment: {module, entryPoint: 'fs', targets: GBUFFER_TARGETS},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
        },
      },
      p => (this.pipe = p),
    );
    deferRenderPipeline(
      d,
      {
        label: 'props-shadow',
        layout: d.createPipelineLayout({
          label: 'props-shadow-pl',
          bindGroupLayouts: [frameLayout, this.layout, shadowLayout],
        }),
        vertex: {module, entryPoint: 'vsShadow', buffers: vtx},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
          depthBias: -2,
          depthBiasSlopeScale: -2,
        },
      },
      p => (this.shadowPipe = p),
    );
  }

  setWorld(biome: Biome, road: Road) {
    this.biome = biome;
    this.road = road;
    for (const c of this.chunks.values())
      if (c.slot >= 0) this.freeSlots.push(c.slot);
    this.chunks.clear();
  }

  private generate(k: number): ChunkProps {
    const road = this.road!;
    const biome = this.biome!;
    const rng = new Rng(k * 7919 + road.seed * 131);
    const insts: WorldInst[] = [];
    const lin = new MeshBuilder();
    const hw = road.halfWidth;
    const s0 = k * CHUNK_LEN,
      s1 = s0 + CHUNK_LEN;
    const ox = this.originX,
      oz = this.originZ;
    const L = (p: number[]) => [p[0] - ox, p[1], p[2] - oz];
    const fence = biome.road.fence;
    const sides = [-1, 1];
    // Fences / guardrails.
    if (fence !== 'none') {
      for (const side of sides) {
        if (
          fence === 'guardrail' &&
          biome.ocean &&
          side * biome.terrain.coastSide < 0
        )
          continue;
        const d = side * (fence === 'guardrail' ? hw + 0.7 : hw + 3.2);
        const step = fence === 'guardrail' ? 2 : fence === 'barbed' ? 4 : 3;
        let prev: number[] | null = null;
        for (let s = s0; s < s1 + 0.01; s += step) {
          const c = road.atS(s);
          if (c.bridge > 0.5) {
            prev = null;
            continue;
          }
          const p = road.pointAt(s, d);
          const ground = road.terrainHeight(p.pos[0], p.pos[2]);
          // Skip steep cuts/fills and occasional gaps (gates, driveways).
          const gap =
            fence !== 'guardrail' && Math.sin(s * 0.013 + side * 5) > 0.93;
          if (Math.abs(ground - c.y) > 2.5 || gap) {
            prev = null;
            continue;
          }
          const y = fence === 'guardrail' ? c.y - 0.05 : ground;
          const pos = [p.pos[0], y, p.pos[2]];
          if (s < s1) {
            insts.push({
              kind:
                fence === 'guardrail'
                  ? 'guardPost'
                  : fence === 'split-rail'
                    ? 'railPost'
                    : 'post',
              x: pos[0],
              y: pos[1],
              z: pos[2],
              yaw: p.heading + rng.range(-0.05, 0.05),
              stretch: rng.range(0.9, 1.1),
              scale: 1,
              tint: rng.next(),
            });
          }
          if (prev) {
            const a = L(prev),
              b = L(pos);
            if (fence === 'guardrail') {
              beam(lin, a, b, side, [0.55, 0.85], PM_METAL);
            } else if (fence === 'split-rail') {
              rail(lin, a, b, 0.45, 0.07, PM_WOOD);
              rail(lin, a, b, 0.95, 0.07, PM_WOOD);
            } else if (fence === 'wood') {
              for (const h of [0.45, 0.8, 1.1]) wire(lin, a, b, h, 0.012, 0.03);
            } else {
              for (const h of [0.5, 0.8, 1.1]) wire(lin, a, b, h, 0.01, 0.02);
            }
          }
          prev = pos;
        }
      }
    }
    // Utility poles with wires (poles every 45 m on the right side).
    if (biome.road.poles) {
      const spacing = 45;
      const d = -(hw + 5.5);
      const first = Math.ceil(s0 / spacing) * spacing;
      for (let s = first - spacing; s < s1; s += spacing) {
        const pa = road.pointAt(s, d),
          pb = road.pointAt(s + spacing, d);
        const ga = road.terrainHeight(pa.pos[0], pa.pos[2]);
        const gb = road.terrainHeight(pb.pos[0], pb.pos[2]);
        if (s >= s0) {
          insts.push({
            kind: 'pole',
            x: pa.pos[0],
            y: ga,
            z: pa.pos[2],
            // Local x (the crossarm) across the road, perpendicular to the
            // wires.
            yaw: pa.heading,
            stretch: 1,
            scale: 1,
            tint: 0.5,
          });
          const yawA = pa.heading,
            yawB = pb.heading;
          for (const off of [-1.05, 0, 1.05]) {
            const A = [
              pa.pos[0] + Math.cos(yawA) * off,
              ga + 9.85,
              pa.pos[2] - Math.sin(yawA) * off,
            ];
            const B = [
              pb.pos[0] + Math.cos(yawB) * off,
              gb + 9.85,
              pb.pos[2] - Math.sin(yawB) * off,
            ];
            sagWire(lin, L(A), L(B), 0.9, 0.018);
          }
        }
      }
    }
    // Delineators at night.
    if (biome.id === 'night' || biome.id === 'arizona') {
      for (let s = Math.ceil(s0 / 40) * 40; s < s1; s += 40) {
        for (const side of sides) {
          const p = road.pointAt(s, side * (hw + 1.1));
          const g = road.terrainHeight(p.pos[0], p.pos[2]);
          insts.push({
            kind: 'delineator',
            x: p.pos[0],
            y: g,
            z: p.pos[2],
            yaw: p.heading,
            stretch: 1,
            scale: 1,
            tint: 0.5,
          });
        }
      }
    }
    // Curve warning signs where the road bends sharply ahead.
    {
      const s = s0 + 20;
      const h0 = road.atS(s).heading,
        h1 = road.atS(s + 160).heading;
      if (Math.abs(h1 - h0) > 0.45 && rng.next() < 0.5) {
        const p = road.pointAt(s, -(hw + 1.6));
        const g = road.terrainHeight(p.pos[0], p.pos[2]);
        insts.push({
          kind: 'sign',
          x: p.pos[0],
          y: g,
          z: p.pos[2],
          yaw: p.heading + Math.PI,
          stretch: 1,
          scale: 1,
          tint: h1 > h0 ? 0 : 1,
        });
      }
    }
    // Farm buildings.
    const bp = biome.scatter.buildings;
    if (bp > 0 && rng.next() < bp * 0.12) {
      const side = rng.next() < 0.5 ? -1 : 1;
      const s = s0 + rng.range(10, 50);
      const off = side * (hw + rng.range(28, 60));
      const p = road.pointAt(s, off);
      const g = road.terrainHeight(p.pos[0], p.pos[2]);
      const gAlt = road.terrainHeight(p.pos[0] + 8, p.pos[2] + 8);
      if (
        Math.abs(gAlt - g) < 3 &&
        !(biome.ocean && side * biome.terrain.coastSide > 0)
      ) {
        const yaw =
          p.heading +
          (side > 0 ? -Math.PI / 2 : Math.PI / 2) +
          rng.range(-0.2, 0.2);
        const kinds: PropKind[] =
          rng.next() < 0.5 ? ['barn', 'house'] : ['barn', 'silo'];
        kinds.forEach((kind, i) => {
          const q = road.pointAt(s + i * 22, off + side * rng.range(0, 10));
          const gq = road.terrainHeight(q.pos[0], q.pos[2]);
          insts.push({
            kind,
            x: q.pos[0],
            y: gq,
            z: q.pos[2],
            yaw,
            stretch: 1,
            scale: 1,
            tint: rng.next(),
          });
        });
        const m = road.pointAt(s - 6, side * (hw + 2.4));
        insts.push({
          kind: 'mailbox',
          x: m.pos[0],
          y: road.terrainHeight(m.pos[0], m.pos[2]),
          z: m.pos[2],
          yaw: p.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2),
          stretch: 1,
          scale: 1,
          tint: 0.5,
        });
      }
    }
    const built = lin.build();
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    const grow = (x: number, y: number, z: number, r: number) => {
      min[0] = Math.min(min[0], x - r);
      min[1] = Math.min(min[1], y - r);
      min[2] = Math.min(min[2], z - r);
      max[0] = Math.max(max[0], x + r);
      max[1] = Math.max(max[1], y + r + 18);
      max[2] = Math.max(max[2], z + r);
    };
    for (const i of insts) grow(i.x - ox, i.y, i.z - oz, 12);
    for (let v = 0; v < built.vertices.length; v += VEG_FLOATS) {
      grow(built.vertices[v], built.vertices[v + 1], built.vertices[v + 2], 1);
    }
    let slot = -1;
    let indexCount = 0;
    if (
      built.indices.length &&
      built.vertices.length / VEG_FLOATS <= LIN_MAX_VERTS &&
      built.indices.length <= LIN_MAX_IDX
    ) {
      slot = this.freeSlots.pop() ?? -1;
      if (slot >= 0) {
        this.device.queue.writeBuffer(
          this.linV,
          slot * LIN_MAX_VERTS * VEG_FLOATS * 4,
          built.vertices,
        );
        this.device.queue.writeBuffer(
          this.linI,
          slot * LIN_MAX_IDX * 4,
          built.indices,
        );
        indexCount = built.indices.length;
      }
    }
    return {k, insts, lin: null, slot, indexCount, min, max};
  }

  update(
    s: number,
    ox: number,
    oz: number,
    planes: Float32Array,
    roadMesh: RoadMesh,
  ) {
    if (ox !== this.originX || oz !== this.originZ) {
      this.originX = ox;
      this.originZ = oz;
      for (const c of this.chunks.values())
        if (c.slot >= 0) this.freeSlots.push(c.slot);
      this.chunks.clear();
    }
    const k0 = Math.floor((s - 300) / CHUNK_LEN);
    const k1 = Math.floor((s + PROP_RANGE) / CHUNK_LEN);
    for (const [k, c] of this.chunks) {
      if (k < k0 || k > k1) {
        if (c.slot >= 0) this.freeSlots.push(c.slot);
        this.chunks.delete(k);
      }
    }
    let budget = this.chunks.size === 0 ? 1000 : 6;
    for (let k = Math.floor(s / CHUNK_LEN) - 5; k <= k1 && budget > 0; ++k) {
      if (k < k0 || this.chunks.has(k)) continue;
      this.chunks.set(k, this.generate(k));
      budget--;
    }
    // Gather instances by kind (visible chunks for the main view, all nearby
    // chunks for shadows) plus bridge piers.
    const byKind = new Map<PropKind, WorldInst[]>();
    this.visibleLin = [];
    this.shadowLin = [];
    for (const c of this.chunks.values()) {
      const vis = aabbInFrustum(
        planes,
        c.min[0],
        c.min[1],
        c.min[2],
        c.max[0],
        c.max[1],
        c.max[2],
      );
      const near = Math.abs(c.k * CHUNK_LEN - s) < 400;
      if (!vis && !near) continue;
      if (c.slot >= 0) {
        if (vis) this.visibleLin.push(c);
        if (near) this.shadowLin.push(c);
      }
      for (const i of c.insts) {
        let l = byKind.get(i.kind);
        if (!l) byKind.set(i.kind, (l = []));
        l.push(i);
      }
      for (const p of roadMesh.piers.get(c.k) ?? []) {
        let l = byKind.get('pier');
        if (!l) byKind.set('pier', (l = []));
        l.push({
          kind: 'pier',
          x: p.x,
          y: p.y - 1,
          z: p.z,
          yaw: p.heading,
          stretch: p.height,
          scale: 1,
          tint: 0.5,
        });
      }
    }
    for (const i of this.dynamic) {
      let l = byKind.get(i.kind);
      if (!l) byKind.set(i.kind, (l = []));
      l.push(i);
    }
    this.draws = [];
    let n = 0;
    for (const kind of KINDS) {
      const l = byKind.get(kind);
      if (!l) continue;
      this.ensureKind(kind);
      const first = n;
      for (const i of l) {
        if (n >= MAX_INST) break;
        this.instData.set(
          [
            i.x - ox,
            i.y,
            i.z - oz,
            i.yaw,
            i.stretch,
            i.scale,
            i.tint,
            i.roll ?? 0,
          ],
          n * 8,
        );
        n++;
      }
      this.draws.push({kind, first, count: n - first});
    }
    if (n)
      this.device.queue.writeBuffer(this.instBuf, 0, this.instData, 0, n * 8);
  }

  private drawAll(pass: GPURenderPassEncoder, lin: ChunkProps[]) {
    pass.setBindGroup(1, this.bg);
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, 'uint32');
    for (const d of this.draws) {
      const m = this.kindMesh.get(d.kind)!;
      pass.drawIndexed(m.count, d.count, m.firstIndex, m.baseVertex, d.first);
    }
    if (lin.length) {
      pass.setBindGroup(1, this.identityBG);
      pass.setVertexBuffer(0, this.linV);
      pass.setIndexBuffer(this.linI, 'uint32');
      for (const c of lin) {
        pass.drawIndexed(
          c.indexCount,
          1,
          c.slot * LIN_MAX_IDX,
          c.slot * LIN_MAX_VERTS,
          0,
        );
      }
    }
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipe);
    this.drawAll(pass, this.visibleLin);
  }

  drawShadow(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.shadowPipe);
    this.drawAll(pass, this.shadowLin);
  }
}

// ---- Linear prop geometry helpers (local coords) ----
function beam(
  mb: MeshBuilder,
  a: number[],
  b: number[],
  side: number,
  ys: number[],
  mat: number,
) {
  // W-beam guardrail: a slightly folded strip facing the road.
  const dx = b[0] - a[0],
    dz = b[2] - a[2];
  const l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * -side,
    nz = (dx / l) * -side;
  const prof = [
    [0, ys[0]],
    [0.05, ys[0] + 0.08],
    [0, (ys[0] + ys[1]) / 2],
    [0.05, ys[1] - 0.08],
    [0, ys[1]],
  ];
  for (let i = 0; i < prof.length - 1; ++i) {
    const [o0, y0] = prof[i],
      [o1, y1] = prof[i + 1];
    const n = [nx * (y1 - y0), -(o1 - o0), nz * (y1 - y0)];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const nn = [n[0] / nl, n[1] / nl, n[2] / nl];
    const off = 0.12;
    const P = (p: number[], o: number, y: number) => [
      p[0] + nx * (off + o),
      p[1] + y,
      p[2] + nz * (off + o),
    ];
    const i0 = mb.vert(P(a, o0, y0), nn, 0, 0, mat, 0);
    const i1 = mb.vert(P(b, o0, y0), nn, 1, 0, mat, 0);
    const i2 = mb.vert(P(b, o1, y1), nn, 1, 1, mat, 0);
    const i3 = mb.vert(P(a, o1, y1), nn, 0, 1, mat, 0);
    mb.quad(i0, i1, i2, i3);
  }
}

function rail(
  mb: MeshBuilder,
  a: number[],
  b: number[],
  y: number,
  r: number,
  mat: number,
) {
  const droop = 0.03;
  mb.tube(
    [
      [a[0], a[1] + y, a[2]],
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + y - droop, (a[2] + b[2]) / 2],
      [b[0], b[1] + y, b[2]],
    ],
    [r, r, r],
    5,
    mat,
    () => 0,
  );
}

function wire(
  mb: MeshBuilder,
  a: number[],
  b: number[],
  y: number,
  r: number,
  sag: number,
) {
  mb.tube(
    [
      [a[0], a[1] + y, a[2]],
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + y - sag, (a[2] + b[2]) / 2],
      [b[0], b[1] + y, b[2]],
    ],
    [r, r, r],
    3,
    PM_WIRE,
    () => 0,
  );
  void PM_DARKWOOD;
}

function sagWire(
  mb: MeshBuilder,
  a: number[],
  b: number[],
  sag: number,
  r: number,
) {
  const pts: number[][] = [];
  const N = 8;
  for (let i = 0; i <= N; ++i) {
    const t = i / N;
    pts.push([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t),
      a[2] + (b[2] - a[2]) * t,
    ]);
  }
  mb.tube(
    pts,
    pts.map(() => r),
    3,
    PM_WIRE,
    () => 0,
  );
}
