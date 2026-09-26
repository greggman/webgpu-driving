// Weather and dust particles (see particles.wgsl), plus rolling tumbleweeds
// handled on the CPU as props.
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
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
const MAX_SRC = 8; // dust sources (cars)
const PLAYER_DUST = 900; // particles reserved for the player's plume

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
  private pipe!: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private hist: GPUBuffer;
  private histData = new Float32Array(MAX_SRC * HIST * 4);
  private sources = 0;
  private systems: System[] = [];

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
      size: MAX_SRC * HIST * 16,
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
    deferRenderPipeline(
      d,
      {
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
      },
      p => (this.pipe = p),
    );
  }

  setWorld(biome: Biome) {
    for (const s of this.systems) s.ubuf.destroy();
    this.systems = [];
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
        size: 96,
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
    const rain = biome.weather.rain ?? 0;
    if (rain > 0)
      add(3, Math.round(200000 * rain), 40, 0.006, 9, 0, [0.75, 0.8, 0.9, 0.7]);
        if (biome.id === 'autumn') {
      add(1, 2500, 45, 0.05, 0.8, 0, [0.62, 0.22, 0.04, 1]);
      add(4, 9000, 160, 0.055, 0, 0, [0.6, 0.22, 0.04, 1]);
    }
    if (biome.id === 'forest')
      add(1, 1800, 45, 0.045, 0.7, 0, [0.3, 0.26, 0.08, 1]);
    if (biome.weather.dust > 0 || biome.road.dirt)
      add(2, PLAYER_DUST + 1800, 0, 0.5, 0, 2.6, [0.62, 0.48, 0.34, 1]);
  }

  // trail(age) gives the (local) position of the player's rear wheels `age`
  // seconds ago, derived from the road so it also works with frozen time.
  // Each source is a car: trail(age) is where its rear wheels were `age`
  // seconds ago (local coordinates). The first source is the player.
  update(
    sources: Array<{trail: (age: number) => number[]; speed: number}>,
    camVel: number[],
    carPos: number[],
    carFwd: number[],
  ) {
    this.sources = Math.min(sources.length, MAX_SRC);
    for (let k = 0; k < this.sources; ++k) {
      const src = sources[k];
      for (let i = 0; i < HIST; ++i) {
        const p = src.trail((i / HIST) * 2.6);
        this.histData.set(
          [p[0], p[1] + 0.3, p[2], src.speed],
          (k * HIST + i) * 4,
        );
      }
    }
    this.device.queue.writeBuffer(this.hist, 0, this.histData);
    for (const s of this.systems) {
      const buf = new ArrayBuffer(96);
      const u = new Uint32Array(buf);
      const f = new Float32Array(buf);
      u[0] = s.kind;
      u[1] = s.count;
      f[2] = s.volume;
      f[3] = s.size;
      f[4] = s.fall;
      f[5] = s.life;
      u[6] = HIST;
      u[7] = this.sources;
      f.set([camVel[0], camVel[1], camVel[2], 0], 8);
      f.set(s.color, 12);
      f.set([carPos[0], carPos[1], carPos[2], 2.9], 16);
      f.set([carFwd[0], carFwd[1], carFwd[2], 1.05], 20);
      this.device.queue.writeBuffer(s.ubuf, 0, buf);
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
