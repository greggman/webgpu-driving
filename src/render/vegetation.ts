// GPU-driven vegetation: per-frame compute scatter of trees/bushes/rocks into
// per-mesh-LOD indirect draws (LOD0 mesh, LOD1 mesh, octahedral impostor),
// impostor baking, and frustum-based grass.
import {shaderModule} from '../gpu/gpu';
import {aabbInFrustum} from '../math/mat4';
import {Biome, TreeKind} from '../world/biome';
import {Road} from '../world/road';
import {VegKind, VegMesh, buildVeg} from '../gen/trees';
import {VEG_FLOATS} from '../gen/meshBuilder';
import {FrameData} from './frameData';
import {SceneState} from './renderer';
import {RENDER_PRELUDE} from './shaders';
import vegCommon from '../shaders/veg_common.wgsl';
import scatterSrc from '../shaders/veg_scatter.wgsl';
import meshSrc from '../shaders/veg_mesh.wgsl';
import impSrc from '../shaders/veg_impostor.wgsl';
import grassSrc from '../shaders/grass.wgsl';
import {DEPTH_FORMAT, GBUFFER_TARGETS} from './targets';

const MAX_MESHES = 16;
const INST_BYTES = 32;
const CAPS = [5000, 16000, 50000]; // lod0, lod1, impostor per mesh
const IMP_RES = 512;
const GRASS_CAP_NEAR = 300000;
const GRASS_CAP_FAR = 400000;
const TILE = 8;
// Base scale per species so procedural trees reach realistic heights.
const TREE_SCALE: Record<string, number> = {
  oak: 2.0,
  birch: 1.7,
  bare: 1.8,
  pine: 1.1,
  redwood: 1.0,
  cypress: 1.0,
  palm: 1.2,
  cactus: 1.0,
};

interface TypeDef {
  mesh: number;
  variants: number;
  weight: number;
  cluster: number;
  minRoad: number;
  maxSlope: number;
  scaleMin: number;
  scaleMax: number;
}

interface Layer {
  cell: number;
  lod0: number;
  lod1: number;
  maxDist: number;
  impostors: boolean;
  types: TypeDef[];
  seed: number;
  params: GPUBuffer;
  bg?: GPUBindGroup;
}

interface MeshGPU {
  mesh: VegMesh;
  firstIndex: number[];
  indexCount: number[];
  baseVertex: number[];
}

export class Vegetation {
  readonly materialView: GPUTextureView;
  private meshes: MeshGPU[] = [];
  private vbuf: GPUBuffer | null = null;
  private ibuf: GPUBuffer | null = null;
  private meshInfoBuf: GPUBuffer;
  private instBuf: GPUBuffer;
  private argsBuf: GPUBuffer;
  private argsTemplate = new Uint32Array(MAX_MESHES * 3 * 5);
  private capsBuf: GPUBuffer;
  private drawInfoBuf: GPUBuffer;
  private drawInfoLayout: GPUBindGroupLayout;
  private drawInfoBG: GPUBindGroup;
  private impAlbedo: GPUTexture;
  private impNormal: GPUTexture;
  private layers: Layer[] = [];
  private scatterPipe: GPUComputePipeline;
  private scatterLayout: GPUBindGroupLayout;
  private meshLayout: GPUBindGroupLayout;
  private meshBG!: GPUBindGroup;
  private meshPipe: GPURenderPipeline;
  private meshShadowPipe: GPURenderPipeline;
  private impPipe: GPURenderPipeline;
  private impShadowPipe: GPURenderPipeline;
  private bakePipe: GPURenderPipeline;
  private impSampler: GPUSampler;
  // Grass.
  private grassParams: GPUBuffer;
  private tileBuf: GPUBuffer;
  private tileData = new Float32Array(4096 * 4);
  private tileCount = 0;
  private bladesNear: GPUBuffer;
  private bladesFar: GPUBuffer;
  private grassArgs: GPUBuffer;
  private grassSpawnPipe: GPUComputePipeline;
  private grassSpawnBG!: GPUBindGroup;
  private grassNearPipe: GPURenderPipeline;
  private grassFarPipe: GPURenderPipeline;
  private grassNearBG!: GPUBindGroup;
  private grassFarBG!: GPUBindGroup;
  private tileHeights = new Map<string, number>();
  private road: Road | null = null;
  private biome: Biome | null = null;
  enabled = true;

