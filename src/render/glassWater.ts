// Water and snow on the player's windows: runs the drop simulation
// (src/sim/glassWater.ts) and splats it each frame into an atlas texture
// (see glass_water.wgsl) that the glass-FX pass samples for refraction,
// rim darkening, highlights and snow cover.
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
import {CarSpec} from '../gen/car';
import {GlassWater, Pane} from '../sim/glassWater';
import waterSrc from '../shaders/glass_water.wgsl';

export const WATER_ATLAS = 2048;
const FORMAT: GPUTextureFormat = 'rgba8unorm';
const MAX_SPLATS = 16000;
const S_FLOATS = 8;

// Panes of a car (glass-plane metres), matching glassCoord() in car.wgsl.
export function carPanes(sp: CarSpec): Pane[] {
  const ws: Pane = {
    uMin: -sp.width / 2,
    uMax: sp.width / 2,
    vMax: Math.hypot(sp.wsBase - sp.roofFront, sp.roofY - sp.belt) + 0.05,
  };
  const side: Pane = {
    uMin: sp.rearBase,
    uMax: sp.wsBase,
    vMax: sp.roofY - sp.belt,
  };
  return [ws, side, {...side}];
}

export class GlassWaterRenderer {
  readonly layout: GPUBindGroupLayout; // for the glass-FX pass (group 3)
  sim: GlassWater | null = null;
  private kind = '';
  private textures: GPUTexture[] = [];
  private fxGroups: GPUBindGroup[] = [];
  private simGroups: GPUBindGroup[] = [];
  private paneBuf: GPUBuffer;
  private splatBuf: GPUBuffer;
  private splats = new Float32Array(MAX_SPLATS * S_FLOATS);
  private splatCount = 0;
  private cur = 0;
  private decayPipe!: GPURenderPipeline;
  private splatPipe!: GPURenderPipeline;
  private simLayout: GPUBindGroupLayout;
  private sampler: GPUSampler;

