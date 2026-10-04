// Frame orchestration: uniforms, streaming (origin rebasing, road texture,
// clipmaps, road chunks), shadow cascades, the main G-buffer pass and post.
import {Gpu} from '../gpu/gpu';
import {Profiler, setProfiler, ts} from '../gpu/profiler';
import {
  frustumPlanes,
  invert,
  lookAt,
  multiply,
  perspectiveReverseZInfinite,
  fromBasis,
} from '../math/mat4';
import {Vec3} from '../math/vec3';
import {Biome, packTerrain} from '../world/biome';
import {
  Road,
  ROAD_DZ,
  ROAD_TEX_BEHIND,
  ROAD_TEX_SAMPLES,
  TUNNEL_H,
} from '../world/road';
import {SkyState} from '../world/sky';
import {Atmosphere} from './atmosphere';
import {CarDraw, CarRenderer, MIRROR_H, MIRROR_W, NAV_POINTS} from './cars';
import {FRAME_LAYOUT_ENTRIES, FrameData} from './frameData';
import {Post} from './post';
import {RoadMesh} from './roadMesh';
import {TunnelMesh} from './tunnelMesh';
import {CASCADE_SPLITS, CASCADES, Shadows} from './shadows';
import {Targets} from './targets';
import {TerrainRenderer} from './terrain';
import {CameraState} from '../camera/director';
import {Pose} from '../sim/pose';
import {Vegetation} from './vegetation';
import {Props} from './props';
import {Water} from './water';
import {Particles} from './particles';
import {TireTracks} from './tracks';
import {GlassWaterRenderer} from './glassWater';
import volSrc from '../shaders/volumetric.wgsl';
import clusterSrc from '../shaders/clusters.wgsl';
import envSrc from '../shaders/envmap.wgsl';
import {deferComputePipeline} from '../gpu/pipelines';
import hzbSrc from '../shaders/hzb.wgsl';
import {FRAME_PRELUDE, RENDER_PRELUDE} from './shaders';
import {shaderModule} from '../gpu/gpu';

const REBASE = 1024;
const DUST_SLOTS = 8; // player + 7 nearest cars (see Particles)

// User-adjustable graphics settings (see src/ui/settings.ts).
export interface GraphicsSettings {
  dof: boolean;
  motionBlur: boolean;
  volumetrics: boolean;
  ssao: boolean;
  grass: boolean;
  bloom: boolean;
  filmGrain: boolean;
  letterbox: boolean;
  renderScale: number; // 0.5 .. 1
  native: boolean; // render at device pixels (else CSS pixels)
  lowPower: boolean; // phones: DPR 1, sparser grass, shorter vegetation ranges
  // Leaf-accurate tree shadows beyond the nearest cascade (dappled light
  // under trees); off: those cascades draw leaf cards solid (much cheaper).
  leafShadows: boolean;
}

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  dof: true,
  motionBlur: true,
  volumetrics: true,
  ssao: true,
  grass: true,
  bloom: true,
  filmGrain: true,
  letterbox: false,
  renderScale: 1,
  native: false,
  lowPower: false,
  leafShadows: true,
};

// Preset applied when low-power mode is chosen (and by default on phones).
export const LOW_POWER_GRAPHICS: GraphicsSettings = {
  ...DEFAULT_GRAPHICS,
  volumetrics: false,
  ssao: false,
  renderScale: 0.8,
  lowPower: true,
  leafShadows: false,
};

export function isMobileDevice(): boolean {
  try {
    return (
      matchMedia('(pointer: coarse)').matches &&
      Math.min(screen.width, screen.height) < 900
    );
  } catch {
    return false;
  }
}
// `debug` URL flags, re-read when the URL changes (test/ab.js switches them
// in a running page).
let debugSearch: string | null = null;
let debugFlags = new Set<string>();
export const DEBUG = {
  has(flag: string): boolean {
    if (location.search !== debugSearch) {
      debugSearch = location.search;
      debugFlags = new Set(
        (new URLSearchParams(debugSearch).get('debug') ?? '').split(','),
      );
    }
    return debugFlags.has(flag);
  },
};
const MAX_LIGHTS = 64;
// Intensity of each tunnel lamp (tunnelLamps in lighting.wgsl).
const TUNNEL_LAMP = 3;
const ENV_SIZE = 256;
const ENV_MIPS = 8;
// Volumetric fog per environment: density (1/m), anisotropy, height falloff.
const VOLUME: Record<string, [number, number, number]> = {
  country: [0.0005, 0.65, 40],
  desert: [0.0003, 0.7, 60],
  coast: [0.00025, 0.6, 40], // (clear coastal air: a saturated sea)
  bigsur: [0.00025, 0.6, 60],
  // (None: even a faint haze washed the forest out, and the volume march
  // still cost ~1.5 ms.)
  forest: [0, 0.72, 35],
  snow: [0, 0.5, 50],
  lahonda: [0.0025, 0.65, 45],
  night: [0.0022, 0.5, 30],
};

export interface WorldCar {
  draw: Omit<CarDraw, 'model' | 'prevModel'>;
  pose: Pose;
  prevPose: Pose | null;
  player: boolean;
  // Road coordinates (dust trails, tyre tracks).
  id: number;
  s: number;
  d: number;
  dir: number; // +1 with increasing s
  length: number;
  track: number;
  speed: number;
}

export interface SceneState {
  camera: CameraState;
  prevCamera: CameraState | null;
  sky: SkyState;
  time: number;
  dt: number;
  cars: WorldCar[];
  playerS: number;
  playerD: number;
  player: Pose;
  headlights: number; // local light level (0 = off, 1 = night strength)
  frozen: boolean;
}