  constructor(
    private device: GPUDevice,
    private frame: FrameData,
    frameLayout: GPUBindGroupLayout,
    shadowLayout: GPUBindGroupLayout,
  ) {
    const d = device;
    const tex = d.createTexture({
      label: 'material-array',
      size: [4, 4, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.materialView = tex.createView({dimension: '2d-array'});
    this.meshInfoBuf = d.createBuffer({
      label: 'veg-mesh-info',
      size: MAX_MESHES * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const perMesh = CAPS.reduce((a, b) => a + b, 0);
    this.instBuf = d.createBuffer({
      label: 'veg-instances',
      size: MAX_MESHES * perMesh * INST_BYTES,
      usage: GPUBufferUsage.STORAGE,
    });
    this.argsBuf = d.createBuffer({
      label: 'veg-indirect-args',
      size: this.argsTemplate.byteLength,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST,
    });
    this.capsBuf = d.createBuffer({
      label: 'veg-draw-caps',
      size: 48 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const caps = new Uint32Array(48 * 4);
    const infos = new Uint32Array(MAX_MESHES * 3 * 64);
    for (let m = 0; m < MAX_MESHES; ++m) {
      let base = m * perMesh;
      for (let l = 0; l < 3; ++l) {
        caps.set([base, CAPS[l], 0, 0], (m * 3 + l) * 4);
        infos.set([base, m, l, 0], (m * 3 + l) * 64);
        base += CAPS[l];
      }
    }
    d.queue.writeBuffer(this.capsBuf, 0, caps);
    this.drawInfoBuf = d.createBuffer({
      label: 'veg-draw-info',
      size: infos.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.drawInfoBuf, 0, infos);
    this.drawInfoLayout = d.createBindGroupLayout({
      label: 'veg-draw-info-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {type: 'uniform', hasDynamicOffset: true},
        },
      ],
    });
    this.drawInfoBG = d.createBindGroup({
      label: 'veg-draw-info-bg',
      layout: this.drawInfoLayout,
      entries: [{binding: 0, resource: {buffer: this.drawInfoBuf, size: 16}}],
    });
    this.impAlbedo = d.createTexture({
      label: 'impostor-albedo',
      size: [IMP_RES, IMP_RES, MAX_MESHES],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.impNormal = d.createTexture({
      label: 'impostor-normal',
      size: [IMP_RES, IMP_RES, MAX_MESHES],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.impSampler = d.createSampler({
      label: 'impostor-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // --- Scatter compute ---
    this.scatterLayout = d.createBindGroupLayout({
      label: 'veg-scatter-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'uniform'},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'storage'},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'storage'},
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'read-only-storage'},
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'uniform'},
        },
      ],
    });
    const scatterMod = shaderModule(
      d,
      RENDER_PRELUDE + '\n' + vegCommon + '\n' + scatterSrc,
      'veg-scatter',
    );
    this.scatterPipe = d.createComputePipeline({
      label: 'veg-scatter',
      layout: d.createPipelineLayout({
        label: 'veg-scatter-pl',
        bindGroupLayouts: [frameLayout, this.scatterLayout],
      }),
      compute: {module: scatterMod, entryPoint: 'scatter'},
    });

    // --- Mesh / impostor draw ---
    this.meshLayout = d.createBindGroupLayout({
      label: 'veg-mesh-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {type: 'read-only-storage'},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {type: 'read-only-storage'},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {viewDimension: '2d-array'},
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {viewDimension: '2d-array'},
        },
        {binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {}},
      ],
    });
    this.meshBG = d.createBindGroup({
      label: 'veg-mesh-bg',
      layout: this.meshLayout,
      entries: [
        {binding: 0, resource: {buffer: this.instBuf}},
        {binding: 1, resource: {buffer: this.meshInfoBuf}},
        {
          binding: 2,
          resource: this.impAlbedo.createView({dimension: '2d-array'}),
        },
        {
          binding: 3,
          resource: this.impNormal.createView({dimension: '2d-array'}),
        },
        {binding: 4, resource: this.impSampler},
      ],
    });
    const pre = RENDER_PRELUDE + '\n' + vegCommon + '\n';
    const meshMod = shaderModule(d, pre + meshSrc, 'veg-mesh');
    const impMod = shaderModule(d, pre + impSrc, 'veg-impostor');
    const vtx: GPUVertexBufferLayout[] = [
      {
        arrayStride: VEG_FLOATS * 4,
        attributes: [
          {shaderLocation: 0, offset: 0, format: 'float32x3'},
          {shaderLocation: 1, offset: 12, format: 'float32x3'},
          {shaderLocation: 2, offset: 24, format: 'float32x2'},
          {shaderLocation: 3, offset: 32, format: 'float32'},
          {shaderLocation: 4, offset: 36, format: 'float32'},
        ],
      },
    ];
    const emptyLayout = d.createBindGroupLayout({
      label: 'veg-empty',
      entries: [],
    });
    const mainPL = d.createPipelineLayout({
      label: 'veg-main-pl',
      bindGroupLayouts: [
        frameLayout,
        this.meshLayout,
        emptyLayout,
        this.drawInfoLayout,
      ],
    });
    const shadowPL = d.createPipelineLayout({
      label: 'veg-shadow-pl',
      bindGroupLayouts: [
        frameLayout,
        this.meshLayout,
        shadowLayout,
        this.drawInfoLayout,
      ],
    });
    const depth: GPUDepthStencilState = {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: 'greater',
    };
    const shadowDepth: GPUDepthStencilState = {
      ...depth,
      depthBias: -2,
      depthBiasSlopeScale: -2,
    };
    this.meshPipe = d.createRenderPipeline({
      label: 'veg-mesh',
      layout: mainPL,
      vertex: {module: meshMod, entryPoint: 'vs', buffers: vtx},
      fragment: {module: meshMod, entryPoint: 'fs', targets: GBUFFER_TARGETS},
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: depth,
    });
    this.meshShadowPipe = d.createRenderPipeline({
      label: 'veg-mesh-shadow',
      layout: shadowPL,
      vertex: {module: meshMod, entryPoint: 'vsShadow', buffers: vtx},
      fragment: {module: meshMod, entryPoint: 'fsShadow', targets: []},
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: shadowDepth,
    });
    this.impPipe = d.createRenderPipeline({
      label: 'veg-impostor',
      layout: mainPL,
      vertex: {module: impMod, entryPoint: 'vs'},
      fragment: {module: impMod, entryPoint: 'fs', targets: GBUFFER_TARGETS},
      primitive: {topology: 'triangle-strip', cullMode: 'none'},
      depthStencil: depth,
    });
    this.impShadowPipe = d.createRenderPipeline({
      label: 'veg-impostor-shadow',
      layout: shadowPL,
      vertex: {module: impMod, entryPoint: 'vsShadow'},
      fragment: {module: impMod, entryPoint: 'fsShadow', targets: []},
      primitive: {topology: 'triangle-strip', cullMode: 'none'},
      depthStencil: shadowDepth,
    });
    this.bakePipe = d.createRenderPipeline({
      label: 'veg-impostor-bake',
      layout: 'auto',
      vertex: {module: meshMod, entryPoint: 'vsBake', buffers: vtx},
      fragment: {
        module: meshMod,
        entryPoint: 'fsBake',
        targets: [{format: 'rgba8unorm'}, {format: 'rgba8unorm'}],
      },
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    });

    // --- Grass ---
    this.grassParams = d.createBuffer({
      label: 'grass-params',
      size: 6 * 16 + 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.tileBuf = d.createBuffer({
      label: 'grass-tiles',
      size: this.tileData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.bladesNear = d.createBuffer({
      label: 'grass-blades-near',
      size: GRASS_CAP_NEAR * 32,
      usage: GPUBufferUsage.STORAGE,
    });
    this.bladesFar = d.createBuffer({
      label: 'grass-blades-far',
      size: GRASS_CAP_FAR * 32,
      usage: GPUBufferUsage.STORAGE,
    });
    this.grassArgs = d.createBuffer({
      label: 'grass-indirect-args',
      size: 32,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST,
    });
    const grassMod = shaderModule(d, pre + grassSrc, 'grass');
    const grassComputeLayout = d.createBindGroupLayout({
      label: 'grass-compute-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'uniform'},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'read-only-storage'},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'storage'},
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'storage'},
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {type: 'storage'},
        },
      ],
    });
    this.grassSpawnPipe = d.createComputePipeline({
      label: 'grass-spawn',
      layout: d.createPipelineLayout({
        label: 'grass-spawn-pl',
        bindGroupLayouts: [frameLayout, grassComputeLayout],
      }),
      compute: {module: grassMod, entryPoint: 'spawn'},
    });
    this.grassSpawnBG = d.createBindGroup({
      label: 'grass-spawn-bg',
      layout: grassComputeLayout,
      entries: [
        {binding: 0, resource: {buffer: this.grassParams}},
        {binding: 1, resource: {buffer: this.tileBuf}},
        {binding: 2, resource: {buffer: this.bladesNear}},
        {binding: 3, resource: {buffer: this.bladesFar}},
        {binding: 4, resource: {buffer: this.grassArgs}},
      ],
    });
    const bladeLayout = d.createBindGroupLayout({
      label: 'grass-blades-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: {type: 'read-only-storage'},
        },
      ],
    });
    const grassPL = d.createPipelineLayout({
      label: 'grass-draw-pl',
      bindGroupLayouts: [frameLayout, bladeLayout],
    });
    const gp = (label: string, entry: string) =>
      d.createRenderPipeline({
        label,
        layout: grassPL,
        vertex: {module: grassMod, entryPoint: entry},
        fragment: {
          module: grassMod,
          entryPoint: 'fs',
          targets: GBUFFER_TARGETS,
        },
        primitive: {topology: 'triangle-strip', cullMode: 'none'},
        depthStencil: depth,
      });
    this.grassNearPipe = gp('grass-near', 'vsNear');
    this.grassFarPipe = gp('grass-far', 'vsFar');
    this.grassNearBG = d.createBindGroup({
      label: 'grass-near-bg',
      layout: bladeLayout,
      entries: [{binding: 0, resource: {buffer: this.bladesNear}}],
    });
    this.grassFarBG = d.createBindGroup({
      label: 'grass-far-bg',
      layout: bladeLayout,
      entries: [{binding: 0, resource: {buffer: this.bladesFar}}],
    });
  }

  setWorld(biome: Biome, road: Road) {
    this.biome = biome;
    this.road = road;
    this.tileHeights.clear();
    const d = this.device;
    const S = biome.scatter;
    // Mesh library for this environment.
    const list: Array<{kind: VegKind; seed: number}> = [];
    const kinds = [...new Set(S.treeKinds)] as TreeKind[];
    const add = (kind: VegKind, n: number) => {
      const first = list.length;
      for (let i = 0; i < n; ++i)
        list.push({kind, seed: road.seed * 1000 + list.length * 17 + 3});
      return first;
    };
    const treeTypes: TypeDef[] = [];
    const smallTypes: TypeDef[] = [];
    const forestEdge = road.halfWidth + S.forestEdge;
    const dense = biome.id === 'forest';
    for (const k of kinds) {
      const n = k === 'cactus' ? 3 : 2;
      const first = add(k, n);
      const isCactus = k === 'cactus';
      treeTypes.push({
        mesh: first,
        variants: n,
        weight: isCactus
          ? S.cactus * 0.045
          : (S.trees / kinds.filter(x => x !== 'cactus').length) *
            (dense ? 1 : 0.9),
        cluster: isCactus ? 5 : dense ? 0 : 1,
        minRoad: isCactus ? road.halfWidth + 4 : forestEdge,
        maxSlope: 0.45,
        scaleMin: (isCactus ? 0.7 : 0.75) * TREE_SCALE[k],
        scaleMax: (isCactus ? 1.25 : 1.3) * TREE_SCALE[k],
      });
    }
    if (S.bushes > 0) {
      const first = add('bush', 2);
      smallTypes.push({
        mesh: first,
        variants: 2,
        weight: S.bushes * 0.1,
        cluster: 5,
        minRoad: road.halfWidth + 2.5,
        maxSlope: 0.5,
        scaleMin: 0.6,
        scaleMax: 1.5,
      });
    }
    if (S.hedges > 0) {
      const first = add('hedge', 2);
      smallTypes.push({
        mesh: first,
        variants: 2,
        weight: S.hedges * 0.9,
        cluster: 2,
        minRoad: road.halfWidth + 6,
        maxSlope: 0.5,
        scaleMin: 0.85,
        scaleMax: 1.2,
      });
    }
    if (S.rocks > 0) {
      const first = add('rock', 2);
      smallTypes.push({
        mesh: first,
        variants: 2,
        weight: S.rocks * 0.25,
        cluster: 4,
        minRoad: road.halfWidth + 1.8,
        maxSlope: 1,
        scaleMin: 0.25,
        scaleMax: biome.id === 'desert' ? 2.2 : 1.3,
      });
    }
    // Build and upload meshes.
    const built = list.map(e => buildVeg(e.kind, e.seed));
    let vCount = 0,
      iCount = 0;
    for (const m of built)
      for (const l of m.lods) {
        vCount += l.vertices.length / VEG_FLOATS;
        iCount += l.indices.length;
      }
    this.vbuf?.destroy();
    this.ibuf?.destroy();
    this.vbuf = d.createBuffer({
      label: 'veg-vertices',
      size: Math.max(16, vCount * VEG_FLOATS * 4),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.ibuf = d.createBuffer({
      label: 'veg-indices',
      size: Math.max(16, iCount * 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.meshes = [];
    let vo = 0,
      io = 0;
    const info = new Float32Array(MAX_MESHES * 4);
    this.argsTemplate.fill(0);
    built.forEach((m, mi) => {
      const g: MeshGPU = {
        mesh: m,
        firstIndex: [],
        indexCount: [],
        baseVertex: [],
      };
      for (const l of m.lods) {
        d.queue.writeBuffer(this.vbuf!, vo * VEG_FLOATS * 4, l.vertices);
        d.queue.writeBuffer(this.ibuf!, io * 4, l.indices);
        g.firstIndex.push(io);
        g.indexCount.push(l.indices.length);
        g.baseVertex.push(vo);
        vo += l.vertices.length / VEG_FLOATS;
        io += l.indices.length;
      }
      this.meshes.push(g);
      info.set([m.radius, m.center[1], m.height, 0], mi * 4);
      for (let l = 0; l < 2; ++l) {
        this.argsTemplate.set(
          [g.indexCount[l], 0, g.firstIndex[l], g.baseVertex[l], 0],
          (mi * 3 + l) * 5,
        );
      }
      this.argsTemplate.set([4, 0, 0, 0, 0], (mi * 3 + 2) * 5);
    });
    d.queue.writeBuffer(this.meshInfoBuf, 0, info);
    this.bakeImpostors(built);

    // Scatter layers.
    for (const l of this.layers) l.params.destroy();
    const mkLayer = (
      cell: number,
      lod0: number,
      lod1: number,
      maxDist: number,
      impostors: boolean,
      types: TypeDef[],
      seed: number,
    ): Layer => {
      const params = d.createBuffer({
        label: `veg-scatter-params-${seed}`,
        size: 512,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const layer: Layer = {
        cell,
        lod0,
        lod1,
        maxDist,
        impostors,
        types,
        seed,
        params,
      };
      layer.bg = d.createBindGroup({
        label: `veg-scatter-bg-${seed}`,
        layout: this.scatterLayout,
        entries: [
          {binding: 0, resource: {buffer: params}},
          {binding: 1, resource: {buffer: this.instBuf}},
          {binding: 2, resource: {buffer: this.argsBuf}},
          {binding: 3, resource: {buffer: this.meshInfoBuf}},
          {binding: 4, resource: {buffer: this.capsBuf}},
        ],
      });
      return layer;
    };
    this.layers = [];
    if (treeTypes.length) {
      this.layers.push(
        mkLayer(
          biome.id === 'forest' ? 5 : 6,
          55,
          200,
          2200,
          true,
          treeTypes,
          101,
        ),
      );
    }
    if (smallTypes.length) {
      this.layers.push(mkLayer(2.5, 30, 110, 180, false, smallTypes, 202));
    }
  }

  private bakeImpostors(built: VegMesh[]) {
    const d = this.device;
    const depth = d.createTexture({
      label: 'impostor-bake-depth',
      size: [IMP_RES, IMP_RES],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const enc = d.createCommandEncoder({label: 'impostor-bake'});
    built.forEach((m, mi) => {
      const ub = d.createBuffer({
        label: `impostor-bake-mesh-${mi}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      d.queue.writeBuffer(
        ub,
        0,
        new Float32Array([m.radius, m.center[1], m.height, 0]),
      );
      const bg1 = d.createBindGroup({
        label: `impostor-bake-bg1-${mi}`,
        layout: this.bakePipe.getBindGroupLayout(1),
        entries: [{binding: 5, resource: {buffer: ub}}],
      });
      const bg0 = d.createBindGroup({
        label: `impostor-bake-bg0-${mi}`,
        layout: this.bakePipe.getBindGroupLayout(0),
        entries: [{binding: 0, resource: {buffer: this.frame.buffer}}],
      });
      const view = (t: GPUTexture) =>
        t.createView({dimension: '2d', baseArrayLayer: mi, arrayLayerCount: 1});
      const pass = enc.beginRenderPass({
        label: `impostor-bake-${mi}`,
        colorAttachments: [
          {
            view: view(this.impAlbedo),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
          {
            view: view(this.impNormal),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0.5, 1, 0.5, 0],
          },
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      const g = this.meshes[mi];
      pass.setPipeline(this.bakePipe);
      pass.setBindGroup(0, bg0);
      pass.setBindGroup(1, bg1);
      pass.setVertexBuffer(0, this.vbuf!);
      pass.setIndexBuffer(this.ibuf!, 'uint32');
      pass.drawIndexed(
        g.indexCount[0],
        64,
        g.firstIndex[0],
        g.baseVertex[0],
        0,
      );
      pass.end();
    });
    d.queue.submit([enc.finish()]);
  }

  update(
    scene: SceneState,
    eye: number[],
    planes: Float32Array,
    ox: number,
    oz: number,
  ) {
    void scene;
    const d = this.device;
    d.queue.writeBuffer(this.argsBuf, 0, this.argsTemplate);
    for (const l of this.layers) {
      const cellW = l.cell;
      const R = l.maxDist;
      // Grid aligned to world cells.
      const wx0 = Math.floor((eye[0] + ox - R) / cellW) * cellW;
      const wz0 = Math.floor((eye[2] + oz - R) / cellW) * cellW;
      const dim = Math.ceil((2 * R) / cellW) + 1;
      const buf = new ArrayBuffer(512);
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      f[0] = wx0 - ox;
      f[1] = wz0 - oz;
      f[2] = cellW;
      u[3] = dim;
      f[4] = l.lod0;
      f[5] = l.lod1;
      f[6] = l.maxDist;
      u[7] = l.types.length;
      f.set(planes.subarray(0, 24), 8);
      l.types.slice(0, 8).forEach((t, i) => {
        const o = 32 + i * 8;
        u[o] = t.mesh;
        u[o + 1] = t.variants;
        f[o + 2] = t.weight;
        u[o + 3] = t.cluster;
        f[o + 4] = t.minRoad;
        f[o + 5] = t.maxSlope;
        f[o + 6] = t.scaleMin;
        f[o + 7] = t.scaleMax;
      });
      u[96] = l.seed;
      u[97] = l.impostors ? 1 : 0;
      d.queue.writeBuffer(l.params, 0, buf, 0, 400);
      (l as Layer & {dim: number}).dim = dim;
    }
    this.updateGrassTiles(eye, planes, ox, oz);
  }

  private updateGrassTiles(
    eye: number[],
    planes: Float32Array,
    ox: number,
    oz: number,
  ) {
    const road = this.road!;
    const R = 130;
    const cx = Math.floor((eye[0] + ox) / TILE),
      cz = Math.floor((eye[2] + oz) / TILE);
    const rt = Math.ceil(R / TILE);
    let n = 0;
    for (let tz = cz - rt; tz <= cz + rt; ++tz) {
      for (let tx = cx - rt; tx <= cx + rt; ++tx) {
        const wx = tx * TILE,
          wz = tz * TILE;
        const lx = wx - ox,
          lz = wz - oz;
        const dx = Math.max(lx - eye[0], 0, eye[0] - (lx + TILE));
        const dz = Math.max(lz - eye[2], 0, eye[2] - (lz + TILE));
        const dist = Math.hypot(dx, dz);
        if (dist > R) continue;
        const key = `${tx},${tz}`;
        let h = this.tileHeights.get(key);
        if (h === undefined) {
          h = road.terrainHeight(wx + TILE / 2, wz + TILE / 2);
          this.tileHeights.set(key, h);
        }
        if (!aabbInFrustum(planes, lx, h - 6, lz, lx + TILE, h + 6, lz + TILE))
          continue;
        if (n >= 4096) break;
        const bladeN = dist < 20 ? 64 : dist < 50 ? 32 : 16;
        this.tileData.set([lx, lz, bladeN, 0], n * 4);
        n++;
      }
    }
    if (this.tileHeights.size > 20000) this.tileHeights.clear();
    this.tileCount = n;
    this.device.queue.writeBuffer(this.tileBuf, 0, this.tileData, 0, n * 4);
    const gpBuf = new ArrayBuffer(112);
    const gf = new Float32Array(gpBuf);
    const gu = new Uint32Array(gpBuf);
    gf.set(planes.subarray(0, 24), 0);
    gu[24] = n;
    gu[25] = GRASS_CAP_NEAR;
    gu[26] = GRASS_CAP_FAR;
    this.device.queue.writeBuffer(this.grassParams, 0, gpBuf);
    this.device.queue.writeBuffer(
      this.grassArgs,
      0,
      new Uint32Array([7, 0, 0, 0, 3, 0, 0, 0]),
    );
  }

  encodeCompute(enc: GPUCommandEncoder, frameBG: GPUBindGroup) {
    if (!this.enabled) return;
    const pass = enc.beginComputePass({label: 'vegetation-scatter'});
    pass.setBindGroup(0, frameBG);
    pass.setPipeline(this.scatterPipe);
    for (const l of this.layers) {
      const dim = (l as Layer & {dim: number}).dim;
      pass.setBindGroup(1, l.bg!);
      pass.dispatchWorkgroups(Math.ceil(dim / 8), Math.ceil(dim / 8));
    }
    if (this.tileCount > 0 && this.biome!.scatter.grass > 0) {
      pass.setPipeline(this.grassSpawnPipe);
      pass.setBindGroup(1, this.grassSpawnBG);
      pass.dispatchWorkgroups(this.tileCount);
    }
    pass.end();
  }

  private drawMeshes(
    pass: GPURenderPassEncoder,
    lods: number[],
    shadow: boolean,
  ) {
    if (!this.vbuf || !this.meshes.length) return;
    pass.setBindGroup(1, this.meshBG);
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf!, 'uint32');
    for (const lod of lods) {
      if (lod === 2) {
        pass.setPipeline(shadow ? this.impShadowPipe : this.impPipe);
      } else {
        pass.setPipeline(shadow ? this.meshShadowPipe : this.meshPipe);
      }
      for (let m = 0; m < this.meshes.length; ++m) {
        const di = m * 3 + lod;
        pass.setBindGroup(3, this.drawInfoBG, [di * 256]);
        if (lod === 2) pass.drawIndirect(this.argsBuf, di * 20);
        else pass.drawIndexedIndirect(this.argsBuf, di * 20);
      }
    }
  }

  draw(pass: GPURenderPassEncoder, emptyBG: GPUBindGroup) {
    if (!this.enabled) return;
    pass.setBindGroup(2, emptyBG);
    this.drawMeshes(pass, [0, 1, 2], false);
    if (this.tileCount > 0 && this.biome!.scatter.grass > 0) {
      pass.setPipeline(this.grassNearPipe);
      pass.setBindGroup(1, this.grassNearBG);
      pass.drawIndirect(this.grassArgs, 0);
      pass.setPipeline(this.grassFarPipe);
      pass.setBindGroup(1, this.grassFarBG);
      pass.drawIndirect(this.grassArgs, 16);
    }
  }

  drawShadow(pass: GPURenderPassEncoder, cascade: number) {
    if (!this.enabled) return;
    this.drawMeshes(
      pass,
      cascade < 2 ? [0, 1] : cascade === 2 ? [0, 1, 2] : [1, 2],
      true,
    );
  }
}
