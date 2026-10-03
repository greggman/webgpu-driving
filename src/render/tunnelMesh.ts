// Tunnel linings: for each tunnel near the camera one mesh with the bore's
// cross-section swept along the road from portal to portal (curbs and
// walkways, tiled walls, the vault with two rows of lamps) plus a concrete
// headwall around each portal. The hill above is the terrain (with the bore
// cut out of it, see terrain_draw.wgsl), the floor the road mesh.
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
import {aabbInFrustum} from '../math/mat4';
import {Road, Tunnel, TUNNEL_H, TUNNEL_WALL} from '../world/road';
import {RENDER_PRELUDE} from './shaders';
import tunnelSrc from '../shaders/tunnel.wgsl';
import {GBUFFER_TARGETS, DEPTH_FORMAT} from './targets';

const FLOATS = 9; // pos3 normal3 uv2 mat1
const ROW = 2; // m between cross-sections
const BEHIND = 400;
const AHEAD = 4200;
// Lamp strips: at this fraction of the bore half width (TUNNEL_LAMP_D in
// lighting.wgsl), this wide (rad of the vault's ellipse).
const LAMP_D = 0.62;
const LAMP_HALF_ARC = 0.035;
// Headwall: how far it reaches beyond the bore, and how deep it is.
const HEAD_SIDE = 2.5;
const HEAD_TOP = 2.2;
const HEAD_DEPTH = 3;

// Materials (tunnel.wgsl).
const M_WALKWAY = 0,
  M_TILES = 1,
  M_VAULT = 2,
  M_LAMP = 3,
  M_HEADWALL = 4;

interface TunnelGPU {
  tunnel: Tunnel;
  vbuf: GPUBuffer;
  ibuf: GPUBuffer;
  indexCount: number;
  min: [number, number, number];
  max: [number, number, number];
}

type Vec3 = [number, number, number];

export class TunnelMesh {
  static pipeline: GPURenderPipeline;
  static shadowPipeline: GPURenderPipeline;
  private meshes = new Map<number, TunnelGPU>(); // keyed by s0
  private originX = 0;
  private originZ = 0;
  visible: TunnelGPU[] = [];

  constructor(
    private device: GPUDevice,
    private road: Road,
  ) {}

  setOrigin(ox: number, oz: number) {
    if (ox !== this.originX || oz !== this.originZ) {
      this.originX = ox;
      this.originZ = oz;
      this.clear();
    }
  }

  private clear() {
    for (const m of this.meshes.values()) {
      m.vbuf.destroy();
      m.ibuf.destroy();
    }
    this.meshes.clear();
  }

  destroy() {
    this.clear();
  }

  update(sCam: number, planes: Float32Array) {
    const want = this.road.tunnelsBetween(sCam - BEHIND, sCam + AHEAD);
    const keep = new Set(want.map(t => t.s0));
    for (const [k, m] of this.meshes) {
      if (!keep.has(k)) {
        m.vbuf.destroy();
        m.ibuf.destroy();
        this.meshes.delete(k);
      }
    }
    for (const t of want) {
      if (!this.meshes.has(t.s0)) this.meshes.set(t.s0, this.build(t));
    }
    this.visible = [...this.meshes.values()].filter(m =>
      aabbInFrustum(
        planes,
        m.min[0],
        m.min[1],
        m.min[2],
        m.max[0],
        m.max[1],
        m.max[2],
      ),
    );
  }

  // The bore's cross-section from the -x floor up over the vault to the +x
  // floor (so the faces' normals point into the bore): [d, h, mat].
  private profile(): Array<[number, number, number]> {
    const hw = this.road.halfWidth;
    const bw = this.road.boreHalfWidth;
    const walk = 0.25;
    const p: Array<[number, number, number]> = [];
    const side = (sgn: number) => [
      [sgn * (hw + 0.05), -0.05, M_WALKWAY],
      [sgn * (hw + 0.05), walk, M_WALKWAY],
      [sgn * bw, walk, M_TILES],
      [sgn * bw, TUNNEL_WALL, M_VAULT],
    ];
    p.push(...(side(-1) as Array<[number, number, number]>));
    // Vault: an ellipse from the -x wall over the crown to the +x wall, with
    // a lamp strip on each side.
    const lampA = Math.acos(LAMP_D);
    const angles: Array<[number, number]> = [];
    for (let i = 1; i < 18; ++i) angles.push([(Math.PI * i) / 18, M_VAULT]);
    // (Sorted by falling angle, the segment from a + LAMP_HALF_ARC to
    // a - LAMP_HALF_ARC is the strip.)
    for (const a of [Math.PI - lampA, lampA]) {
      angles.push([a + LAMP_HALF_ARC, M_LAMP], [a - LAMP_HALF_ARC, M_VAULT]);
    }
    angles.sort((a, b) => b[0] - a[0]);
    for (const [a, mat] of angles) {
      p.push([
        bw * Math.cos(a),
        TUNNEL_WALL + (TUNNEL_H - TUNNEL_WALL) * Math.sin(a),
        mat,
      ]);
    }
    p.push(
      ...(side(1).reverse() as Array<[number, number, number]>).map(
        (q, i): [number, number, number] =>
          // Each point's mat applies to the segment that starts there.
          [q[0], q[1], i === 0 ? M_TILES : i === 1 ? M_WALKWAY : q[2]],
      ),
    );
    return p;
  }

