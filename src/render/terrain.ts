// Terrain: height clipmaps (8 levels of 512^2 rgba32float, updated by compute
// as the camera moves) + a CDLOD quadtree of instanced 32x32 grid patches
// with vertex morphing between LODs.
import {shaderModule} from '../gpu/gpu';
import {ts} from '../gpu/profiler';
import {aabbInFrustum} from '../math/mat4';
import {RENDER_PRELUDE, terrainComputePrelude} from './shaders';
import clipSrc from '../shaders/clipmap.wgsl';
import drawSrc from '../shaders/terrain_draw.wgsl';
import {FrameData} from './frameData';
import {GBUFFER_TARGETS, DEPTH_FORMAT} from './targets';

export const CLIP_LEVELS = 8;
export const CLIP_RES = 512;
export const CLIP_TEXEL0 = 0.5;
const LEAF_SIZE = 16;
const LOD_RANGE0 = 48;
const ROOT_LOD = 10;
const MAX_NODES = 4096;
const MAX_DIST = 16000;

export class TerrainRenderer {
  readonly clipTex: GPUTexture;
  private heightTmp: GPUTexture;
  private levelParams: GPUBuffer;
  private heightPipe: GPUComputePipeline;
  private normalPipe: GPUComputePipeline;
  private heightBGs: GPUBindGroup[] = [];
  private normalBGs: GPUBindGroup[] = [];
  private nodeBuf: GPUBuffer;
  private shadowNodeBuf: GPUBuffer;
  private nodeData = new Float32Array(MAX_NODES * 4);
  private shadowNodeData = new Float32Array(MAX_NODES * 4);
  nodeCount = 0;
  shadowNodeCount = 0;
  private indexBuf: GPUBuffer;
  private indexCount: number;
  pipeline!: GPURenderPipeline;
  shadowPipeline!: GPURenderPipeline;
  private nodeBG!: GPUBindGroup;
  private shadowNodeBG!: GPUBindGroup;

  // World-space (f64) min corner of each level; NaN = needs full rebuild.
  private levelMin: Array<[number, number]> = [];
  private dirty = new Set<number>();
  private probePipe: GPUComputePipeline;
  private probeBuf: GPUBuffer;
  private probeRead: GPUBuffer;
  private probeBG: GPUBindGroup;
  private probeBusy = false;
  probeResult: number[] = [];
  minY = -100;
  maxY = 2000;

