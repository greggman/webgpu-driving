// Post-processing chain:
//   AO (multiplied into HDR) -> TAA -> motion blur -> depth of field ->
//   auto exposure -> bloom -> tonemap/grade/composite to the swapchain.
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
import {ts} from '../gpu/profiler';
import {FRAME_PRELUDE} from './shaders';
import fullscreen from '../shaders/post/fullscreen.wgsl';
import taaSrc from '../shaders/post/taa.wgsl';
import bloomSrc from '../shaders/post/bloom.wgsl';
import tonemapSrc from '../shaders/post/tonemap.wgsl';
import exposureSrc from '../shaders/post/exposure.wgsl';
import aoSrc from '../shaders/post/ao.wgsl';
import mbSrc from '../shaders/post/motionblur.wgsl';
import dofSrc from '../shaders/post/dof.wgsl';
import {FrameData} from './frameData';
import {HDR_FORMAT, Targets} from './targets';

const BLOOM_LEVELS = 6;

export interface PostSettings {
  dt: number;
  exposureBias: number;
  focus: number;
  aperture: number;
  near: number;
  motionBlur: number; // shutter fraction (0.5 = 180 degrees)
  bloom: boolean;
}

export class Post {
  private history: GPUTexture[] = [];
  private histIdx = 0;
  private postA!: GPUTexture;
  private postB!: GPUTexture;
  private bloomMips: GPUTexture[] = [];
  private sampler: GPUSampler;
  private aoPipe!: GPURenderPipeline;
  private taaPipe!: GPURenderPipeline;
  private mbPipe!: GPURenderPipeline;
  private dofPipe!: GPURenderPipeline;
  private downPipe!: GPURenderPipeline;
  private upPipe!: GPURenderPipeline;
  private tonePipe!: GPURenderPipeline;
  private expBuildPipe: GPUComputePipeline;
  private expResolvePipe: GPUComputePipeline;
  private histoBuf: GPUBuffer;
  readonly exposureBuf: GPUBuffer;
  private taaParams: GPUBuffer;
  private expParams: GPUBuffer;
  private bloomParams: GPUBuffer;
  private mbParams: GPUBuffer;
  private dofParams: GPUBuffer;
  private aoBG!: GPUBindGroup;
  private taaBGs: GPUBindGroup[] = [];
  private mbBGs: GPUBindGroup[] = [];
  private dofBG!: GPUBindGroup;
  private bloomDownBGs: GPUBindGroup[] = [];
  private bloomUpBGs: GPUBindGroup[] = [];
  private toneBG!: GPUBindGroup;
  private expBG!: GPUBindGroup;
  private expResolveBG: GPUBindGroup;
  private version = -1;
  resetHistory = true;
  resetExposure = true;
  aoEnabled = true;

