// Frame orchestration: uniforms, streaming (origin rebasing, road texture,
// clipmaps, road chunks), shadow cascades, the main G-buffer pass and post.
import {Gpu} from '../gpu/gpu';
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

const REBASE = 1024;
export const DEBUG = new Set(
  (new URLSearchParams(location.search).get('debug') ?? '').split(','),
);
const MAX_LIGHTS = 64;

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
  player: Pose;
  headlights: boolean;
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
  originX = 0;
  originZ = 0;
  frameIndex = 0;
  private prevViewProj = new Float32Array(16);
  exposureBias = 1;
  stats = {terrainNodes: 0, roadChunks: 0, cars: 0, gpuMs: 0};

  constructor(private gpu: Gpu) {
    const d = gpu.device;
    this.frame = new FrameData(d);
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
    this.props = new Props(d, this.frameLayout, this.shadows.layout);
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
    ];
    this.frameBG = d.createBindGroup({
      label: 'frame-bg',
      layout: this.frameLayout,
      entries: entries(this.shadows.map.createView({dimension: '2d-array'})),
    });
    this.shadowFrameBG = d.createBindGroup({
      label: 'frame-bg-shadowpass',
      layout: this.frameLayout,
      entries: entries(dummyShadow.createView({dimension: '2d-array'})),
    });
  }

  setWorld(road: Road, biome: Biome) {
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

  get settled(): boolean {
    return this.terrain.pendingUpdates === 0 && this.frameIndex > 45;
  }

  render(scene: SceneState) {
    const road = this.road!;
    const biome = this.biome!;
    const gpu = this.gpu;
    const d = gpu.device;
    const canvas = gpu.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.targets.resize(w, h);

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
    F.set('sunColor', [...sk.lightColor, biome.sky.exposure]);
    F.set('moon', [...sk.moonDir, sk.night]);
    F.set('misc', [ox, oz, w, h]);
    F.set('misc2', [jx, jy, 0, 0]);
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
    F.set('grade', [...biome.sky.grade, biome.sky.saturation]);
    F.set('grade2', [biome.sky.contrast, 0.35, 0.012, 0]);
    F.set('car', [...loc(scene.player.pos), scene.player.heading]);
    const fogBase = road.atS(scene.playerS).y;
    F.set('fog', [
      biome.sky.fogDensity,
      biome.sky.fogHeight,
      fogBase,
      biome.sky.turbidity,
    ]);
    this.atmosphere.setMie(biome.sky.turbidity);

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
    this.vegetation.update(scene, eye, planes, ox, oz);
    this.props.update(scene.playerS, ox, oz, planes, this.roadMesh!);

    F.upload();

    const enc = d.createCommandEncoder({label: 'frame'});
    this.terrain.encodeClipmapUpdates(enc);
    this.atmosphere.update(enc);
    this.vegetation.encodeCompute(enc, this.frameBG);

    // Shadow cascades.
    for (let i = 0; i < CASCADES; ++i) {
      const pass = enc.beginRenderPass({
        label: `shadow-cascade-${i}`,
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

    // Main pass.
    const t = this.targets;
    const main = enc.beginRenderPass({
      label: 'main',
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
    this.vegetation.draw(main, this.emptyBG);
    if (!DEBUG.has('noterrain')) this.terrain.draw(main);
    main.setPipeline(this.atmosphere.skyDrawPipe);
    main.draw(3);
    main.end();

    this.post.encode(
      enc,
      gpu.context.getCurrentTexture().createView({label: 'swapchain'}),
      scene.dt,
      this.exposureBias,
    );
    d.queue.submit([enc.finish()]);
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
        // Tail light glow.
        const tp = [0, 1, 2].map(
          k =>
            p.pos[k] -
            p.fwd[k] * (len + 0.1) +
            p.left[k] * side * hw * 0.7 +
            p.up[k] * 0.8,
        );
        const tl = loc(tp);
        const tb = 4 + c.draw.brake * 10;
        L.set(
          [tl[0], tl[1], tl[2], 8, 0, 0, 0, -2, tb, tb * 0.03, tb * 0.02, 0],
          n * 12,
        );
        n++;
      }
    }
    this.gpu.device.queue.writeBuffer(this.lightsBuf, 0, L, 0, n * 12);
    return n;
  }
}