  constructor(private device: GPUDevice) {
    const d = device;
    this.paneBuf = d.createBuffer({
      label: 'glass-water-panes',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.splatBuf = d.createBuffer({
      label: 'glass-water-splats',
      size: this.splats.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.sampler = d.createSampler({
      label: 'glass-water-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.layout = d.createBindGroupLayout({
      label: 'glass-water-fx-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {sampleType: 'float'},
        },
        {binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {}},
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: {type: 'uniform'},
        },
      ],
    });
    this.simLayout = d.createBindGroupLayout({
      label: 'glass-water-sim-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {type: 'uniform'},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {sampleType: 'float'},
        },
      ],
    });
    const module = shaderModule(d, waterSrc, 'glass-water');
    const pl = d.createPipelineLayout({
      label: 'glass-water-pl',
      bindGroupLayouts: [this.simLayout],
    });
    const max: GPUBlendState = {
      color: {srcFactor: 'one', dstFactor: 'one', operation: 'max'},
      alpha: {srcFactor: 'one', dstFactor: 'one', operation: 'max'},
    };
    deferRenderPipeline(
      d,
      {
        label: 'glass-water-decay',
        layout: pl,
        vertex: {module, entryPoint: 'vsDecay'},
        fragment: {
          module,
          entryPoint: 'fsDecay',
          targets: [{format: FORMAT, blend: max}],
        },
        primitive: {topology: 'triangle-list'},
      },
      p => (this.decayPipe = p),
    );
    deferRenderPipeline(
      d,
      {
        label: 'glass-water-splat',
        layout: pl,
        vertex: {
          module,
          entryPoint: 'vsSplat',
          buffers: [
            {
              arrayStride: S_FLOATS * 4,
              stepMode: 'instance',
              attributes: [
                {shaderLocation: 0, offset: 0, format: 'float32x4'},
                {shaderLocation: 1, offset: 16, format: 'float32x4'},
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fsSplat',
          targets: [{format: FORMAT, blend: max}],
        },
        primitive: {topology: 'triangle-strip'},
      },
      p => (this.splatPipe = p),
    );
  }

  // The bind group for the glass-FX pass (current atlas).
  get fxGroup(): GPUBindGroup | null {
    return this.fxGroups[this.cur] ?? null;
  }

  private ensureTextures() {
    if (this.textures.length) return;
    const d = this.device;
    for (let i = 0; i < 2; ++i)
      this.textures.push(
        d.createTexture({
          label: `glass-water-atlas-${i}`,
          size: [WATER_ATLAS, WATER_ATLAS],
          format: FORMAT,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
    for (let i = 0; i < 2; ++i) {
      this.fxGroups.push(
        d.createBindGroup({
          label: `glass-water-fx-bg-${i}`,
          layout: this.layout,
          entries: [
            {binding: 0, resource: this.textures[i].createView()},
            {binding: 1, resource: this.sampler},
            {binding: 2, resource: {buffer: this.paneBuf}},
          ],
        }),
      );
      // Writing atlas i reads the other one (trail decay).
      this.simGroups.push(
        d.createBindGroup({
          label: `glass-water-sim-bg-${i}`,
          layout: this.simLayout,
          entries: [
            {binding: 0, resource: {buffer: this.paneBuf}},
            {binding: 1, resource: this.textures[1 - i].createView()},
          ],
        }),
      );
    }
  }

  // Advance the simulation (whenever it rains / snows, so the glass is
  // already wet when the camera cuts inside).
  update(
    dt: number,
    t: number,
    speed: number,
    rain: number,
    snow: number,
    wipers: boolean,
    spec: CarSpec,
    visible: boolean,
  ) {
    if (rain <= 0 && snow <= 0) {
      this.sim = null;
      return;
    }
    if (!this.sim || this.kind !== spec.kind) {
      this.kind = spec.kind;
      this.sim = new GlassWater(carPanes(spec), 11);
      // Start with glass that has been out in the weather for a while.
      for (let i = 0; i < 180; ++i)
        this.sim.update(1 / 30, t - 6 + i / 30, speed, rain, snow, wipers);
      const pn = this.sim.panes;
      const f = new Float32Array(16);
      for (let p = 0; p < 3; ++p)
        f.set([pn[p].uMin, pn[p].uMax, pn[p].vMax, 0], p * 4);
      f.set([0.97, 0, 0, 0], 12);
      this.device.queue.writeBuffer(this.paneBuf, 0, f);
    }
    // Off screen it only needs to stay plausible: step at ~15 Hz.
    this.pending += dt;
    if (!visible && this.pending < 1 / 15) return;
    this.sim.update(this.pending, t, speed, rain, snow, wipers);
    this.pending = 0;
  }
  private pending = 0;

  // Splat the current state into the atlas (interior cameras only).
  encode(enc: GPUCommandEncoder) {
    const sim = this.sim;
    if (!sim || !this.decayPipe || !this.splatPipe) return;
    this.ensureTextures();
    let n = 0;
    const out = this.splats;
    for (const dr of sim.drops) {
      if (n >= MAX_SPLATS) break;
      out.set(
        [
          dr.pane,
          dr.snow ? 1 : 0,
          dr.u,
          dr.v,
          dr.du,
          dr.dv,
          dr.r,
          dr.phase % 1,
        ],
        n++ * S_FLOATS,
      );
    }
    for (const tr of sim.trails) {
      if (n >= MAX_SPLATS) break;
      out.set(
        [tr.pane, 2, tr.u0, tr.v0, tr.u1, tr.v1, tr.w, 0],
        n++ * S_FLOATS,
      );
    }
    this.splatCount = n;
    if (n)
      this.device.queue.writeBuffer(this.splatBuf, 0, out, 0, n * S_FLOATS);
    this.cur = 1 - this.cur;
    const pass = enc.beginRenderPass({
      label: 'glass-water-atlas',
      colorAttachments: [
        {
          view: this.textures[this.cur].createView(),
          clearValue: {r: 0, g: 0, b: 0, a: 0},
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setBindGroup(0, this.simGroups[this.cur]);
    pass.setPipeline(this.decayPipe);
    pass.draw(3);
    if (this.splatCount) {
      pass.setPipeline(this.splatPipe);
      pass.setVertexBuffer(0, this.splatBuf);
      pass.draw(4, this.splatCount);
    }
    pass.end();
  }
}
