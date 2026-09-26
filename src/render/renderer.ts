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
import {Biome, packTerrain} from '../world/biome';
import {Road, ROAD_DZ, ROAD_TEX_BEHIND, ROAD_TEX_SAMPLES} from '../world/road';
import {SkyState} from '../world/sky';
import {Atmosphere} from './atmosphere';
import {CarDraw, CarRenderer} from './cars';
import {FRAME_LAYOUT_ENTRIES, FrameData} from './frameData';
import {Post} from './post';
import {RoadMesh} from './roadMesh';
import {CASCADE_SPLITS, CASCADES, Shadows} from './shadows';
import {Targets} from './targets';
import {TerrainRenderer} from './terrain';
import {CameraState} from '../camera/director';
import {Pose} from '../sim/pose';
import {Vegetation} from './vegetation';
import {Props} from './props';
import {Water} from './water';
import {Particles} from './particles';
import volSrc from '../shaders/volumetric.wgsl';
import clusterSrc from '../shaders/clusters.wgsl';
import hzbSrc from '../shaders/hzb.wgsl';
import {FRAME_PRELUDE} from './shaders';
import {shaderModule} from '../gpu/gpu';

const REBASE = 1024;

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
  lowPower: boolean; // phones: DPR 1, sparser grass, shorter vegetation ranges
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
  lowPower: false,
};

// Preset applied when low-power mode is chosen (and by default on phones).
export const LOW_POWER_GRAPHICS: GraphicsSettings = {
  ...DEFAULT_GRAPHICS,
  volumetrics: false,
  ssao: false,
  renderScale: 0.8,
  lowPower: true,
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
export const DEBUG = new Set(
  (new URLSearchParams(location.search).get('debug') ?? '').split(','),
);
const MAX_LIGHTS = 64;
// Volumetric fog per environment: density (1/m), anisotropy, height falloff.
const VOLUME: Record<string, [number, number, number]> = {
  country: [0.0005, 0.65, 40],
  desert: [0.0003, 0.7, 60],
  coast: [0.0006, 0.6, 40],
  forest: [0.0045, 0.72, 35],
  snow: [0, 0.5, 50],
  lahonda: [0.0025, 0.65, 45],
  night: [0.0022, 0.5, 30],
};

export interface WorldCar {
  draw: Omit<CarDraw, 'model' | 'prevModel'>;
  pose: Pose;
  prevPose: Pose | null;
  player: boolean;
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
  headlights: boolean;
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
  readonly targets: Targets;
  readonly atmosphere: Atmosphere;
  readonly terrain: TerrainRenderer;
  readonly cars: CarRenderer;
  readonly shadows: Shadows;
  readonly post: Post;
  readonly vegetation: Vegetation;
  readonly props: Props;
  readonly water: Water;
  readonly particles: Particles;
  roadMesh: RoadMesh | null = null;
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
  stats = {terrainNodes: 0, roadChunks: 0, cars: 0};
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
    this.cars.createPipelines(this.frameLayout, this.shadows.layout);
    this.vegetation = new Vegetation(
      d,
      this.frame,
      this.frameLayout,
      this.shadows.layout,
    );
    this.ensureHzb(1, 1);
    this.props = new Props(d, this.frameLayout, this.shadows.layout);
    this.water = new Water(d, this.frameLayout);
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
    const entries = (shadowView: GPUTextureView): GPUBindGroupEntry[] => [
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
    ];
    this.frameBG = d.createBindGroup({
      label: 'frame-bg',
      layout: this.frameLayout,
      entries: entries(this.shadows.map.createView({dimension: '2d-array'})),
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
    this.roadMesh.createPipelines(this.frameLayout, this.shadows.layout);
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
    this.water.enabled = biome.ocean;
    this.particles.setWorld(biome);
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
    const dpr =
      Math.min(window.devicePixelRatio || 1, this.graphics.lowPower ? 1 : 2) *
      this.graphics.renderScale;
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
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
    F.set('misc2', [jx, jy, this.frameIndex % 8, 0]);
    const wind = biome.weather.wind;
    F.set('weather', [
      wind * 0.8,
      wind * 0.6,
      biome.weather.snow,
      biome.weather.wetness,
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
      0,
      ...P.flower,
      P.snow,
      0,
      biome.road.edgeLine ? 1 : 0,
      clStyle,
      biome.road.dirt ? 1 : 0,
      0,
      0,
      0,
      biome.ocean || biome.id === 'desert' ? 1 : 0,
      S.crops,
      S.hedges,
      S.buildings,
      S.trees,
      0,
      0,
      0,
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
    F.set('post', [g.bloom ? 1 : 0, 0, 0, 0]);
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
      scene.headlights ? 1 : 0,
      biome.road.laneWidth,
      biome.road.lanesPerDir,
    ]);

    // Streaming.
    this.updateRoadTexture(cam.eye[2]);
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

    // Shadows.
    this.shadows.update(eye, f, right, upv, cam.fov, aspect, sk.lightDir);
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
      const model = fromBasis(
        c.pose.left,
        c.pose.up,
        c.pose.fwd,
        loc(c.pose.pos),
      );
      const pp = c.prevPose ?? c.pose;
      const prevModel = fromBasis(pp.left, pp.up, pp.fwd, loc(pp.pos));
      carDraws.push({...c.draw, model, prevModel});
    }
    this.cars.setCars(carDraws);
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
      const camVel = [0, 1, 2].map(k => (cam.eye[k] - pe[k]) / dt);
      const sp = scene.player.speed;
      const road = this.road!;
      this.particles.update(
        age => {
          const q = road.pointAt(scene.playerS - 2.2 - sp * age, scene.playerD);
          return loc(q.pos);
        },
        sp,
        scene.frozen ? [0, 0, 0] : camVel,
      );
    }
    this.props.update(scene.playerS, ox, oz, planes, this.roadMesh!);

    F.upload();

    const enc = d.createCommandEncoder({label: 'frame'});
    this.profiler.beginFrame();
    this.terrain.encodeClipmapUpdates(enc);
    if (DEBUG.has('probe')) this.terrain.probe(enc, eye[0], eye[2]);
    this.atmosphere.update(enc);
    this.vegetation.encodeCompute(enc, this.frameBG);

    // Shadow cascades.
    for (let i = 0; i < CASCADES; ++i) {
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
      this.vegetation.drawShadow(pass, i);
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
    this.props.draw(main);
    main.setBindGroup(2, this.emptyBG);
    this.vegetation.draw(main, this.emptyBG);
    if (!DEBUG.has('noterrain')) this.terrain.draw(main);
    this.water.draw(main);
    main.setPipeline(this.atmosphere.skyDrawPipe);
    main.draw(3);
    this.particles.draw(main);
    this.cars.drawGlass(main);
    main.end();

    this.encodeHzb(enc);
    this.post.aoEnabled = this.graphics.ssao;
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
    if (!scene.headlights) {
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
        const intensity = c.player ? 2400 : 1500;
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
        const tb = 1.2 + c.draw.brake * 5;
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
