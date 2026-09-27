// Car rendering: one body mesh per archetype, instanced; wheels drawn as 4
// instances per car from a shared wheel mesh.
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
import {
  MESH_KINDS,
  CarKind,
  buildTrailer,
  buildCarBody,
  buildWheel,
  carSpec,
  CarSpec,
  MeshData,
  LOD_RES,
} from '../gen/car';
import {RENDER_PRELUDE} from './shaders';
import {buildInterior, Interior} from '../gen/interior';
import {chinTrimParams, claddingParams} from '../gen/carBody';
import carSrc from '../shaders/car.wgsl';
import {GBUFFER_TARGETS, DEPTH_FORMAT, GLASS_FX_FORMAT} from './targets';

export const CAR_FLOATS = 80; // 2 mat4 + 12 vec4
export const NAV_POINTS = 32;
const NAV_FLOATS = NAV_POINTS * 2 + 4;
const MAX_CARS = 256;

export interface CarDraw {
  kind: CarKind;
  model: Float32Array;
  prevModel: Float32Array;
  color: [number, number, number, number];
  spin: number;
  steer: number;
  brake: number;
  lights: number;
  dirt: number;
  interior?: boolean;
  speed?: number;
  rpm?: number;
  // Per-wheel suspension offsets (m, body up): FR, FL, RR, RL.
  wheelDrop?: [number, number, number, number];
}

// Cars farther than this (m) are drawn with the coarse LOD body.
const LOD_DIST = 35;

interface KindMesh {
  buf: GPUBuffer;
  count: number;
  lodBuf: GPUBuffer; // (the full buffer when there is no LOD)
  lodCount: number;
  spec: CarSpec;
  interior: Interior;
  interiorBuf: GPUBuffer;
}

export class CarRenderer {
  private meshes = new Map<CarKind, KindMesh>();
  private wheel: {buf: GPUBuffer; count: number};
  private instBuf: GPUBuffer;
  private data = new Float32Array(MAX_CARS * CAR_FLOATS);
  private ranges: Array<{
    kind: CarKind;
    lod: boolean;
    first: number;
    count: number;
  }> = [];
  private total = 0;
  private interiorDraw: {kind: CarKind; index: number} | null = null;
  private bg!: GPUBindGroup;
  private bodyPipe!: GPURenderPipeline;
  private wheelPipe!: GPURenderPipeline;
  private bodyShadowPipe!: GPURenderPipeline;
  private wheelShadowPipe!: GPURenderPipeline;
  private glassPipe!: GPURenderPipeline;
  private blobPipe!: GPURenderPipeline;
  private glassFxPipe!: GPURenderPipeline;
  private navBuf: GPUBuffer;
  private emptyLayout: GPUBindGroupLayout;
  private emptyGroup: GPUBindGroup;
  readonly layout: GPUBindGroupLayout;

