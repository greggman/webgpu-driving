// Weather and dust particles (see particles.wgsl), plus rolling tumbleweeds
// handled on the CPU as props.
import {shaderModule} from '../gpu/gpu';
import {Biome} from '../world/biome';
import {RENDER_PRELUDE} from './shaders';
import partSrc from '../shaders/particles.wgsl';
import {
  DEPTH_FORMAT,
  HDR_FORMAT,
  NORMAL_FORMAT,
  VELOCITY_FORMAT,
} from './targets';

const HIST = 64;

interface System {
  kind: number;
  count: number;
  volume: number;
  size: number;
  fall: number;
  life: number;
  color: number[];
  ubuf: GPUBuffer;
  bg: GPUBindGroup;
}

export class Particles {
  private pipe: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private hist: GPUBuffer;
  private histData = new Float32Array(HIST * 4);
  private histTimes: number[] = [];
  private systems: System[] = [];
  private lastTime = -1;

  constructor(
    private device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
  ) {
    const d = device;
    this.layout = d.createBindGroupLayout({
      label: 'particles-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {type: 'uniform'},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: {type: 'read-only-storage'},
        },
      ],
    });
    this.hist = d.createBuffer({
      label: 'dust-car-history',
      size: HIST * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const module = shaderModule(
      d,
      RENDER_PRELUDE + '\n' + partSrc,
      'particles',
    );
    const premult: GPUBlendState = {
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
    };
    this.pipe = d.createRenderPipeline({
      label: 'particles',
      layout: d.createPipelineLayout({
        label: 'particles-pl',
        bindGroupLayouts: [frameLayout, this.layout],
      }),
      vertex: {module, entryPoint: 'vs'},
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {format: HDR_FORMAT, blend: premult},
          {format: VELOCITY_FORMAT, writeMask: 0},
          {format: NORMAL_FORMAT, writeMask: 0},
        ],
      },
      primitive: {topology: 'triangle-strip'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: 'greater',
      },
    });
  }

  setWorld(biome: Biome) {
    for (const s of this.systems) s.ubuf.destroy();
    this.systems = [];
    this.histTimes = [];
    const add = (
      kind: number,
      count: number,
      volume: number,
      size: number,
      fall: number,
      life: number,
      color: number[],
    ) => {
      const ubuf = this.device.createBuffer({
        label: `particles-params-${kind}`,
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bg = this.device.createBindGroup({
        label: `particles-bg-${kind}`,
        layout: this.layout,
        entries: [
          {binding: 0, resource: {buffer: ubuf}},
          {binding: 1, resource: {buffer: this.hist}},
        ],
      });
      this.systems.push({
        kind,
        count,
        volume,
        size,
        fall,
        life,
        color,
        ubuf,
        bg,
      });
    };
    if (biome.weather.snow > 0)
      add(0, 260000, 60, 0.03, 1.4, 0, [1.0, 1.0, 1.0, 1.0]);
    if (biome.id === 'forest')
      add(1, 2500, 50, 0.05, 0.8, 0, [0.55, 0.45, 0.12, 1]);
    if (biome.weather.dust > 0 || biome.road.dirt)
      add(2, 900, 0, 0.5, 0, 2.6, [0.62, 0.48, 0.34, 1]);
  }

  // carRear: world position of the player's rear axle (local coords).
  update(time: number, carRear: number[], speed: number, camVel: number[]) {
    // Car history for dust (sampled every ~40 ms, newest first).
    if (this.histTimes.length === 0) {
      for (let i = 0; i < HIST; ++i) {
        this.histData.set(
          [carRear[0], carRear[1] + 0.3, carRear[2], speed],
          i * 4,
        );
      }
    }
    if (time !== this.lastTime) {
      this.lastTime = time;
      const last = this.histTimes[0];
      if (last === undefined || time - last > 2.6 / HIST) {
        this.histTimes.unshift(time);
        this.histData.copyWithin(4, 0, (HIST - 1) * 4);
        this.histData.set([carRear[0], carRear[1] + 0.3, carRear[2], speed], 0);
        if (this.histTimes.length > HIST) this.histTimes.pop();
      }
    }
    this.device.queue.writeBuffer(this.hist, 0, this.histData);
    for (const s of this.systems) {
      const buf = new ArrayBuffer(64);
      const u = new Uint32Array(buf);
      const f = new Float32Array(buf);
      u[0] = s.kind;
      u[1] = s.count;
      f[2] = s.volume;
      f[3] = s.size;
      f[4] = s.fall;
      f[5] = s.life;
      u[6] = HIST;
      f.set([camVel[0], camVel[1], camVel[2], 0], 8);
      f.set(s.color, 12);
      this.device.queue.writeBuffer(s.ubuf, 0, buf);
    }
  }

  // Needs an origin shift when the world rebases (history is local).
  shift(dx: number, dz: number) {
    for (let i = 0; i < HIST; ++i) {
      this.histData[i * 4] -= dx;
      this.histData[i * 4 + 2] -= dz;
    }
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.systems.length) return;
    pass.setPipeline(this.pipe);
    for (const s of this.systems) {
      pass.setBindGroup(1, s.bg);
      pass.draw(4, s.count);
    }
  }
}
