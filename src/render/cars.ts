// Car rendering: one body mesh per archetype, instanced; wheels drawn as 4
// instances per car from a shared wheel mesh.
import {shaderModule} from '../gpu/gpu';
import {
  CAR_KINDS,
  CarKind,
  buildCarBody,
  buildWheel,
  carSpec,
  CarSpec,
} from '../gen/car';
import {RENDER_PRELUDE} from './shaders';
import carSrc from '../shaders/car.wgsl';
import {GBUFFER_TARGETS, DEPTH_FORMAT} from './targets';

export const CAR_FLOATS = 48; // 2 mat4 + 4 vec4
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
}

interface KindMesh {
  buf: GPUBuffer;
  count: number;
  spec: CarSpec;
}

export class CarRenderer {
  private meshes = new Map<CarKind, KindMesh>();
  private wheel: {buf: GPUBuffer; count: number};
  private instBuf: GPUBuffer;
  private data = new Float32Array(MAX_CARS * CAR_FLOATS);
  private ranges: Array<{kind: CarKind; first: number; count: number}> = [];
  private total = 0;
  private bg!: GPUBindGroup;
  private bodyPipe!: GPURenderPipeline;
  private wheelPipe!: GPURenderPipeline;
  private bodyShadowPipe!: GPURenderPipeline;
  private wheelShadowPipe!: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;

  constructor(private device: GPUDevice) {
    for (const kind of CAR_KINDS) {
      const spec = carSpec(kind);
      const m = buildCarBody(spec);
      const buf = device.createBuffer({
        label: `car-body-${kind}`,
        size: m.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, m.vertices);
      this.meshes.set(kind, {buf, count: m.count, spec});
    }
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
      ],
    });
    this.bg = device.createBindGroup({
      label: 'car-instances-bg',
      layout: this.layout,
      entries: [{binding: 0, resource: {buffer: this.instBuf}}],
    });
  }

  spec(kind: CarKind): CarSpec {
    return this.meshes.get(kind)!.spec;
  }

  createPipelines(
    frameLayout: GPUBindGroupLayout,
    shadowLayout: GPUBindGroupLayout,
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
    const main = (label: string, entry: string) =>
      d.createRenderPipeline({
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
      });
    const shadow = (label: string, entry: string) =>
      d.createRenderPipeline({
        label,
        layout: shadowPL,
        vertex: {module, entryPoint: entry, buffers},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
          depthBias: -2,
          depthBiasSlopeScale: -1.5,
        },
      });
    this.bodyPipe = main('car-body', 'vsBody');
    this.wheelPipe = main('car-wheel', 'vsWheel');
    this.bodyShadowPipe = shadow('car-body-shadow', 'vsBodyShadow');
    this.wheelShadowPipe = shadow('car-wheel-shadow', 'vsWheelShadow');
  }

  setCars(list: CarDraw[]) {
    const sorted = [...list].sort(
      (a, b) => CAR_KINDS.indexOf(a.kind) - CAR_KINDS.indexOf(b.kind),
    );
    this.ranges = [];
    let i = 0;
    for (const c of sorted.slice(0, MAX_CARS)) {
      const spec = this.meshes.get(c.kind)!.spec;
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
      const last = this.ranges[this.ranges.length - 1];
      if (last && last.kind === c.kind) last.count++;
      else this.ranges.push({kind: c.kind, first: i, count: 1});
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
    for (const r of this.ranges) {
      const m = this.meshes.get(r.kind)!;
      pass.setVertexBuffer(0, m.buf);
      pass.draw(m.count, r.count, 0, r.first);
    }
    pass.setPipeline(wheel);
    pass.setVertexBuffer(0, this.wheel.buf);
    pass.draw(this.wheel.count, this.total * 4, 0, 0);
  }
}