// Halton(2,3) jitter sequence.
function halton(i: number, b: number): number {
  let f = 1,
    r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

export class Renderer {
  readonly frame: FrameData;
  private mirrorFrame!: FrameData;
  private mirrorFrameBG!: GPUBindGroup;
  // This frame's rear-view mirror camera (null: not rendered).
  private mirrorVP: Float32Array | null = null;
  private mirrorCam: {
    vp: Float32Array;
    view: Float32Array;
    eye: number[];
    right: number[];
    up: number[];
  } | null = null;
  readonly targets: Targets;
  readonly atmosphere: Atmosphere;
  readonly terrain: TerrainRenderer;
  readonly cars: CarRenderer;
  readonly shadows: Shadows;
  readonly post: Post;
  readonly vegetation: Vegetation;
  readonly props: Props;
  // Ocean and tyre tracks exist only once a biome needs them (setWorld).
  water: Water | null = null;
  readonly particles: Particles;
  tracks: TireTracks | null = null;
  private glassFxOn = false;
  readonly glassWater: GlassWaterRenderer;
  private dustSlots = new Map<number, {index: number; fade: number}>();
  roadMesh: RoadMesh | null = null;
  tunnelMesh: TunnelMesh | null = null;
  private road: Road | null = null;
  private biome: Biome | null = null;
  readonly frameLayout: GPUBindGroupLayout;
  private roadTex: GPUTexture;
  private roadTexData = new Float32Array(ROAD_TEX_SAMPLES * 4);
  private roadBase = -1e9;
  private frameBG!: GPUBindGroup;
  private shadowFrameBG!: GPUBindGroup;
  private lightsBuf: GPUBuffer;
  private lightsData = new Float32Array(MAX_LIGHTS * 12);
  private emptyBG: GPUBindGroup;
  private volTex: GPUTexture;
  private volPipe: GPUComputePipeline;
  private volBG!: GPUBindGroup;
  private clusterBuf: GPUBuffer;
  readonly envTex: GPUTexture;
  private envFrameBG!: GPUBindGroup;
  private envBGs: GPUBindGroup[] = [];
  private envOutLayout: GPUBindGroupLayout;
  private envDownLayout: GPUBindGroupLayout;
  private envBuild!: GPUComputePipeline;
  private envDown!: GPUComputePipeline;
  private clusterPipe: GPUComputePipeline;
  private clusterBG!: GPUBindGroup;
  private hzb: GPUTexture | null = null;
  private hzbFromDepth: GPUComputePipeline;
  private hzbDown: GPUComputePipeline;
  private hzbBGs: GPUBindGroup[] = [];
  private hzbTargetsVersion = -1;
  private lastShot = '';
  originX = 0;
  originZ = 0;
  frameIndex = 0;
  private prevViewProj = new Float32Array(16);
  exposureBias = 1;
  private volumeOn = false;
  graphics: GraphicsSettings = {...DEFAULT_GRAPHICS};
  // Exact render size in device pixels (?size=WxH), else from the
  // canvas's displayed size.
  fixedSize: [number, number] | null = null;
  stats = {terrainNodes: 0, roadChunks: 0, cars: 0};
  private camVelSmooth = [0, 0, 0];
  readonly profiler: Profiler;

  constructor(private gpu: Gpu) {
    const d = gpu.device;
    this.frame = new FrameData(d);
    this.profiler = new Profiler(d, gpu.hasTimestamps);
    setProfiler(this.profiler);
    this.targets = new Targets(d);
    this.frameLayout = d.createBindGroupLayout({
      label: 'frame-layout',
      entries: FRAME_LAYOUT_ENTRIES,
    });
    this.roadTex = d.createTexture({
      label: 'road-samples',
      size: [ROAD_TEX_SAMPLES, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.atmosphere = new Atmosphere(d, this.frame);
    this.volTex = d.createTexture({
      label: 'volumetric-fog-froxels',
      size: [160, 90, 64],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.envTex = d.createTexture({
      label: 'environment-map',
      size: [ENV_SIZE, ENV_SIZE],
      mipLevelCount: ENV_MIPS,
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.envOutLayout = d.createBindGroupLayout({
      label: 'env-out-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {format: 'rgba16float', access: 'write-only'},
        },
      ],
    });
    this.envDownLayout = d.createBindGroupLayout({
      label: 'env-down-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {format: 'rgba16float', access: 'write-only'},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: {sampleType: 'unfilterable-float'},
        },
      ],
    });
    {
      const envMod = shaderModule(
        d,
        RENDER_PRELUDE + '\n' + envSrc,
        'environment-map',
      );
      deferComputePipeline(
        d,
        {
          label: 'env-build',
          layout: d.createPipelineLayout({
            label: 'env-build-pl',
            bindGroupLayouts: [this.frameLayout, this.envOutLayout],
          }),
          compute: {module: envMod, entryPoint: 'build'},
        },
        p => (this.envBuild = p),
      );
      deferComputePipeline(
        d,
        {
          label: 'env-downsample',
          layout: d.createPipelineLayout({
            label: 'env-down-pl',
            bindGroupLayouts: [
              d.createBindGroupLayout({label: 'env-empty', entries: []}),
              this.envDownLayout,
            ],
          }),
          compute: {module: envMod, entryPoint: 'downsample'},
        },
        p => (this.envDown = p),
      );
    }
    this.clusterBuf = d.createBuffer({
      label: 'light-clusters',
      size: 16 * 9 * 24 * 32 * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    this.clusterPipe = d.createComputePipeline({
      label: 'light-cluster-build',
      layout: 'auto',
      compute: {
        module: shaderModule(
          d,
          FRAME_PRELUDE + '\n' + clusterSrc,
          'light-clusters',
        ),
        entryPoint: 'build',
      },
    });
    const hzbMod = shaderModule(d, hzbSrc, 'hzb');
    this.hzbFromDepth = d.createComputePipeline({
      label: 'hzb-from-depth',
      layout: 'auto',
      compute: {module: hzbMod, entryPoint: 'fromDepth'},
    });
    this.hzbDown = d.createComputePipeline({
      label: 'hzb-downsample',
      layout: 'auto',
      compute: {module: hzbMod, entryPoint: 'downsample'},
    });
    this.volPipe = d.createComputePipeline({
      label: 'volumetric-fog',
      layout: 'auto',
      compute: {
        module: shaderModule(
          d,
          FRAME_PRELUDE + '\n' + volSrc,
          'volumetric-fog',
        ),
        entryPoint: 'main',
      },
    });
    this.terrain = new TerrainRenderer(
      d,
      this.frame,
      this.roadTex.createView(),
    );
    this.cars = new CarRenderer(d);
    this.shadows = new Shadows(d);
    this.post = new Post(d, this.frame, this.targets, gpu.format);
    this.lightsBuf = d.createBuffer({
      label: 'local-lights',
      size: MAX_LIGHTS * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const emptyLayout = d.createBindGroupLayout({
      label: 'empty-layout',
      entries: [],
    });
    this.emptyBG = d.createBindGroup({
      label: 'empty-bg',
      layout: emptyLayout,
      entries: [],
    });

    this.atmosphere.createSkyPipeline(
      d.createPipelineLayout({
        label: 'sky-layout',
        bindGroupLayouts: [this.frameLayout],
      }),
    );
    this.terrain.createPipelines(this.frameLayout, this.shadows.layout);
    RoadMesh.createPipelines(d, this.frameLayout, this.shadows.layout);
    TunnelMesh.createPipelines(d, this.frameLayout, this.shadows.layout);
    this.glassWater = new GlassWaterRenderer(d);
    this.cars.createPipelines(
      this.frameLayout,
      this.shadows.layout,
      this.glassWater.layout,
    );
    this.vegetation = new Vegetation(
      d,
      this.frame,
      this.frameLayout,
      this.shadows.layout,
    );
    this.ensureHzb(1, 1);
    this.props = new Props(d, this.frameLayout, this.shadows.layout);

    this.particles = new Particles(d, this.frameLayout);

    this.createFrameBindGroups();
  }

  private createFrameBindGroups() {
    const d = this.gpu.device;
    const lin = d.createSampler({
      label: 'linear-clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    const rep = d.createSampler({
      label: 'linear-repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 8,
    });
    const cmp = d.createSampler({
      label: 'shadow-compare',
      compare: 'greater',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const dummyShadow = d.createTexture({
      label: 'dummy-shadow',
      size: [1, 1, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const entries = (
      shadowView: GPUTextureView,
      envView: GPUTextureView = this.envTex.createView(),
    ): GPUBindGroupEntry[] => [
      {binding: 0, resource: {buffer: this.frame.buffer}},
      {binding: 1, resource: this.roadTex.createView()},
      {
        binding: 2,
        resource: this.terrain.clipTex.createView({dimension: '2d-array'}),
      },
      {binding: 3, resource: this.atmosphere.transLUT.createView()},
      {binding: 4, resource: this.atmosphere.skyLUT.createView()},
      {binding: 5, resource: this.atmosphere.apLUT.createView()},
      {binding: 6, resource: lin},
      {binding: 7, resource: shadowView},
      {binding: 8, resource: cmp},
      {binding: 9, resource: rep},
      {binding: 10, resource: {buffer: this.lightsBuf}},
      {binding: 11, resource: this.vegetation.materialView},
      {binding: 12, resource: this.atmosphere.cloudTex.createView()},
      {binding: 13, resource: this.volTex.createView()},
      {binding: 14, resource: {buffer: this.clusterBuf}},
      {binding: 15, resource: envView},
    ];
    this.frameBG = d.createBindGroup({
      label: 'frame-bg',
      layout: this.frameLayout,
      entries: entries(this.shadows.map.createView({dimension: '2d-array'})),
    });
    // The rear-view mirror pass: the same bindings with its own camera.
    this.mirrorFrame = new FrameData(d);
    this.mirrorFrameBG = d.createBindGroup({
      label: 'mirror-frame-bg',
      layout: this.frameLayout,
      entries: entries(
        this.shadows.map.createView({dimension: '2d-array'}),
      ).map(e =>
        e.binding === 0
          ? {binding: 0, resource: {buffer: this.mirrorFrame.buffer}}
          : e,
      ),
    });
    this.clusterBG = d.createBindGroup({
      label: 'light-cluster-bg',
      layout: this.clusterPipe.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: this.frame.buffer}},
        {binding: 10, resource: {buffer: this.lightsBuf}},
        {binding: 14, resource: {buffer: this.clusterBuf}},
      ],
    });
    this.volBG = d.createBindGroup({
      label: 'volumetric-fog-bg',
      layout: this.volPipe.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: this.frame.buffer}},
        {
          binding: 7,
          resource: this.shadows.map.createView({dimension: '2d-array'}),
        },
        {binding: 8, resource: cmp},
        {binding: 10, resource: {buffer: this.lightsBuf}},
        {binding: 13, resource: this.volTex.createView()},
      ],
    });
    // Environment-map pass: same frame resources, but with a dummy at the
    // env slot (the pass writes the real one).
    const dummyEnv = d.createTexture({
      label: 'dummy-env',
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.envFrameBG = d.createBindGroup({
      label: 'frame-bg-envpass',
      layout: this.frameLayout,
      entries: entries(
        this.shadows.map.createView({dimension: '2d-array'}),
        dummyEnv.createView(),
      ),
    });
    const mipView = (m: number) =>
      this.envTex.createView({
        label: `env-mip-${m}`,
        baseMipLevel: m,
        mipLevelCount: 1,
      });
    this.envBGs = [];
    for (let m = 0; m < ENV_MIPS; ++m) {
      this.envBGs.push(
        d.createBindGroup({
          label: `env-bg-${m}`,
          layout: m === 0 ? this.envOutLayout : this.envDownLayout,
          entries:
            m === 0
              ? [{binding: 0, resource: mipView(0)}]
              : [
                  {binding: 0, resource: mipView(m)},
                  {binding: 1, resource: mipView(m - 1)},
                ],
        }),
      );
    }
    this.shadowFrameBG = d.createBindGroup({
      label: 'frame-bg-shadowpass',
      layout: this.frameLayout,
      entries: entries(dummyShadow.createView({dimension: '2d-array'})),
    });
  }

  // (Re)creates the Hi-Z pyramid at half the render resolution.
  private ensureHzb(w: number, h: number) {
    const d = this.gpu.device;
    const hw = Math.max(1, w >> 1),
      hh = Math.max(1, h >> 1);
    if (this.hzb && this.hzb.width === hw && this.hzb.height === hh) return;
    this.hzb?.destroy();
    const mips = Math.floor(Math.log2(Math.max(hw, hh))) + 1;
    this.hzb = d.createTexture({
      label: 'hi-z-pyramid',
      size: [hw, hh],
      mipLevelCount: mips,
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const mipView = (m: number) =>
      this.hzb!.createView({
        label: `hi-z-mip-${m}`,
        baseMipLevel: m,
        mipLevelCount: 1,
      });
    this.hzbBGs = [];
    for (let m = 0; m < mips; ++m) {
      if (m === 0) {
        this.hzbBGs.push(
          d.createBindGroup({
            label: 'hi-z-from-depth-bg',
            layout: this.hzbFromDepth.getBindGroupLayout(0),
            entries: [
              {
                binding: 0,
                resource:
                  this.targets.depth?.createView() ?? this.dummyDepthView(),
              },
              {binding: 1, resource: mipView(0)},
            ],
          }),
        );
      } else {
        this.hzbBGs.push(
          d.createBindGroup({
            label: `hi-z-down-bg-${m}`,
            layout: this.hzbDown.getBindGroupLayout(0),
            entries: [
              {binding: 1, resource: mipView(m)},
              {binding: 2, resource: mipView(m - 1)},
            ],
          }),
        );
      }
    }
    this.hzbTargetsVersion = this.targets.version;
    this.vegetation.hzbView = this.hzb.createView({label: 'hi-z-all-mips'});
    this.vegetation.hzbCurrentVersion++;
  }

  private dummyDepthView(): GPUTextureView {
    return this.gpu.device
      .createTexture({
        label: 'dummy-depth',
        size: [1, 1],
        format: 'depth32float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      .createView();
  }

  private encodeEnvMap(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({
      label: 'environment-map',
      timestampWrites: ts('envmap'),
    });
    pass.setPipeline(this.envBuild);
    pass.setBindGroup(0, this.envFrameBG);
    pass.setBindGroup(1, this.envBGs[0]);
    pass.dispatchWorkgroups(ENV_SIZE / 8, ENV_SIZE / 8);
    pass.setPipeline(this.envDown);
    for (let m = 1; m < ENV_MIPS; ++m) {
      const sz = Math.max(1, ENV_SIZE >> m);
      pass.setBindGroup(1, this.envBGs[m]);
      pass.dispatchWorkgroups(Math.ceil(sz / 8), Math.ceil(sz / 8));
    }
    pass.end();
  }

  private encodeHzb(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({
      label: 'hi-z-build',
      timestampWrites: ts('hi-z'),
    });
    let w = this.hzb!.width,
      h = this.hzb!.height;
    for (let m = 0; m < this.hzbBGs.length; ++m) {
      pass.setPipeline(m === 0 ? this.hzbFromDepth : this.hzbDown);
      pass.setBindGroup(0, this.hzbBGs[m]);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    pass.end();
  }

  setWorld(road: Road, biome: Biome) {
    this.worldFrame = this.frameIndex;
    this.road = road;
    this.biome = biome;
    this.roadMesh = new RoadMesh(this.gpu.device, road);
    this.tunnelMesh?.destroy();
    this.tunnelMesh = new TunnelMesh(this.gpu.device, road);
    this.terrain.invalidate();
    this.roadBase = -1e9;
    this.post.resetHistory = true;
    this.post.resetExposure = true;
    const t = biome.terrain;
    this.terrain.minY = Math.min(
      t.seaFloor - 10,
      t.baseHeight - t.hillAmp * 1.5 - t.canyonDepth - 60,
    );
    this.terrain.maxY =
      t.baseHeight +
      t.hillAmp * 1.5 +
      t.mountAmp * 1.3 +
      t.macroAmp +
      t.valleyDepth +
      80;
    this.vegetation.setWorld(biome, road);
    this.props.setWorld(biome, road);
    if (biome.ocean && !this.water)
      this.water = new Water(this.gpu.device, this.frameLayout);
    if (this.water) this.water.enabled = biome.ocean;
    if (biome.ocean) this.water!.setWind(biome.weather.wind);
    this.particles.setWorld(biome);
    if (biome.road.dirt && !this.tracks)
      this.tracks = new TireTracks(this.gpu.device, this.frameLayout);
    if (this.tracks) {
      this.tracks.enabled = biome.road.dirt;
      this.tracks.reset();
    }
  }

  private rebase(camX: number, camZ: number) {
    const nx = Math.round(camX / REBASE) * REBASE;
    const nz = Math.round(camZ / REBASE) * REBASE;
    if (
      Math.abs(camX - this.originX) > REBASE ||
      Math.abs(camZ - this.originZ) > REBASE ||
      this.frameIndex === 0
    ) {
      if (nx !== this.originX || nz !== this.originZ) {
        this.originX = nx;
        this.originZ = nz;
        this.roadBase = -1e9; // force road texture re-upload
        this.post.resetHistory = true;
      }
    }
  }

  private updateRoadTexture(camZ: number) {
    const road = this.road!;
    const i0 = Math.floor(camZ / ROAD_DZ) - ROAD_TEX_BEHIND;
    if (Math.abs(i0 - this.roadBase) > 1024) {
      this.roadBase = i0;
      road.fillTexture(this.roadTexData, i0, this.originX);
      this.gpu.device.queue.writeTexture(
        {texture: this.roadTex},
        this.roadTexData,
        {bytesPerRow: ROAD_TEX_SAMPLES * 16},
        [ROAD_TEX_SAMPLES, 1],
      );
      // Clipmap heights depend on the road window; far levels may need
      // refreshing as the window moves.
      this.terrain.invalidateFar();
    }
    this.frame.set('road', [
      this.roadBase * ROAD_DZ - this.originZ,
      ROAD_DZ,
      ROAD_TEX_SAMPLES,
      road.halfWidth,
    ]);
  }

  // Tunnels near the camera for the shaders (see nearTunnel in
  // terrain.wgsl), and how much of the sky the camera sees from inside one
  // (dims the haze in front of everything; see finishColor).
  private updateTunnels(sCam: number, eye: number[], oz: number) {
    const road = this.road!;
    const list = road
      .tunnelsBetween(sCam - 1500, sCam + 4000)
      .map(t => ({t, dist: Math.max(t.s0 - sCam, sCam - t.s1, 0)}))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4);
    const data = new Float32Array(16);
    list.forEach(({t}, i) => {
      let top = -Infinity;
      for (let s = t.s0; s <= t.s1 + 20; s += 20)
        top = Math.max(top, road.atS(Math.min(s, t.s1)).y);
      data.set(
        [road.atS(t.s0).z - oz, road.atS(t.s1).z - oz, top + TUNNEL_H + 1, 0],
        i * 4,
      );
    });
    this.frame.set('tunnels', data);
    this.terrain.setBores(
      list.map((_, i) => {
        const z0 = data[i * 4],
          z1 = data[i * 4 + 1];
        return [Math.min(z0, z1), Math.max(z0, z1)];
      }),
    );
    this.frame.set('tunnel', [
      list.length,
      road.skyVisibility(eye[0], eye[1], eye[2]),
      TUNNEL_LAMP,
      0,
    ]);
  }

  private worldFrame = 0;

  get settled(): boolean {
    return (
      this.terrain.pendingUpdates === 0 &&
      this.frameIndex - this.worldFrame > 45
    );
  }

  // 0..1 warm-up progress of the current world (for the loading bar).
  get worldProgress(): number {
    const f = Math.min(1, (this.frameIndex - this.worldFrame) / 30);
    return this.terrain.pendingUpdates === 0 ? f : Math.min(f, 0.9);
  }

  render(scene: SceneState) {
    const road = this.road!;
    const biome = this.biome!;
    const gpu = this.gpu;
    const d = gpu.device;
    const canvas = gpu.canvas;
    // CSS pixels by default (like most games on high-DPI displays); native
    // device resolution is a setting.
    const native = this.graphics.native && !this.graphics.lowPower;
    const dpr =
      (native ? Math.min(window.devicePixelRatio || 1, 2) : 1) *
      this.graphics.renderScale;
    let w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    let h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (this.fixedSize) [w, h] = this.fixedSize;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const resized = this.targets.resize(w, h);
    if (resized || this.hzbTargetsVersion !== this.targets.version) {
      this.hzb?.destroy();
      this.hzb = null;
      this.ensureHzb(w, h);
    }

    const cam = scene.camera;
    this.rebase(cam.eye[0], cam.eye[2]);
    const ox = this.originX,
      oz = this.originZ;
    const loc = (p: number[]): [number, number, number] => [
      p[0] - ox,
      p[1],
      p[2] - oz,
    ];
    const eye = loc(cam.eye);
    const target = loc(cam.target);
    const aspect = w / h;
    const near = cam.interior ? 0.05 : 0.15;
    const proj = perspectiveReverseZInfinite(cam.fov, aspect, near);
    const view = lookAt(eye, target, cam.up);
    const vpNJ = multiply(proj, view);
    // Jitter.
    const ji = (this.frameIndex % 16) + 1;
    const jx = ((halton(ji, 2) - 0.5) * 2) / w;
    const jy = ((halton(ji, 3) - 0.5) * 2) / h;
    const projJ = new Float32Array(proj);
    projJ[8] -= jx;
    projJ[9] -= jy;
    const vp = multiply(projJ, view);
    // Previous unjittered view-projection in the *current* origin.
    let prevVP = vpNJ;
    if (scene.prevCamera) {
      const pc = scene.prevCamera;
      const pproj = perspectiveReverseZInfinite(
        pc.fov,
        aspect,
        pc.interior ? 0.05 : 0.15,
      );
      prevVP = multiply(pproj, lookAt(loc(pc.eye), loc(pc.target), pc.up));
    }
    this.prevViewProj.set(prevVP);
    const fwd = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const fl = Math.hypot(fwd[0], fwd[1], fwd[2]);
    const f = fwd.map(x => x / fl);
    const right = [view[0], view[4], view[8]];
    const upv = [view[1], view[5], view[9]];

    const F = this.frame;
    F.set('viewProj', vp);
    F.set('viewProjNJ', vpNJ);
    F.set('prevViewProj', prevVP);
    F.set('invViewProj', invert(vpNJ));
    F.set('view', view);
    F.set('cascade', CASCADE_SPLITS);
    F.set('cam', [eye[0], eye[1], eye[2], scene.time]);
    F.set('prevCam', scene.prevCamera ? loc(scene.prevCamera.eye) : eye);
    const sk = scene.sky;
    F.set('sun', [...sk.lightDir, sk.isSun ? 1 : 0]);
    // Night: let the image stay dark (auto exposure would otherwise turn
    // moonlight into daylight).
    F.set('sunColor', [
      ...sk.lightColor,
      biome.sky.exposure * (1 - 0.85 * sk.night),
    ]);
    F.set('moon', [...sk.moonDir, sk.night]);
    F.set('misc', [ox, oz, w, h]);
    F.set('misc2', [jx, jy, this.frameIndex % 64, 0]);
    const wind = biome.weather.wind;
    F.set('weather', [
      wind * 0.8,
      wind * 0.6,
      biome.weather.snow,
      biome.weather.wetness,
    ]);
    // Lightning: a strike every ~60/rate s, each a few decaying pulses.
    const rain = biome.weather.rain ?? 0;
    let flash = 0,
      strikeAz = 0;
    const rate = biome.weather.lightning ?? 0;
    if (rate > 0) {
      const period = 60 / rate;
      const seg = Math.floor(scene.time / period);
      const hash = (k: number) => {
        const x = Math.sin(seg * 127.1 + k * 311.7) * 43758.5453;
        return x - Math.floor(x);
      };
      const dt = scene.time - (seg + hash(1) * 0.7) * period;
      strikeAz = hash(2) * Math.PI * 2;
      if (dt >= 0 && dt < 0.8) {
        const pulse = (t0: number, k: number, a: number) =>
          dt >= t0 ? a * Math.exp(-(dt - t0) * k) : 0;
        flash =
          (pulse(0, 22, 1) + pulse(0.11, 18, 0.8) + pulse(0.29, 10, 0.6)) *
          (0.6 + 0.8 * hash(3));
      }
    }
    if (DEBUG.has('lightning') && rate > 0) flash = 1;
    F.set('weather2', [rain, flash, Math.sin(strikeAz), Math.cos(strikeAz)]);
    const precip = rain > 0 || biome.weather.snow > 0;
    const snowFall = biome.weather.snow;
    // Water / snow on the player's glass (simulated whenever it rains or
    // snows; drawn for the interior cameras).
    const playerCar = scene.cars.find(c => c.player);
    if (playerCar)
      this.glassWater.update(
        scene.frozen ? 0 : scene.dt,
        scene.time,
        scene.player.speed,
        rain,
        snowFall,
        precip,
        this.cars.spec(playerCar.draw.kind),
        cam.interior,
      );
    this.glassFxOn = cam.interior && (rain > 0 || snowFall > 0);
    F.set('glass', [
      scene.player.speed,
      this.glassFxOn ? 1 : 0,
      precip ? 1 : 0,
      0,
    ]);
    F.set('camRight', [...right, 0]);
    F.set('camUp', [...upv, 0]);
    F.set('camFwd', [...f, Math.tan(cam.fov / 2)]);
    const tp = packTerrain(biome.terrain, road.seed);
    tp[20] = road.terrainParams[20];
    F.set('terrain', tp);
    const P = biome.palette;
    const clStyle = {
      'double-yellow': 1,
      'dashed-yellow': 2,
      'dashed-white': 3,
      none: 0,
    }[biome.road.centerLine];
    const S = biome.scatter;
    F.set('palette', [
      ...P.grassA,
      S.grass,
      ...P.grassB,
      S.grassHeight,
      ...P.dry,
      0,
      ...P.dirt,
      0,
      ...P.rock,
      0,
      ...P.sand,
      0,
      ...P.foliage,
      P.autumn ?? 0,
      ...P.flower,
      P.snow,
      0,
      biome.road.edgeLine ? 1 : 0,
      clStyle,
      biome.road.dirt ? 1 : 0,
      0,
      0,
      0,
      biome.ocean || biome.id === 'desert' || biome.id === 'arizona' ? 1 : 0,
      S.crops,
      S.hedges,
      S.buildings,
      S.trees,
      S.flowers, // palette[11].x: wildflowers / flowering plants (grass)
      P.scrub ?? 0, // palette[11].y: chaparral patches (terrain)
      S.forestEdge, // palette[11].z: trees start this far past the road edge
      0,
    ]);
    F.set('sky', [
      biome.sky.clouds,
      biome.sky.cloudScale,
      biome.weather.dust,
      1,
    ]);
    const nightTint = [0.75, 0.88, 1.25];
    F.set('grade', [
      ...biome.sky.grade.map((g, i) => g * (1 + (nightTint[i] - 1) * sk.night)),
      biome.sky.saturation * (1 - 0.35 * sk.night),
    ]);
    const g = this.graphics;
    // post.y: terrain-shading debug bits (?debug=norock / nodetail) for
    // finding what's expensive on a given GPU.
    F.set('post', [
      g.bloom ? 1 : 0,
      (DEBUG.has('norock') ? 1 : 0) + (DEBUG.has('nodetail') ? 2 : 0),
      0,
      0,
    ]);
    F.set('grade2', [
      biome.sky.contrast,
      g.filmGrain ? 0.35 : 0,
      g.filmGrain ? 0.012 : 0,
      g.letterbox ? 0.1 : 0,
    ]);
    F.set('car', [...loc(scene.player.pos), scene.player.heading]);
    const fogBase = road.atS(scene.playerS).y;
    F.set('fog', [
      biome.sky.fogDensity,
      biome.sky.fogHeight,
      fogBase,
      biome.sky.turbidity,
    ]);
    this.atmosphere.setMie(biome.sky.turbidity);
    const vol = VOLUME[biome.id] ?? [0, 0.6, 50];
    this.volumeOn =
      vol[0] > 0 && !DEBUG.has('novol') && this.graphics.volumetrics;
    F.set('volume', [vol[0], vol[1], vol[2], this.volumeOn ? 1 : 0]);

    // Lights.
    const nLights = this.updateLights(scene, loc);
    F.set('lights', [
      nLights,
      scene.headlights > 0 ? 1 : 0,
      biome.road.laneWidth,
      biome.road.lanesPerDir,
    ]);

    // Streaming.
    this.updateRoadTexture(cam.eye[2]);
    this.updateTunnels(scene.playerS, cam.eye, oz);
    this.terrain.updateClipmap(
      cam.eye[0],
      cam.eye[2],
      ox,
      oz,
      this.frameIndex < 2 ? 8 : 2,
    );
    const planes = frustumPlanes(vpNJ);
    this.terrain.select(eye, planes);
    this.terrain.select(eye, null);
    this.roadMesh!.setOrigin(ox, oz);
    this.roadMesh!.update(scene.playerS, planes);
    this.tunnelMesh!.setOrigin(ox, oz);
    this.tunnelMesh!.update(scene.playerS, planes);

    // Shadows.
    // Cached far cascades are invalid after an origin rebase, a camera cut
    // or a sun move.
    const shadowKey = [
      ox,
      oz,
      cam.shot,
      this.post.resetHistory,
      ...sk.lightDir.map(v => v.toFixed(3)),
    ].join();
    this.shadows.update(
      eye,
      f,
      right,
      upv,
      cam.fov,
      aspect,
      sk.lightDir,
      shadowKey,
    );
    const shadowMats = new Float32Array(64);
    for (let i = 0; i < CASCADES; ++i)
      shadowMats.set(this.shadows.matrices[i], i * 16);
    F.set('shadow', shadowMats);

    // Cars.
    const carDraws: CarDraw[] = [];
    for (const c of scene.cars) {
      if (c.player && cam.interior) {
        // The interior view renders the cabin instead of the body shell.
      }
      // The body rides the suspension (heave along its up axis).
      const bodyPos = (p: Pose) =>
        loc([0, 1, 2].map(k => p.pos[k] + p.up[k] * p.heave));
      const model = fromBasis(
        c.pose.left,
        c.pose.up,
        c.pose.fwd,
        bodyPos(c.pose),
      );
      const pp = c.prevPose ?? c.pose;
      const prevModel = fromBasis(pp.left, pp.up, pp.fwd, bodyPos(pp));
      carDraws.push({
        ...c.draw,
        model,
        prevModel,
        wheelDrop: c.pose.wheelDrop,
      });
    }
    this.cars.setCars(carDraws, eye, planes);
    this.mirrorCam = null;
    if (cam.interior && !DEBUG.has('nomirror')) {
      // The rear-view mirror is rendered from a virtual camera: the eye
      // reflected in the mirror plane, looking through the glass.
      const g = this.cars.mirrorGlass();
      const pl = scene.cars.find(c => c.player);
      if (g && pl) {
        const p = pl.pose;
        const base = loc([0, 1, 2].map(k => p.pos[k] + p.up[k] * p.heave));
        const tw = (v: number[]) =>
          [0, 1, 2].map(
            k => p.left[k] * v[0] + p.up[k] * v[1] + p.fwd[k] * v[2],
          );
        const mc = tw(g.c).map((x, k) => x + base[k]);
        const mn = tw(g.n);
        const d0 =
          (eye[0] - mc[0]) * mn[0] +
          (eye[1] - mc[1]) * mn[1] +
          (eye[2] - mc[2]) * mn[2];
        const ve = [0, 1, 2].map(k => eye[k] - 2 * d0 * mn[k]);
        const dist = Math.hypot(mc[0] - ve[0], mc[1] - ve[1], mc[2] - ve[2]);
        const aspect = MIRROR_W / MIRROR_H;
        const tanY = Math.max(0.05 / dist, 0.14 / dist / aspect);
        const proj = perspectiveReverseZInfinite(
          2 * Math.atan(tanY),
          aspect,
          // (Clip what's between the virtual eye and the glass: the
          // housing, windscreen, hood.)
          dist + 0.05,
        );
        const mview = lookAt(ve as Vec3, mc as Vec3, p.up as Vec3);
        const mvp = multiply(proj, mview);
        this.mirrorCam = {
          vp: mvp,
          view: mview,
          eye: ve,
          right: [mview[0], mview[4], mview[8]],
          up: [mview[1], mview[5], mview[9]],
        };
      }
    }
    this.cars.setMirror(this.mirrorCam?.vp ?? null);
    this.vegetation.planes2 = this.mirrorCam
      ? frustumPlanes(this.mirrorCam.vp)
      : null;
    if (cam.interior) {
      // Dashboard map: the road ahead in the player's (flat) car frame.
      const pl = scene.cars.find(c => c.player);
      if (pl) {
        const P = scene.player;
        const route: number[] = [];
        for (let k = 0; k < NAV_POINTS; ++k) {
          const q = road.pointAt(pl.s + pl.dir * (-50 + k * 12), 0).pos;
          const rx = q[0] - P.pos[0],
            rz = q[2] - P.pos[2];
          route.push(
            rx * P.baseLeft[0] + rz * P.baseLeft[2],
            rx * P.baseFwd[0] + rz * P.baseFwd[2],
          );
        }
        const mod = (x: number) => x - Math.floor(x / 1000) * 1000;
        this.cars.setNav(route, [
          mod(P.pos[0]),
          mod(P.pos[2]),
          P.baseFwd[0],
          P.baseFwd[2],
        ]);
      }
    }
    // The previous frame's Hi-Z is usable unless the camera cut or the
    // origin moved.
    this.vegetation.hzbValid =
      this.frameIndex > 2 &&
      cam.shot === this.lastShot &&
      !!scene.prevCamera &&
      this.post.resetHistory === false;
    this.lastShot = cam.shot;
    this.vegetation.update(scene, eye, planes, ox, oz);
    {
      const pe = scene.prevCamera ? scene.prevCamera.eye : cam.eye;
      const dt = Math.max(scene.dt, 1e-3);
      // Camera velocity for the weather particles, smoothed over ~0.25 s:
      // the raw frame difference carries frame-time jitter and the cockpit
      // bounce, and for flakes almost straight ahead the streak direction
      // comes from a tiny sideways component, so the noise made the snow
      // swish around instead of streaming into the camera. Cuts reset it.
      const raw = [0, 1, 2].map(k => (cam.eye[k] - pe[k]) / dt);
      const cut = !scene.prevCamera || Math.hypot(raw[0], raw[1], raw[2]) > 120;
      const a = 1 - Math.exp(-dt / 0.25);
      this.camVelSmooth = cut
        ? [0, 0, 0]
        : this.camVelSmooth.map((v, k) => v + (raw[k] - v) * a);
      const camVel = this.camVelSmooth;
      const road = this.road!;
      // Dust: slot 0 is the player; the nearest moving cars get stable
      // slots that fade in / out (no popping when the set changes).
      const cand = scene.cars
        .filter(c => !c.player && c.speed > 3)
        .map(c => ({
          c,
          dist: Math.hypot(
            c.pose.pos[0] - cam.eye[0],
            c.pose.pos[2] - cam.eye[2],
          ),
        }))
        .filter(m => m.dist < 250)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, DUST_SLOTS - 1)
        .map(m => m.c);
      const byId = new Map(scene.cars.map(c => [c.id, c]));
      const want = new Set(cand.map(c => c.id));
      for (const [id, slot] of this.dustSlots) {
        const on = want.has(id) && byId.has(id);
        slot.fade = Math.max(0, Math.min(1, slot.fade + (on ? dt : -dt) / 1.5));
        if (!on && (slot.fade <= 0 || !byId.has(id))) this.dustSlots.delete(id);
      }
      for (const c of cand) {
        if (this.dustSlots.has(c.id)) continue;
        const used = new Set([...this.dustSlots.values()].map(s => s.index));
        for (let k = 1; k < DUST_SLOTS; ++k)
          if (!used.has(k)) {
            this.dustSlots.set(c.id, {index: k, fade: 0});
            break;
          }
      }
      const trailOf = (c: WorldCar) => (age: number) =>
        loc(
          road.pointAt(c.s - c.dir * (c.length * 0.45 + c.speed * age), c.d)
            .pos,
        );
      const player = scene.cars.find(c => c.player)!;
      const movers: Array<{trail: (a: number) => number[]; speed: number}> =
        Array.from({length: DUST_SLOTS}, () => ({
          trail: trailOf(player),
          speed: 0,
        }));
      movers[0] = {trail: trailOf(player), speed: player.speed};
      for (const [id, slot] of this.dustSlots) {
        const c = byId.get(id);
        if (c)
          movers[slot.index] = {trail: trailOf(c), speed: c.speed * slot.fade};
      }
      this.tracks?.update(
        road,
        scene.cars.map(c => ({
          id: c.id,
          s: c.s - c.dir * c.length * 0.3,
          d: c.d,
          track: c.track,
          dir: c.dir,
        })),
        loc,
      );
      this.particles.update(
        movers,
        scene.frozen ? [0, 0, 0] : camVel,
        loc(scene.player.pos),
        scene.player.fwd,
        scene.frozen ? 0 : Math.max(scene.dt, 1e-3),
      );
    }
    this.props.update(scene.playerS, ox, oz, planes, this.roadMesh!);

    F.upload();
    if (this.mirrorCam) {
      // Mirror pass frame: the main one with its camera; no clustered local
      // lights (the clusters are the main view's) or volumetrics.
      const M = this.mirrorFrame;
      M.data.set(F.data);
      const m = this.mirrorCam;
      M.set('viewProj', m.vp);
      M.set('viewProjNJ', m.vp);
      M.set('prevViewProj', m.vp);
      M.set('invViewProj', invert(m.vp));
      M.set('view', m.view);
      M.set('cam', [m.eye[0], m.eye[1], m.eye[2], scene.time]);
      M.set('prevCam', m.eye);
      M.set('camRight', [...m.right, 0]);
      M.set('camUp', [...m.up, 0]);
      const li = this.frame.offsetBytes('lights') / 4;
      M.data[li] = 0;
      const vi = this.frame.offsetBytes('volume') / 4;
      M.data[vi + 3] = 0;
      M.upload();
    }

    const enc = d.createCommandEncoder({label: 'frame'});
    this.profiler.beginFrame();
    this.terrain.encodeClipmapUpdates(enc);
    if (DEBUG.has('probe')) this.terrain.probe(enc, eye[0], eye[2]);
    this.atmosphere.update(enc);
    this.water?.encode(enc, scene.time);
    this.encodeEnvMap(enc);
    this.vegetation.encodeCompute(enc, this.frameBG);

    // Shadow cascades.
    for (let i = 0; i < CASCADES; ++i) {
      if (!this.shadows.dirty[i]) continue;
      const pass = enc.beginRenderPass({
        label: `shadow-cascade-${i}`,
        timestampWrites: ts('shadows'),
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.shadows.layerViews[i],
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setBindGroup(0, this.shadowFrameBG);
      pass.setBindGroup(2, this.shadows.bindGroups[i]);
      this.terrain.drawShadow(pass);
      this.roadMesh!.drawShadow(pass, this.emptyBG);
      this.tunnelMesh!.drawShadow(pass, this.emptyBG);
      if (!DEBUG.has('novegshadow'))
        this.vegetation.drawShadow(
          pass,
          i,
          !this.graphics.leafShadows || DEBUG.has('fastleafshadow'),
        );
      this.props.drawShadow(pass);
      if (i < 3) this.cars.drawShadow(pass);
      pass.end();
    }

    // Clustered light culling.
    {
      const cp = enc.beginComputePass({
        label: 'light-clusters',
        timestampWrites: ts('clusters'),
      });
      cp.setPipeline(this.clusterPipe);
      cp.setBindGroup(0, this.clusterBG);
      cp.dispatchWorkgroups(4, 3, 6);
      cp.end();
    }

    // Volumetric fog (needs this frame's shadow maps).
    if (this.volumeOn) {
      const vp = enc.beginComputePass({
        label: 'volumetric-fog',
        timestampWrites: ts('volumetrics'),
      });
      vp.setPipeline(this.volPipe);
      vp.setBindGroup(0, this.volBG);
      vp.dispatchWorkgroups(20, 12);
      vp.end();
    }

    // Rear-view mirror image (interior views).
    if (this.mirrorCam) {
      const cr = this.cars;
      const mp = enc.beginRenderPass({
        label: 'rear-view-mirror',
        timestampWrites: ts('mirror'),
        colorAttachments: [
          {
            view: cr.mirrorColor.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
          {
            view: cr.mirrorVel.createView(),
            loadOp: 'clear',
            storeOp: 'discard',
            clearValue: [0, 0, 0, 0],
          },
          {
            view: cr.mirrorNormal.createView(),
            loadOp: 'clear',
            storeOp: 'discard',
            clearValue: [0, 0, 0, 0],
          },
        ],
        depthStencilAttachment: {
          view: cr.mirrorDepth.createView(),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
        },
      });
      mp.setBindGroup(0, this.mirrorFrameBG);
      mp.setBindGroup(2, this.emptyBG);
      cr.drawMirror(mp);
      mp.setBindGroup(2, this.emptyBG);
      this.roadMesh!.drawAll(mp);
      this.tunnelMesh!.drawAll(mp);
      this.vegetation.drawTrees(mp, this.emptyBG);
      if (!DEBUG.has('noterrain')) this.terrain.drawAround(mp);
      mp.setPipeline(this.atmosphere.skyDrawPipe);
      mp.draw(3);
      mp.end();
    }

    // Main pass.
    const t = this.targets;
    const main = enc.beginRenderPass({
      label: 'main',
      timestampWrites: ts('main'),
      colorAttachments: [
        {
          view: t.color.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
        {
          view: t.velocity.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
        {
          view: t.normal.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0.5, 1, 0.5, 1],
        },
      ],
      depthStencilAttachment: {
        view: t.depth.createView(),
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    main.setBindGroup(0, this.frameBG);
    main.setBindGroup(2, this.emptyBG);
    this.cars.draw(main);
    this.roadMesh!.draw(main);
    this.tunnelMesh!.draw(main);
    this.props.draw(main);
    main.setBindGroup(2, this.emptyBG);
    this.vegetation.draw(main, this.emptyBG);
    if (!DEBUG.has('noterrain')) this.terrain.draw(main, DEBUG.has('allbore'));
    this.water?.draw(main);
    main.setPipeline(this.atmosphere.skyDrawPipe);
    main.draw(3);
    this.tracks?.draw(main);
    this.particles.draw(main);
    this.cars.drawGlass(main);
    main.end();

    // Rain drops on the player's glass (interior cameras).
    if (this.glassFxOn) this.glassWater.encode(enc);
    if (this.glassFxOn) {
      const gp = enc.beginRenderPass({
        label: 'glass-fx',
        colorAttachments: [
          {
            view: t.glassFx.createView(),
            clearValue: {r: 0, g: 0, b: 0, a: 0},
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: t.depth.createView(),
          depthReadOnly: true,
        },
      });
      gp.setBindGroup(0, this.frameBG);
      const wg = this.glassWater.fxGroup;
      if (wg) this.cars.drawGlassFx(gp, wg);
      gp.end();
    }

    this.encodeHzb(enc);
    this.post.aoEnabled = this.graphics.ssao;
    this.post.aoHalfRes = !DEBUG.has('fullao');
    this.post.ssrEnabled =
      biome.weather.wetness > 0 || (biome.weather.rain ?? 0) > 0 || biome.ocean;
    this.vegetation.grassEnabled = this.graphics.grass;
    this.vegetation.lowPower = this.graphics.lowPower;
    this.post.encode(
      enc,
      gpu.context.getCurrentTexture().createView({label: 'swapchain'}),
      {
        dt: scene.dt,
        exposureBias: this.exposureBias,
        focus: cam.focus,
        aperture: DEBUG.has('nodof') || !this.graphics.dof ? 0 : cam.aperture,
        bloom: this.graphics.bloom,
        near,
        motionBlur:
          DEBUG.has('nomb') || !this.graphics.motionBlur
            ? 0
            : scene.frozen
              ? 0
              : 0.5,
      },
    );
    this.profiler.endFrame(enc);
    d.queue.submit([enc.finish()]);
    this.profiler.afterSubmit();
    if (DEBUG.has('probe')) this.terrain.afterSubmit();
    this.frameIndex++;
    this.stats.terrainNodes = this.terrain.nodeCount;
    this.stats.roadChunks = this.roadMesh!.visible.length;
    this.stats.cars = carDraws.length;
  }

  private updateLights(
    scene: SceneState,
    loc: (p: number[]) => [number, number, number],
  ): number {
    let n = 0;
    const L = this.lightsData;
    L.fill(0);
    const level = scene.headlights;
    if (level <= 0) {
      this.gpu.device.queue.writeBuffer(this.lightsBuf, 0, L, 0, 12);
      return 0;
    }
    const camP = scene.camera.eye;
    const sorted = [...scene.cars].sort((a, b) => {
      const da = Math.hypot(a.pose.pos[0] - camP[0], a.pose.pos[2] - camP[2]);
      const db = Math.hypot(b.pose.pos[0] - camP[0], b.pose.pos[2] - camP[2]);
      return da - db;
    });
    for (const c of sorted) {
      if (n >= MAX_LIGHTS - 4) break;
      const p = c.pose;
      const len = this.cars.spec(c.draw.kind).length / 2;
      const hw = this.cars.spec(c.draw.kind).width / 2;
      for (const side of [-1, 1]) {
        // Headlight spot.
        const hp = [0, 1, 2].map(
          k =>
            p.pos[k] +
            p.fwd[k] * (len - 0.2) +
            p.left[k] * side * hw * 0.7 +
            p.up[k] * 0.7,
        );
        const dir = [0, 1, 2].map(k => p.fwd[k] - p.up[k] * 0.06);
        const hl = loc(hp);
        const intensity = (c.player ? 2400 : 1500) * level;
        L.set(
          [
            hl[0],
            hl[1],
            hl[2],
            140,
            dir[0],
            dir[1],
            dir[2],
            Math.cos(0.42),
            1,
            0.95,
            0.85,
            Math.cos(0.18),
          ].map((v, i) => (i >= 8 && i < 11 ? v * intensity : v)),
          n * 12,
        );
        n++;
        // Tail light glow (not for our own car seen from the cabin).
        if (c.player && scene.camera.interior) continue;
        const tp = [0, 1, 2].map(
          k =>
            p.pos[k] -
            p.fwd[k] * (len + 0.1) +
            p.left[k] * side * hw * 0.7 +
            p.up[k] * 0.8,
        );
        const tl = loc(tp);
        const tb = (1.2 + c.draw.brake * 5) * level;
        L.set(
          [tl[0], tl[1], tl[2], 5, 0, 0, 0, -2, tb, tb * 0.03, tb * 0.02, 0],
          n * 12,
        );
        n++;
      }
    }
    this.gpu.device.queue.writeBuffer(this.lightsBuf, 0, L, 0, n * 12);
    return n;
  }
}