  constructor(private device: GPUDevice) {
    this.emptyLayout = device.createBindGroupLayout({
      label: 'car-empty-layout',
      entries: [],
    });
    this.emptyGroup = device.createBindGroup({
      label: 'car-empty-bg',
      layout: this.emptyLayout,
      entries: [],
    });
    // Car body / interior meshes are built on first use (mesh()), so start-up
    // only pays for the cars on screen; buildIdle() fills in the rest.
    const w = buildWheel();
    const wbuf = device.createBuffer({
      label: 'car-wheel',
      size: w.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(wbuf, 0, w.vertices);
    this.wheel = {buf: wbuf, count: w.count};
    this.instBuf = device.createBuffer({
      label: 'car-instances',
      size: MAX_CARS * CAR_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.layout = device.createBindGroupLayout({
      label: 'car-instances-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {type: 'read-only-storage'},
        },
        // Navigation screen: the road ahead in the player's car frame.
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: {type: 'uniform'},
        },
      ],
    });
    this.navBuf = device.createBuffer({
      label: 'car-nav-route',
      size: NAV_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bg = device.createBindGroup({
      label: 'car-instances-bg',
      layout: this.layout,
      entries: [
        {binding: 0, resource: {buffer: this.instBuf}},
        {binding: 1, resource: {buffer: this.navBuf}},
      ],
    });
  }

  // Route for the dashboard map: NAV_POINTS (left, forward) points in
  // metres relative to the player's car, plus the car's world position
  // (mod 1000, for the scrolling grid) and forward direction (x, z).
  setNav(route: number[], misc: number[]) {
    const f = new Float32Array(NAV_FLOATS);
    f.set(route.slice(0, NAV_POINTS * 2));
    f.set(misc, NAV_POINTS * 2);
    this.device.queue.writeBuffer(this.navBuf, 0, f);
  }

  spec(kind: CarKind): CarSpec {
    return carSpec(kind);
  }

  // Car meshes are built in a worker (meshWorker.ts) so generating them
  // never stalls the frame loop; a kind is drawn once its mesh arrives.
  // A small pool so several kinds build in parallel.
  private workers: Worker[] = [];
  private nextWorker = 0;
  private workerFailed = false;
  private requested = new Set<CarKind>();
  private waiters = new Map<CarKind, Array<() => void>>();

  private upload(
    kind: CarKind,
    body: MeshData,
    interior: Interior,
    lod: MeshData | null = null,
  ) {
    const device = this.device;
    let lodBuf: GPUBuffer | null = null;
    if (lod && lod.vertices.byteLength) {
      lodBuf = device.createBuffer({
        label: `car-body-lod-${kind}`,
        size: lod.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(lodBuf, 0, lod.vertices);
    }
    const buf = device.createBuffer({
      label: `car-body-${kind}`,
      size: Math.max(body.vertices.byteLength, 32),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (body.vertices.byteLength)
      device.queue.writeBuffer(buf, 0, body.vertices);
    const interiorBuf = device.createBuffer({
      label: `car-interior-${kind}`,
      size: Math.max(interior.vertices.byteLength, 32),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (interior.vertices.byteLength)
      device.queue.writeBuffer(interiorBuf, 0, interior.vertices);
    this.meshes.set(kind, {
      buf,
      count: body.count,
      lodBuf: lodBuf ?? buf,
      lodCount: lodBuf ? lod!.count : body.count,
      spec: carSpec(kind),
      interior,
      interiorBuf,
    });
    for (const w of this.waiters.get(kind) ?? []) w();
    this.waiters.delete(kind);
  }

  // Builds on the main thread (no worker, or it failed).
  private buildNow(kind: CarKind) {
    const spec = carSpec(kind);
    this.upload(
      kind,
      kind === 'trailer' ? buildTrailer() : buildCarBody(spec),
      buildInterior(spec),
      spec.body ? buildCarBody(spec, LOD_RES) : null,
    );
  }

  private getWorker(): Worker | null {
    if (this.workerFailed) return null;
    const n = Math.min(
      4,
      Math.max(1, (navigator.hardwareConcurrency || 2) - 1),
    );
    if (this.workers.length < n) this.spawnWorker();
    if (!this.workers.length) return null;
    return this.workers[this.nextWorker++ % this.workers.length];
  }

  private spawnWorker() {
    try {
      const w = new Worker(new URL('meshWorker.js', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (
        e: MessageEvent<{
          kind: CarKind;
          body: MeshData;
          lod: MeshData | null;
          interior: Interior;
        }>,
      ) => {
        const {kind, body, lod, interior} = e.data;
        if (!this.meshes.has(kind)) this.upload(kind, body, interior, lod);
      };
      w.onerror = e => {
        console.error(`[car-mesh-worker] ${e.message}`);
        // Fall back: build whatever is still missing here.
        this.workerFailed = true;
        for (const x of this.workers) x.terminate();
        this.workers = [];
        for (const k of this.requested)
          if (!this.meshes.has(k)) this.buildNow(k);
      };
      this.workers.push(w);
    } catch (e) {
      console.error(`[car-mesh-worker] ${(e as Error).message}`);
      this.workerFailed = true;
    }
  }

  // Starts building a kind's meshes (once).
  request(kind: CarKind) {
    if (this.meshes.has(kind) || this.requested.has(kind)) return;
    this.requested.add(kind);
    const w = this.getWorker();
    if (w) w.postMessage({kind});
    else this.buildNow(kind);
  }

  // Resolves once all of these kinds have meshes; onProgress(done, total)
  // reports each one as it arrives.
  ready(
    kinds: Iterable<CarKind>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const want = [...new Set(kinds)];
    const total = want.length;
    let done = want.filter(k => this.meshes.has(k)).length;
    onProgress?.(done, total);
    const waits: Array<Promise<void>> = [];
    for (const k of want) {
      if (this.meshes.has(k)) continue;
      waits.push(
        new Promise(res => {
          const l = this.waiters.get(k) ?? [];
          l.push(() => {
            onProgress?.(++done, total);
            res();
          });
          this.waiters.set(k, l);
        }),
      );
      this.request(k);
    }
    return Promise.all(waits).then(() => undefined);
  }

  isReady(kind: CarKind): boolean {
    return this.meshes.has(kind);
  }

  // Queues every kind (traffic can show any of them later).
  buildIdle(): boolean {
    for (const k of MESH_KINDS) this.request(k);
    return false;
  }

  createPipelines(
    frameLayout: GPUBindGroupLayout,
    shadowLayout: GPUBindGroupLayout,
    waterLayout: GPUBindGroupLayout,
  ) {
    const d = this.device;
    const module = shaderModule(d, RENDER_PRELUDE + '\n' + carSrc, 'car');
    const buffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 32,
        attributes: [
          {shaderLocation: 0, offset: 0, format: 'float32x3'},
          {shaderLocation: 1, offset: 12, format: 'float32x3'},
          {shaderLocation: 2, offset: 24, format: 'float32'},
        ],
      },
    ];
    const layout = d.createPipelineLayout({
      label: 'car-layout',
      bindGroupLayouts: [frameLayout, this.layout],
    });
    const shadowPL = d.createPipelineLayout({
      label: 'car-shadow-layout',
      bindGroupLayouts: [frameLayout, this.layout, shadowLayout],
    });
    const main = (
      label: string,
      entry: string,
      assign: (p: GPURenderPipeline) => void,
    ) =>
      deferRenderPipeline(
        d,
        {
          label,
          layout,
          vertex: {module, entryPoint: entry, buffers},
          fragment: {module, entryPoint: 'fs', targets: GBUFFER_TARGETS},
          primitive: {topology: 'triangle-list', cullMode: 'none'},
          depthStencil: {
            format: DEPTH_FORMAT,
            depthWriteEnabled: true,
            depthCompare: 'greater',
          },
        },
        assign,
      );
    const shadow = (
      label: string,
      entry: string,
      assign: (p: GPURenderPipeline) => void,
    ) =>
      deferRenderPipeline(
        d,
        {
          label,
          layout: shadowPL,
          vertex: {module, entryPoint: entry, buffers},
          fragment: {module, entryPoint: 'fsShadow', targets: []},
          primitive: {topology: 'triangle-list', cullMode: 'none'},
          depthStencil: {
            format: DEPTH_FORMAT,
            depthWriteEnabled: true,
            depthCompare: 'greater',
            depthBias: -2,
            depthBiasSlopeScale: -1.5,
          },
        },
        assign,
      );
    const blended = (
      label: string,
      vsEntry: string,
      fsEntry: string,
      vbufs: GPUVertexBufferLayout[],
      assign: (p: GPURenderPipeline) => void,
    ) =>
      deferRenderPipeline(
        d,
        {
          label,
          layout,
          vertex: {module, entryPoint: vsEntry, buffers: vbufs},
          fragment: {
            module,
            entryPoint: fsEntry,
            targets: [
              {
                format: GBUFFER_TARGETS[0].format,
                blend: {
                  color: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                  alpha: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                },
              },
              {format: GBUFFER_TARGETS[1].format, writeMask: 0},
              {format: GBUFFER_TARGETS[2].format, writeMask: 0},
            ],
          },
          primitive: {topology: 'triangle-list', cullMode: 'none'},
          depthStencil: {
            format: DEPTH_FORMAT,
            depthWriteEnabled: false,
            depthCompare: 'greater',
          },
        },
        assign,
      );
    blended(
      'car-glass',
      'vsBody',
      'fsGlass',
      buffers,
      p => (this.glassPipe = p),
    );
    blended(
      'car-contact-shadow',
      'vsBlob',
      'fsBlob',
      [],
      p => (this.blobPipe = p),
    );
    // Rain drops on the player's glass -> glass-FX target (interior views).
    deferRenderPipeline(
      d,
      {
        label: 'car-glass-fx',
        layout: d.createPipelineLayout({
          label: 'car-glass-fx-layout',
          bindGroupLayouts: [
            frameLayout,
            this.layout,
            this.emptyLayout,
            waterLayout,
          ],
        }),
        vertex: {module, entryPoint: 'vsBody', buffers},
        fragment: {
          module,
          entryPoint: 'fsGlassFx',
          targets: [{format: GLASS_FX_FORMAT}],
        },
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: false,
          depthCompare: 'greater',
        },
      },
      p => (this.glassFxPipe = p),
    );
    main('car-body', 'vsBody', p => (this.bodyPipe = p));
    main('car-wheel', 'vsWheel', p => (this.wheelPipe = p));
    shadow('car-body-shadow', 'vsBodyShadow', p => (this.bodyShadowPipe = p));
    shadow(
      'car-wheel-shadow',
      'vsWheelShadow',
      p => (this.wheelShadowPipe = p),
    );
  }

  // eye: camera position (same local frame as the models), for the LOD.
  setCars(list: CarDraw[], eye: number[] = [0, 0, 0]) {
    const far = (c: CarDraw) =>
      !c.interior &&
      Math.hypot(
        c.model[12] - eye[0],
        c.model[13] - eye[1],
        c.model[14] - eye[2],
      ) > LOD_DIST;
    const key = (c: CarDraw) =>
      MESH_KINDS.indexOf(c.kind) * 2 + (far(c) ? 1 : 0);
    const sorted = [...list].sort((a, b) => key(a) - key(b));
    this.ranges = [];
    this.interiorDraw = null;
    let i = 0;
    for (const c of sorted.slice(0, MAX_CARS)) {
      // (Kinds whose meshes are still being built aren't drawn yet.)
      const km0 = this.meshes.get(c.kind);
      if (!km0) {
        this.request(c.kind);
        continue;
      }
      const spec = km0.spec;
      const o = i * CAR_FLOATS;
      this.data.set(c.model, o);
      this.data.set(c.prevModel, o + 16);
      this.data.set(c.color, o + 32);
      this.data.set([spec.wheelbase, spec.track, spec.wheelR, c.spin], o + 36);
      this.data.set([c.steer, c.brake, c.lights, c.dirt], o + 40);
      this.data.set(
        [
          spec.length / 2,
          spec.width / 2,
          spec.top[0][1],
          spec.top[spec.top.length - 1][1],
        ],
        o + 44,
      );
      this.data.set(
        [
          spec.wsBase,
          // B pillar (door shut line); coupes have one long door.
          // (Coupes: the rear shut line of the single door.)
          spec.kind === 'coupe'
            ? (spec.body?.cabin.doorRear ?? spec.wsBase - 0.98)
            : (spec.roofFront + spec.roofBack) / 2,
          spec.rearBase,
          spec.belt,
        ],
        o + 48,
      );
      const km = this.meshes.get(c.kind)!;
      const wheelAngle = -c.steer * 14; // steering ratio
      this.data.set(
        [c.interior ? 1 : 0, c.speed ?? 0, c.rpm ?? 0, wheelAngle],
        o + 52,
      );
      this.data.set(
        [...km.interior.wheelCenter, km.interior.wheelTilt],
        o + 56,
      );
      this.data.set(
        [
          0.37,
          spec.belt - 0.01,
          MESH_KINDS.indexOf(c.kind),
          spec.body?.openings?.length ? 1 : 0,
        ],
        o + 60,
      );
      this.data.set(
        [
          spec.axleShift,
          spec.clearance,
          spec.wheelWidth ?? 1,
          spec.thirdAxle ?? 0,
        ],
        o + 64,
      );
      this.data.set(
        [
          spec.body?.tailgate?.halfWidth ?? 0,
          spec.body?.tailgate?.bottom ?? 0,
          ...chinTrimParams(spec),
        ],
        o + 68,
      );
      this.data.set(claddingParams(spec), o + 72);
      this.data.set(c.wheelDrop ?? [0, 0, 0, 0], o + 76);
      if (c.interior) this.interiorDraw = {kind: c.kind, index: i};
      const lod = far(c);
      const last = this.ranges[this.ranges.length - 1];
      if (last && last.kind === c.kind && last.lod === lod) last.count++;
      else this.ranges.push({kind: c.kind, lod, first: i, count: 1});
      i++;
    }
    this.total = i;
    if (i)
      this.device.queue.writeBuffer(
        this.instBuf,
        0,
        this.data,
        0,
        i * CAR_FLOATS,
      );
  }

  draw(pass: GPURenderPassEncoder) {
    this.drawWith(pass, this.bodyPipe, this.wheelPipe);
  }

  // Transparent glass (tint, reflections; wipers / snow on the windshield
  // for the interior camera), blended over the cabins.
  drawGlass(pass: GPURenderPassEncoder) {
    if (!this.total) return;
    pass.setBindGroup(1, this.bg);
    // Soft contact shadows (ambient occlusion) under each car.
    pass.setPipeline(this.blobPipe);
    pass.draw(6, this.total);
    pass.setPipeline(this.glassPipe);
    for (const r of this.ranges) {
      const m = this.meshes.get(r.kind)!;
      pass.setVertexBuffer(0, r.lod ? m.lodBuf : m.buf);
      pass.draw(r.lod ? m.lodCount : m.count, r.count, 0, r.first);
    }
  }

  // The player's glass into the glass-FX target (see fsGlassFx).
  drawGlassFx(pass: GPURenderPassEncoder, water: GPUBindGroup) {
    if (!this.interiorDraw || !this.glassFxPipe) return;
    const m = this.meshes.get(this.interiorDraw.kind)!;
    pass.setPipeline(this.glassFxPipe);
    pass.setBindGroup(1, this.bg);
    pass.setBindGroup(2, this.emptyGroup);
    pass.setBindGroup(3, water);
    pass.setVertexBuffer(0, m.buf);
    pass.draw(m.count, 1, 0, this.interiorDraw.index);
  }

  drawShadow(pass: GPURenderPassEncoder) {
    this.drawWith(pass, this.bodyShadowPipe, this.wheelShadowPipe);
  }

  private drawWith(
    pass: GPURenderPassEncoder,
    body: GPURenderPipeline,
    wheel: GPURenderPipeline,
  ) {
    if (!this.total) return;
    pass.setBindGroup(1, this.bg);
    pass.setPipeline(body);
    const skipBody = new URLSearchParams(location.search)
      .get('debug')
      ?.includes('nobody');
    for (const r of skipBody ? [] : this.ranges) {
      const m = this.meshes.get(r.kind)!;
      pass.setVertexBuffer(0, r.lod ? m.lodBuf : m.buf);
      pass.draw(r.lod ? m.lodCount : m.count, r.count, 0, r.first);
    }
    pass.setPipeline(wheel);
    pass.setVertexBuffer(0, this.wheel.buf);
    // Up to three axles per vehicle (unused ones collapse in the shader).
    pass.draw(this.wheel.count, this.total * 6, 0, 0);
    // Cabins (seen through the glass); not needed in the shadow maps.
    if (body === this.bodyPipe) {
      pass.setPipeline(body);
      for (const r of this.ranges) {
        // (Distant cabins are hidden behind the tinted glass.)
        if (r.lod) continue;
        const m = this.meshes.get(r.kind)!;
        pass.setVertexBuffer(0, m.interiorBuf);
        pass.draw(m.interior.count, r.count, 0, r.first);
      }
    }
  }
}