  constructor(
    private device: GPUDevice,
    private frame: FrameData,
    private targets: Targets,
    swapFormat: GPUTextureFormat,
  ) {
    this.sampler = device.createSampler({
      label: 'post-linear-clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const pre = FRAME_PRELUDE + '\n' + fullscreen + '\n';
    const mod = (src: string, label: string) =>
      shaderModule(device, pre + src, label);
    const mk = (
      label: string,
      module: GPUShaderModule,
      entry: string,
      format: GPUTextureFormat,
      assign: (p: GPURenderPipeline) => void,
      blend?: GPUBlendState,
    ) =>
      deferRenderPipeline(
        device,
        {
          label,
          layout: 'auto',
          vertex: {module, entryPoint: 'vsFull'},
          fragment: {module, entryPoint: entry, targets: [{format, blend}]},
          primitive: {topology: 'triangle-list'},
        },
        assign,
      );
    const bloomMod = mod(bloomSrc, 'bloom');
    mk('ssao', mod(aoSrc, 'ssao'), 'fs', HDR_FORMAT, p => (this.aoPipe = p), {
      color: {srcFactor: 'dst', dstFactor: 'zero', operation: 'add'},
      alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'},
    });
    mk('taa', mod(taaSrc, 'taa'), 'fs', HDR_FORMAT, p => (this.taaPipe = p));
    mk(
      'motion-blur',
      mod(mbSrc, 'motion-blur'),
      'fs',
      HDR_FORMAT,
      p => (this.mbPipe = p),
    );
    mk('dof', mod(dofSrc, 'dof'), 'fs', HDR_FORMAT, p => (this.dofPipe = p));
    mk('bloom-down', bloomMod, 'down', HDR_FORMAT, p => (this.downPipe = p));
    mk('bloom-up', bloomMod, 'up', HDR_FORMAT, p => (this.upPipe = p), {
      color: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
      alpha: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
    });
    mk(
      'tonemap',
      mod(tonemapSrc, 'tonemap'),
      'fs',
      swapFormat,
      p => (this.tonePipe = p),
    );
    const expMod = shaderModule(
      device,
      FRAME_PRELUDE + '\n' + exposureSrc,
      'exposure',
    );
    this.expBuildPipe = device.createComputePipeline({
      label: 'exposure-histogram',
      layout: 'auto',
      compute: {module: expMod, entryPoint: 'build'},
    });
    this.expResolvePipe = device.createComputePipeline({
      label: 'exposure-resolve',
      layout: 'auto',
      compute: {module: expMod, entryPoint: 'resolve'},
    });
    const buf = (label: string, size: number, usage: GPUBufferUsageFlags) =>
      device.createBuffer({label, size, usage});
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.histoBuf = buf('exposure-histogram', 256, GPUBufferUsage.STORAGE);
    this.exposureBuf = buf(
      'exposure-value',
      16,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    );
    this.taaParams = buf('taa-params', 16, U);
    this.expParams = buf('exposure-params', 16, U);
    this.bloomParams = buf('bloom-params', 256 * BLOOM_LEVELS * 2, U);
    this.mbParams = buf('motion-blur-params', 16, U);
    this.dofParams = buf('dof-params', 16, U);
    this.expResolveBG = device.createBindGroup({
      label: 'exposure-resolve-bg',
      layout: this.expResolvePipe.getBindGroupLayout(0),
      entries: [
        {binding: 2, resource: {buffer: this.histoBuf}},
        {binding: 3, resource: {buffer: this.exposureBuf}},
        {binding: 4, resource: {buffer: this.expParams}},
      ],
    });
  }

  private rebuild() {
    const d = this.device;
    const {width, height} = this.targets;
    for (const t of [...this.history, ...this.bloomMips]) t.destroy();
    this.postA?.destroy();
    this.postB?.destroy();
    const hdr = (label: string, w = width, h = height) =>
      d.createTexture({
        label,
        size: [w, h],
        format: HDR_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.history = [hdr('taa-history-0'), hdr('taa-history-1')];
    this.postA = hdr('post-motion-blur');
    this.postB = hdr('post-dof');
    this.bloomMips = [];
    let w = width,
      h = height;
    for (let i = 0; i < BLOOM_LEVELS; ++i) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.bloomMips.push(hdr(`bloom-mip-${i}`, w, h));
    }
    const t = this.targets;
    const fb = {binding: 0, resource: {buffer: this.frame.buffer}};
    const bg = (
      label: string,
      pipe: GPURenderPipeline,
      entries: GPUBindGroupEntry[],
    ) =>
      d.createBindGroup({label, layout: pipe.getBindGroupLayout(0), entries});
    this.aoBG = bg('ssao-bg', this.aoPipe, [
      fb,
      {binding: 1, resource: t.depth.createView()},
      {binding: 2, resource: t.normal.createView()},
    ]);
    this.taaBGs = [0, 1].map(i =>
      bg(`taa-bg-${i}`, this.taaPipe, [
        {binding: 1, resource: t.color.createView()},
        {binding: 2, resource: this.history[1 - i].createView()},
        {binding: 3, resource: t.velocity.createView()},
        {binding: 4, resource: t.depth.createView()},
        {binding: 5, resource: this.sampler},
        {binding: 6, resource: {buffer: this.taaParams}},
      ]),
    );
    this.mbBGs = [0, 1].map(i =>
      bg(`motion-blur-bg-${i}`, this.mbPipe, [
        fb,
        {binding: 1, resource: this.history[i].createView()},
        {binding: 2, resource: t.velocity.createView()},
        {binding: 3, resource: t.depth.createView()},
        {binding: 4, resource: this.sampler},
        {binding: 5, resource: {buffer: this.mbParams}},
      ]),
    );
    this.dofBG = bg('dof-bg', this.dofPipe, [
      {binding: 1, resource: this.postA.createView()},
      {binding: 2, resource: t.depth.createView()},
      {binding: 3, resource: this.sampler},
      {binding: 4, resource: {buffer: this.dofParams}},
    ]);
    // Bloom chain from the final HDR image (postB).
    const params = new Float32Array(BLOOM_LEVELS * 2 * 64);
    this.bloomDownBGs = [];
    this.bloomUpBGs = [];
    for (let i = 0; i < BLOOM_LEVELS; ++i) {
      const src = i === 0 ? this.postB : this.bloomMips[i - 1];
      params.set([1 / src.width, 1 / src.height, 1, i === 0 ? 1 : 0], i * 64);
      this.bloomDownBGs.push(
        bg(`bloom-down-bg-${i}`, this.downPipe, [
          {binding: 3, resource: src.createView()},
          {binding: 4, resource: this.sampler},
          {
            binding: 5,
            resource: {buffer: this.bloomParams, offset: i * 256, size: 16},
          },
        ]),
      );
    }
    for (let i = 0; i < BLOOM_LEVELS - 1; ++i) {
      const src = this.bloomMips[i + 1];
      params.set(
        [1 / src.width, 1 / src.height, 1, 0],
        (BLOOM_LEVELS + i) * 64,
      );
      this.bloomUpBGs.push(
        bg(`bloom-up-bg-${i}`, this.upPipe, [
          {binding: 3, resource: src.createView()},
          {binding: 4, resource: this.sampler},
          {
            binding: 5,
            resource: {
              buffer: this.bloomParams,
              offset: (BLOOM_LEVELS + i) * 256,
              size: 16,
            },
          },
        ]),
      );
    }
    d.queue.writeBuffer(this.bloomParams, 0, params);
    this.toneBG = bg('tonemap-bg', this.tonePipe, [
      fb,
      {binding: 1, resource: this.postB.createView()},
      {binding: 2, resource: this.bloomMips[0].createView()},
      {binding: 3, resource: this.sampler},
      {binding: 4, resource: {buffer: this.exposureBuf}},
    ]);
    this.expBG = d.createBindGroup({
      label: 'exposure-build-bg',
      layout: this.expBuildPipe.getBindGroupLayout(0),
      entries: [
        {binding: 1, resource: this.postB.createView()},
        {binding: 2, resource: {buffer: this.histoBuf}},
      ],
    });
    this.version = this.targets.version;
    this.resetHistory = true;
  }

  encode(enc: GPUCommandEncoder, swapView: GPUTextureView, s: PostSettings) {
    if (this.version !== this.targets.version) this.rebuild();
    const d = this.device;
    const cur = this.histIdx;
    const f32 = (a: number[]) => new Float32Array(a);
    d.queue.writeBuffer(
      this.taaParams,
      0,
      f32([this.resetHistory ? 1 : 0, 0, 0, 0]),
    );
    d.queue.writeBuffer(
      this.expParams,
      0,
      f32([s.dt, this.resetExposure ? 1 : 0, s.exposureBias, 0]),
    );
    d.queue.writeBuffer(this.mbParams, 0, f32([s.motionBlur, 0, 0, 0]));
    const maxCoc = Math.min(18, this.targets.height / 50);
    d.queue.writeBuffer(
      this.dofParams,
      0,
      f32([s.focus, s.aperture, maxCoc, s.near]),
    );
    this.resetHistory = false;
    this.resetExposure = false;

    const pass = (
      label: string,
      view: GPUTextureView,
      pipe: GPURenderPipeline,
      bg: GPUBindGroup,
      load: GPULoadOp = 'clear',
    ) => {
      const p = enc.beginRenderPass({
        label,
        timestampWrites: ts(label.startsWith('bloom') ? 'bloom' : label),
        colorAttachments: [
          {view, loadOp: load, storeOp: 'store', clearValue: [0, 0, 0, 1]},
        ],
      });
      p.setPipeline(pipe);
      p.setBindGroup(0, bg);
      p.draw(3);
      p.end();
    };
    if (this.aoEnabled) {
      pass(
        'ssao',
        this.targets.color.createView(),
        this.aoPipe,
        this.aoBG,
        'load',
      );
    }
    pass('taa', this.history[cur].createView(), this.taaPipe, this.taaBGs[cur]);
    pass('motion-blur', this.postA.createView(), this.mbPipe, this.mbBGs[cur]);
    pass('dof', this.postB.createView(), this.dofPipe, this.dofBG);

    const cp = enc.beginComputePass({
      label: 'auto-exposure',
      timestampWrites: ts('exposure'),
    });
    cp.setPipeline(this.expBuildPipe);
    cp.setBindGroup(0, this.expBG);
    cp.dispatchWorkgroups(
      Math.ceil(this.targets.width / 64),
      Math.ceil(this.targets.height / 64),
    );
    cp.setPipeline(this.expResolvePipe);
    cp.setBindGroup(0, this.expResolveBG);
    cp.dispatchWorkgroups(1);
    cp.end();

    for (let i = 0; i < BLOOM_LEVELS; ++i) {
      pass(
        `bloom-down-${i}`,
        this.bloomMips[i].createView(),
        this.downPipe,
        this.bloomDownBGs[i],
      );
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; --i) {
      pass(
        `bloom-up-${i}`,
        this.bloomMips[i].createView(),
        this.upPipe,
        this.bloomUpBGs[i],
        'load',
      );
    }
    pass('tonemap', swapView, this.tonePipe, this.toneBG);
    this.histIdx = 1 - cur;
  }
}