  constructor(
    private device: GPUDevice,
    private frame: FrameData,
    roadTexView: GPUTextureView,
  ) {
    this.clipTex = device.createTexture({
      label: 'terrain-clipmap',
      size: [CLIP_RES, CLIP_RES, CLIP_LEVELS],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.heightTmp = device.createTexture({
      label: 'terrain-clipmap-height-tmp',
      size: [CLIP_RES, CLIP_RES],
      format: 'rg32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.levelParams = device.createBuffer({
      label: 'terrain-clipmap-level-params',
      size: 256 * CLIP_LEVELS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    for (let l = 0; l < CLIP_LEVELS; ++l) {
      device.queue.writeBuffer(this.levelParams, l * 256, new Uint32Array([l]));
      this.levelMin.push([NaN, NaN]);
    }
    const module = shaderModule(
      device,
      terrainComputePrelude(1) + '\n' + clipSrc,
      'terrain-clipmap-update',
    );
    this.heightPipe = device.createComputePipeline({
      label: 'terrain-clipmap-heights',
      layout: 'auto',
      compute: {module, entryPoint: 'heights'},
    });
    this.normalPipe = device.createComputePipeline({
      label: 'terrain-clipmap-normals',
      layout: 'auto',
      compute: {module, entryPoint: 'normals'},
    });
    for (let l = 0; l < CLIP_LEVELS; ++l) {
      this.heightBGs.push(
        device.createBindGroup({
          label: `terrain-clipmap-heights-bg-${l}`,
          layout: this.heightPipe.getBindGroupLayout(0),
          entries: [
            {binding: 0, resource: {buffer: frame.buffer}},
            {binding: 1, resource: roadTexView},
            {
              binding: 2,
              resource: {buffer: this.levelParams, offset: l * 256, size: 16},
            },
            {binding: 3, resource: this.heightTmp.createView()},
          ],
        }),
      );
      this.normalBGs.push(
        device.createBindGroup({
          label: `terrain-clipmap-normals-bg-${l}`,
          layout: this.normalPipe.getBindGroupLayout(0),
          entries: [
            {binding: 0, resource: {buffer: frame.buffer}},
            {
              binding: 2,
              resource: {buffer: this.levelParams, offset: l * 256, size: 16},
            },
            {binding: 4, resource: this.heightTmp.createView()},
            {
              binding: 5,
              resource: this.clipTex.createView({
                label: `terrain-clipmap-level-${l}`,
                dimension: '2d',
                baseArrayLayer: l,
                arrayLayerCount: 1,
              }),
            },
          ],
        }),
      );
    }

    this.probePipe = device.createComputePipeline({
      label: 'terrain-probe',
      layout: 'auto',
      compute: {module, entryPoint: 'probeHeight'},
    });
    this.probeBuf = device.createBuffer({
      label: 'terrain-probe',
      size: 32,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    });
    this.probeRead = device.createBuffer({
      label: 'terrain-probe-read',
      size: 32,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.probeBG = device.createBindGroup({
      label: 'terrain-probe-bg',
      layout: this.probePipe.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: frame.buffer}},
        {binding: 1, resource: roadTexView},
        {binding: 6, resource: {buffer: this.probeBuf}},
      ],
    });
    this.nodeBuf = device.createBuffer({
      label: 'terrain-nodes',
      size: MAX_NODES * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.shadowNodeBuf = device.createBuffer({
      label: 'terrain-shadow-nodes',
      size: MAX_NODES * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // 33x33 vertices, 32x32 quads.
    const idx = new Uint16Array(32 * 32 * 6);
    let k = 0;
    for (let y = 0; y < 32; ++y) {
      for (let x = 0; x < 32; ++x) {
        const a = y * 33 + x,
          b = a + 1,
          c = a + 33,
          d = c + 1;
        // Alternate diagonals for a more isotropic mesh.
        if ((x + y) & 1) {
          idx.set([a, c, b, b, c, d], k);
        } else {
          idx.set([a, c, d, a, d, b], k);
        }
        k += 6;
      }
    }
    this.indexCount = idx.length;
    this.indexBuf = device.createBuffer({
      label: 'terrain-grid-indices',
      size: idx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuf, 0, idx);
  }

  createPipelines(
    frameLayout: GPUBindGroupLayout,
    shadowLayout: GPUBindGroupLayout,
  ) {
    const d = this.device;
    const nodeLayout = d.createBindGroupLayout({
      label: 'terrain-node-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: {type: 'read-only-storage'},
        },
      ],
    });
    const module = shaderModule(
      d,
      RENDER_PRELUDE + '\n' + drawSrc,
      'terrain-draw',
    );
    this.pipeline = d.createRenderPipeline({
      label: 'terrain',
      layout: d.createPipelineLayout({
        label: 'terrain-layout',
        bindGroupLayouts: [frameLayout, nodeLayout],
      }),
      vertex: {module, entryPoint: 'vs'},
      fragment: {module, entryPoint: 'fs', targets: GBUFFER_TARGETS},
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    });
    this.shadowPipeline = d.createRenderPipeline({
      label: 'terrain-shadow',
      layout: d.createPipelineLayout({
        label: 'terrain-shadow-layout',
        bindGroupLayouts: [frameLayout, nodeLayout, shadowLayout],
      }),
      vertex: {module, entryPoint: 'vsShadow'},
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
        depthBias: -2,
        depthBiasSlopeScale: -2.0,
      },
    });
    this.nodeBG = d.createBindGroup({
      label: 'terrain-node-bg',
      layout: nodeLayout,
      entries: [{binding: 0, resource: {buffer: this.nodeBuf}}],
    });
    this.shadowNodeBG = d.createBindGroup({
      label: 'terrain-shadow-node-bg',
      layout: nodeLayout,
      entries: [{binding: 0, resource: {buffer: this.shadowNodeBuf}}],
    });
  }

  invalidate() {
    for (let l = 0; l < CLIP_LEVELS; ++l) this.levelMin[l] = [NaN, NaN];
  }

  // The coarse levels reach the ends of the road window; refresh them when
  // the window moves so far terrain uses current road data.
  invalidateFar() {
    for (let l = 5; l < CLIP_LEVELS; ++l) this.levelMin[l] = [NaN, NaN];
  }

  // Recenters clipmap levels around the camera (world coords), writes the
  // level rectangles (local coords) into the frame uniforms, and records
  // which levels need recomputation.
  updateClipmap(
    camWX: number,
    camWZ: number,
    originX: number,
    originZ: number,
    maxUpdates = 2,
  ) {
    this.dirty.clear();
    let updates = 0;
    for (let l = 0; l < CLIP_LEVELS; ++l) {
      const texel = CLIP_TEXEL0 * 2 ** l;
      const ext = texel * (CLIP_RES - 1);
      const snap = texel * 8;
      const cur = this.levelMin[l];
      const cx = cur[0] + ext / 2,
        cz = cur[1] + ext / 2;
      const needs =
        Number.isNaN(cur[0]) ||
        Math.abs(camWX - cx) > ext / 8 ||
        Math.abs(camWZ - cz) > ext / 8;
      if (needs && (updates < maxUpdates || Number.isNaN(cur[0]))) {
        cur[0] = Math.round((camWX - ext / 2) / snap) * snap;
        cur[1] = Math.round((camWZ - ext / 2) / snap) * snap;
        this.dirty.add(l);
        updates++;
      }
      this.frame.set(
        'clip',
        [cur[0] - originX, cur[1] - originZ, texel, 1 / texel],
        l * 4,
      );
    }
  }

  get pendingUpdates(): number {
    return this.dirty.size;
  }

  // Debug: evaluate the GPU terrain function at a local xz (async readback).
  probe(enc: GPUCommandEncoder, x: number, z: number) {
    if (this.probeBusy) return;
    this.device.queue.writeBuffer(
      this.probeBuf,
      0,
      new Float32Array([x, z, 0, 0]),
    );
    const pass = enc.beginComputePass({label: 'terrain-probe'});
    pass.setPipeline(this.probePipe);
    pass.setBindGroup(0, this.probeBG);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(this.probeBuf, 0, this.probeRead, 0, 32);
    this.probeBusy = true;
  }

  afterSubmit() {
    if (!this.probeBusy || this.probeRead.mapState !== 'unmapped') return;
    void this.probeRead.mapAsync(GPUMapMode.READ).then(() => {
      const a = new Float32Array(this.probeRead.getMappedRange().slice(0));
      this.probeResult = [...a.slice(4, 8)];
      this.probeRead.unmap();
      this.probeBusy = false;
    });
  }

  encodeClipmapUpdates(enc: GPUCommandEncoder) {
    if (!this.dirty.size) return;
    const pass = enc.beginComputePass({
      label: 'terrain-clipmap-update',
      timestampWrites: ts('clipmap'),
    });
    const wg = CLIP_RES / 8;
    for (const l of this.dirty) {
      pass.setPipeline(this.heightPipe);
      pass.setBindGroup(0, this.heightBGs[l]);
      pass.dispatchWorkgroups(wg, wg);
      pass.setPipeline(this.normalPipe);
      pass.setBindGroup(0, this.normalBGs[l]);
      pass.dispatchWorkgroups(wg, wg);
    }
    pass.end();
  }

  // CDLOD quadtree selection around the camera (local coords).
  select(camLocal: [number, number, number], planes: Float32Array | null) {
    const ranges: number[] = [];
    for (let i = 0; i <= ROOT_LOD; ++i) ranges.push(LOD_RANGE0 * 2 ** i);
    const out = planes ? this.nodeData : this.shadowNodeData;
    let count = 0;
    const [cx, cy, cz] = camLocal;
    const minY = this.minY,
      maxY = this.maxY;
    const maxDist = planes ? MAX_DIST : 900;
    const distTo = (x: number, z: number, size: number) => {
      const dx = Math.max(x - cx, 0, cx - (x + size));
      const dz = Math.max(z - cz, 0, cz - (z + size));
      const dy = Math.max(minY - cy, 0, cy - maxY);
      return Math.hypot(dx, dy, dz);
    };
    const add = (x: number, z: number, size: number, lod: number) => {
      if (count >= MAX_NODES) return;
      out.set([x, z, size, lod], count * 4);
      count++;
    };
    const visit = (
      x: number,
      z: number,
      size: number,
      lod: number,
    ): boolean => {
      const dist = distTo(x, z, size);
      if (dist > ranges[lod]) return false;
      if (dist > maxDist) return true;
      if (
        planes &&
        !aabbInFrustum(planes, x, minY, z, x + size, maxY, z + size)
      ) {
        return true;
      }
      if (lod === 0) {
        add(x, z, size, 0);
        return true;
      }
      if (dist > ranges[lod - 1]) {
        add(x, z, size, lod);
        return true;
      }
      const h = size / 2;
      for (const [ox, oz] of [
        [0, 0],
        [h, 0],
        [0, h],
        [h, h],
      ]) {
        if (!visit(x + ox, z + oz, h, lod - 1)) {
          // Child is beyond the finer range: draw it as a (fully morphed)
          // finer node so it matches its neighbors exactly.
          if (
            distTo(x + ox, z + oz, h) <= maxDist &&
            (!planes ||
              aabbInFrustum(
                planes,
                x + ox,
                minY,
                z + oz,
                x + ox + h,
                maxY,
                z + oz + h,
              ))
          ) {
            add(x + ox, z + oz, h, lod - 1);
          }
        }
      }
      return true;
    };
    const rootSize = LEAF_SIZE * 2 ** ROOT_LOD;
    const r0x = Math.floor(cx / rootSize) * rootSize;
    const r0z = Math.floor(cz / rootSize) * rootSize;
    for (let j = -1; j <= 1; ++j) {
      for (let i = -1; i <= 1; ++i) {
        visit(r0x + i * rootSize, r0z + j * rootSize, rootSize, ROOT_LOD);
      }
    }
    if (planes) {
      this.nodeCount = count;
      this.device.queue.writeBuffer(this.nodeBuf, 0, out, 0, count * 4);
    } else {
      this.shadowNodeCount = count;
      this.device.queue.writeBuffer(this.shadowNodeBuf, 0, out, 0, count * 4);
    }
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.nodeCount) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.nodeBG);
    pass.setIndexBuffer(this.indexBuf, 'uint16');
    pass.drawIndexed(this.indexCount, this.nodeCount);
  }

  drawShadow(pass: GPURenderPassEncoder) {
    if (!this.shadowNodeCount) return;
    pass.setPipeline(this.shadowPipeline);
    pass.setBindGroup(1, this.shadowNodeBG);
    pass.setIndexBuffer(this.indexBuf, 'uint16');
    pass.drawIndexed(this.indexCount, this.shadowNodeCount);
  }
}