  private frame(s: number) {
    const road = this.road;
    const c = road.atS(s);
    const a = road.atS(s - 1),
      b = road.atS(s + 1);
    const T: Vec3 = [b.x - a.x, b.y - a.y, b.z - a.z];
    const tl = Math.hypot(T[0], T[1], T[2]);
    T[0] /= tl;
    T[1] /= tl;
    T[2] /= tl;
    const L: Vec3 = [Math.cos(c.heading), 0, -Math.sin(c.heading)];
    // Up: vertical (the bore stands upright on a grade).
    const U: Vec3 = [0, 1, 0];
    return {c, T, L, U};
  }

  private build(t: Tunnel): TunnelGPU {
    const prof = this.profile();
    const segs = prof.length - 1;
    const verts: number[] = [];
    const idx: number[] = [];
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const ox = this.originX,
      oz = this.originZ;
    const vert = (p: Vec3, n: Vec3, u: number, v: number, mat: number) => {
      const x = p[0] - ox,
        z = p[2] - oz;
      verts.push(x, p[1], z, n[0], n[1], n[2], u, v, mat);
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], p[1]);
      min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], p[1]);
      max[2] = Math.max(max[2], z);
      return verts.length / FLOATS - 1;
    };
    const at = (f: ReturnType<TunnelMesh['frame']>, d: number, h: number) =>
      [f.c.x + f.L[0] * d, f.c.y + h, f.c.z + f.L[2] * d] as Vec3;

    // Lining: rows every ROW m (and exactly at both portals); flat-shaded
    // segments, each with its own pair of columns.
    const bw = this.road.boreHalfWidth;
    const vh = TUNNEL_H - TUNNEL_WALL;
    const n = Math.max(1, Math.ceil((t.s1 - t.s0) / ROW));
    for (let r = 0; r <= n; ++r) {
      const f = this.frame(t.s0 + ((t.s1 - t.s0) * r) / n);
      // uv.y: world z (mod a multiple of the lamp spacing) so the lamp
      // fixtures line up with the lamps' light (tunnelLamps).
      const v = f.c.z % 6144;
      for (let sg = 0; sg < segs; ++sg) {
        const p0 = prof[sg],
          p1 = prof[sg + 1];
        const dd = p1[0] - p0[0],
          dh = p1[1] - p0[1];
        const nl = Math.hypot(dd, dh) || 1;
        const flat = [dh / nl, -dd / nl];
        // The vault is smooth: its points take the ellipse's normal.
        const vault = p0[1] >= TUNNEL_WALL && p1[1] >= TUNNEL_WALL;
        const nrm = (q: [number, number, number]): Vec3 => {
          let n2 = flat;
          if (vault) {
            const ex = q[0] / (bw * bw),
              ey = (q[1] - TUNNEL_WALL) / (vh * vh);
            const el = Math.hypot(ex, ey);
            n2 = [-ex / el, -ey / el];
          }
          return [f.L[0] * n2[0], n2[1], f.L[2] * n2[0]];
        };
        vert(at(f, p0[0], p0[1]), nrm(p0), p0[1], v, p0[2]);
        vert(at(f, p1[0], p1[1]), nrm(p1), p1[1], v, p0[2]);
      }
      if (r > 0) {
        const base = (r - 1) * segs * 2;
        for (let sg = 0; sg < segs; ++sg) {
          const a = base + sg * 2,
            b = a + 1,
            c = a + segs * 2,
            d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
      }
    }

    // Headwalls: a slab around each portal, its face in the portal's plane
    // with the bore's outline cut out of it, reaching HEAD_DEPTH m into the
    // hill.
    const outline: Array<[number, number]> = [
      [-bw, -0.05],
      [-bw, TUNNEL_WALL],
    ];
    for (let i = 1; i < 18; ++i) {
      const a = Math.PI - (Math.PI * i) / 18;
      outline.push([
        bw * Math.cos(a),
        TUNNEL_WALL + (TUNNEL_H - TUNNEL_WALL) * Math.sin(a),
      ]);
    }
    outline.push([bw, TUNNEL_WALL], [bw, -0.05]);
    // Matching points on the slab's outer edge: straight up the sides and
    // across the top.
    const W = bw + HEAD_SIDE,
      H = TUNNEL_H + HEAD_TOP;
    const outer = outline.map(([d, h]): [number, number] => {
      if (h <= TUNNEL_WALL) return [Math.sign(d) * W, h <= 0 ? -0.6 : h];
      // Vault points: spread across the top edge, the outermost ones onto
      // its corners.
      return [(d / (bw * Math.cos(Math.PI / 18))) * W, H];
    });
    for (const [s, dir] of [
      [t.s0, -1],
      [t.s1, 1],
    ]) {
      const f = this.frame(s);
      // Out of the tunnel (dir) and back into the hill (-dir).
      const out: Vec3 = [f.T[0] * dir, 0, f.T[2] * dir];
      const back = (p: Vec3): Vec3 => [
        p[0] - out[0] * HEAD_DEPTH,
        p[1],
        p[2] - out[2] * HEAD_DEPTH,
      ];
      const ring: number[] = [];
      for (let i = 0; i < outline.length; ++i) {
        const [di, hi] = outline[i],
          [dO, hO] = outer[i];
        ring.push(
          vert(at(f, di, hi), out, di, hi, M_HEADWALL),
          vert(at(f, dO, hO), out, dO, hO, M_HEADWALL),
        );
      }
      for (let i = 0; i + 1 < outline.length; ++i) {
        const a = ring[i * 2],
          b = ring[i * 2 + 1],
          c = ring[i * 2 + 2],
          d = ring[i * 2 + 3];
        idx.push(a, b, c, b, d, c);
      }
      // The slab's outer edge (sides and top), back into the hill.
      const edge: Array<[number, number]> = [
        [-W, -0.6],
        [-W, H],
        [W, H],
        [W, -0.6],
      ];
      for (let i = 0; i + 1 < edge.length; ++i) {
        const p0 = at(f, edge[i][0], edge[i][1]),
          p1 = at(f, edge[i + 1][0], edge[i + 1][1]);
        // Outward normal of this edge (left, up, right).
        const nrm: Vec3 =
          i === 0
            ? [-f.L[0], 0, -f.L[2]]
            : i === 1
              ? [0, 1, 0]
              : [f.L[0], 0, f.L[2]];
        const a = vert(p0, nrm, edge[i][0], edge[i][1], M_HEADWALL),
          b = vert(p1, nrm, edge[i + 1][0], edge[i + 1][1], M_HEADWALL),
          c = vert(back(p0), nrm, edge[i][0], edge[i][1], M_HEADWALL),
          d = vert(back(p1), nrm, edge[i + 1][0], edge[i + 1][1], M_HEADWALL);
        idx.push(a, b, c, b, d, c);
      }
    }

    const vdata = new Float32Array(verts);
    const idata = new Uint32Array(idx);
    const d = this.device;
    const vbuf = d.createBuffer({
      label: `tunnel-vertices-${Math.round(t.s0)}`,
      size: vdata.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(vbuf, 0, vdata);
    const ibuf = d.createBuffer({
      label: `tunnel-indices-${Math.round(t.s0)}`,
      size: idata.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(ibuf, 0, idata);
    return {tunnel: t, vbuf, ibuf, indexCount: idx.length, min, max};
  }

  static createPipelines(
    d: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    shadowLayout: GPUBindGroupLayout,
  ) {
    const module = shaderModule(d, RENDER_PRELUDE + '\n' + tunnelSrc, 'tunnel');
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
    deferRenderPipeline(
      d,
      {
        label: 'tunnel',
        layout: d.createPipelineLayout({
          label: 'tunnel-layout',
          bindGroupLayouts: [frameLayout],
        }),
        vertex: {module, entryPoint: 'vs', buffers},
        fragment: {module, entryPoint: 'fs', targets: GBUFFER_TARGETS},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
        },
      },
      p => (TunnelMesh.pipeline = p),
    );
    deferRenderPipeline(
      d,
      {
        label: 'tunnel-shadow',
        layout: d.createPipelineLayout({
          label: 'tunnel-shadow-layout',
          bindGroupLayouts: [
            frameLayout,
            d.createBindGroupLayout({label: 'tunnel-empty', entries: []}),
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
      },
      p => (TunnelMesh.shadowPipeline = p),
    );
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.visible.length) return;
    pass.setPipeline(TunnelMesh.pipeline);
    this.drawList(pass, this.visible);
  }

  // Every built tunnel (for views other than the main camera's).
  drawAll(pass: GPURenderPassEncoder) {
    if (!this.meshes.size) return;
    pass.setPipeline(TunnelMesh.pipeline);
    this.drawList(pass, [...this.meshes.values()]);
  }

  drawShadow(pass: GPURenderPassEncoder, emptyBG: GPUBindGroup) {
    if (!this.meshes.size) return;
    pass.setPipeline(TunnelMesh.shadowPipeline);
    pass.setBindGroup(1, emptyBG);
    this.drawList(pass, [...this.meshes.values()]);
  }

  private drawList(pass: GPURenderPassEncoder, list: TunnelGPU[]) {
    for (const m of list) {
      pass.setVertexBuffer(0, m.vbuf);
      pass.setIndexBuffer(m.ibuf, 'uint32');
      pass.drawIndexed(m.indexCount);
    }
  }
}
