// Post-processing: TAA -> auto exposure -> bloom -> tonemap/composite.
import {shaderModule} from '../gpu/gpu';
import {FRAME_PRELUDE} from './shaders';
import fullscreen from '../shaders/post/fullscreen.wgsl';
import taaSrc from '../shaders/post/taa.wgsl';
import bloomSrc from '../shaders/post/bloom.wgsl';
import tonemapSrc from '../shaders/post/tonemap.wgsl';
import exposureSrc from '../shaders/post/exposure.wgsl';
import {FrameData} from './frameData';
import {HDR_FORMAT, Targets} from './targets';

const BLOOM_LEVELS = 6;

export class Post {
  private history: GPUTexture[] = [];
  private histIdx = 0;
  private bloomMips: GPUTexture[] = [];
  private sampler: GPUSampler;
  private taaPipe: GPURenderPipeline;
  private downPipe: GPURenderPipeline;
  private upPipe: GPURenderPipeline;
  private tonePipe: GPURenderPipeline;
  private expBuildPipe: GPUComputePipeline;
  private expResolvePipe: GPUComputePipeline;
  private histoBuf: GPUBuffer;
  readonly exposureBuf: GPUBuffer;
  private taaParams: GPUBuffer;
  private expParams: GPUBuffer;
  private bloomParams: GPUBuffer;
  private taaBGs: GPUBindGroup[] = [];
  private bloomDownBGs: GPUBindGroup[] = [];
  private bloomUpBGs: GPUBindGroup[] = [];
  private toneBGs: GPUBindGroup[] = [];
  private expBGs: GPUBindGroup[] = [];
  private expResolveBG!: GPUBindGroup;
  private version = -1;
  resetHistory = true;
  resetExposure = true;

  constructor(
    private device: GPUDevice,
    private frame: FrameData,
    private targets: Targets,
    private swapFormat: GPUTextureFormat,
  ) {
    this.sampler = device.createSampler({
      label: 'post-linear-clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const pre = FRAME_PRELUDE + '\n' + fullscreen + '\n';
    const taaMod = shaderModule(device, pre + taaSrc, 'taa');
    const bloomMod = shaderModule(
      device,
      FRAME_PRELUDE + '\n' + fullscreen + '\n' + bloomSrc,
      'bloom',
    );
    const toneMod = shaderModule(device, pre + tonemapSrc, 'tonemap');
    const mk = (
      label: string,
      module: GPUShaderModule,
      entry: string,
      format: GPUTextureFormat,
      blend?: GPUBlendState,
    ) =>
      device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: {module, entryPoint: 'vsFull'},
        fragment: {module, entryPoint: entry, targets: [{format, blend}]},
        primitive: {topology: 'triangle-list'},
      });
    this.taaPipe = mk('taa', taaMod, 'fs', HDR_FORMAT);
    this.downPipe = mk('bloom-down', bloomMod, 'down', HDR_FORMAT);
    this.upPipe = mk('bloom-up', bloomMod, 'up', HDR_FORMAT, {
      color: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
      alpha: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
    });
    this.tonePipe = mk('tonemap', toneMod, 'fs', swapFormat);
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
    this.histoBuf = device.createBuffer({
      label: 'exposure-histogram',
      size: 64 * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    this.exposureBuf = device.createBuffer({
      label: 'exposure-value',
      size: 16,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    this.taaParams = device.createBuffer({
      label: 'taa-params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.expParams = device.createBuffer({
      label: 'exposure-params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bloomParams = device.createBuffer({
      label: 'bloom-params',
      size: 256 * BLOOM_LEVELS * 2,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
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
    this.history = [0, 1].map(i =>
      d.createTexture({
        label: `taa-history-${i}`,
        size: [width, height],
        format: HDR_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.bloomMips = [];
    let w = width,
      h = height;
    for (let i = 0; i < BLOOM_LEVELS; ++i) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.bloomMips.push(
        d.createTexture({
          label: `bloom-mip-${i}`,
          size: [w, h],
          format: HDR_FORMAT,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
    }
    const fb = {binding: 0, resource: {buffer: this.frame.buffer}};
    this.taaBGs = [0, 1].map(i =>
      d.createBindGroup({
        label: `taa-bg-${i}`,
        layout: this.taaPipe.getBindGroupLayout(0),
        entries: [
          {binding: 1, resource: this.targets.color.createView()},
          {binding: 2, resource: this.history[1 - i].createView()},
          {binding: 3, resource: this.targets.velocity.createView()},
          {binding: 4, resource: this.targets.depth.createView()},
          {binding: 5, resource: this.sampler},
          {binding: 6, resource: {buffer: this.taaParams}},
        ],
      }),
    );
    // Bloom: down i reads (i==0 ? history : mip[i-1]) writes mip[i].
    this.bloomDownBGs = [];
    this.bloomUpBGs = [];
    const params = new Float32Array(BLOOM_LEVELS * 2 * 64);
    for (let i = 0; i < BLOOM_LEVELS; ++i) {
      const srcW = i === 0 ? width : this.bloomMips[i - 1].width;
      const srcH = i === 0 ? height : this.bloomMips[i - 1].height;
      params.set([1 / srcW, 1 / srcH, 1, i === 0 ? 1 : 0], i * 64);
      // Up: reads mip[i+1] writes mip[i] (i from L-2 down to 0).
      const upSrc = this.bloomMips[Math.min(i + 1, BLOOM_LEVELS - 1)];
      params.set(
        [1 / upSrc.width, 1 / upSrc.height, 1.0, 0],
        (BLOOM_LEVELS + i) * 64,
      );
    }
    d.queue.writeBuffer(this.bloomParams, 0, params);
    for (let h = 0; h < 2; ++h) {
      const list: GPUBindGroup[] = [];
      for (let i = 0; i < BLOOM_LEVELS; ++i) {
        const src = i === 0 ? this.history[h] : this.bloomMips[i - 1];
        list.push(
          d.createBindGroup({
            label: `bloom-down-bg-${h}-${i}`,
            layout: this.downPipe.getBindGroupLayout(0),
            entries: [
              {binding: 3, resource: src.createView()},
              {binding: 4, resource: this.sampler},
              {
                binding: 5,
                resource: {buffer: this.bloomParams, offset: i * 256, size: 16},
              },
            ],
          }),
        );
      }
      this.bloomDownBGs.push(...(h === 0 ? list : []));
      if (h === 1) this.bloomDownBGs.push(...list);
    }
    for (let i = 0; i < BLOOM_LEVELS - 1; ++i) {
      this.bloomUpBGs.push(
        d.createBindGroup({
          label: `bloom-up-bg-${i}`,
          layout: this.upPipe.getBindGroupLayout(0),
          entries: [
            {binding: 3, resource: this.bloomMips[i + 1].createView()},
            {binding: 4, resource: this.sampler},
            {
              binding: 5,
              resource: {
                buffer: this.bloomParams,
                offset: (BLOOM_LEVELS + i) * 256,
                size: 16,
              },
            },
          ],
        }),
      );
    }
    this.toneBGs = [0, 1].map(i =>
      d.createBindGroup({
        label: `tonemap-bg-${i}`,
        layout: this.tonePipe.getBindGroupLayout(0),
        entries: [
          fb,
          {binding: 1, resource: this.history[i].createView()},
          {binding: 2, resource: this.bloomMips[0].createView()},
          {binding: 3, resource: this.sampler},
          {binding: 4, resource: {buffer: this.exposureBuf}},
        ],
      }),
    );
    this.expBGs = [0, 1].map(i =>
      d.createBindGroup({
        label: `exposure-build-bg-${i}`,
        layout: this.expBuildPipe.getBindGroupLayout(0),
        entries: [
          {binding: 1, resource: this.history[i].createView()},
          {binding: 2, resource: {buffer: this.histoBuf}},
        ],
      }),
    );
    this.version = this.targets.version;
    this.resetHistory = true;
  }

  encode(
    enc: GPUCommandEncoder,
    swapView: GPUTextureView,
    dt: number,
    exposureBias: number,
  ) {
    if (this.version !== this.targets.version) this.rebuild();
    const d = this.device;
    const cur = this.histIdx;
    d.queue.writeBuffer(
      this.taaParams,
      0,
      new Float32Array([this.resetHistory ? 1 : 0, 0, 0, 0]),
    );
    d.queue.writeBuffer(
      this.expParams,
      0,
      new Float32Array([dt, this.resetExposure ? 1 : 0, exposureBias, 0]),
    );
    this.resetHistory = false;
    this.resetExposure = false;

    const fullscreenPass = (
      label: string,
      view: GPUTextureView,
      pipe: GPURenderPipeline,
      bg: GPUBindGroup,
      load: GPULoadOp = 'clear',
    ) => {
      const p = enc.beginRenderPass({
        label,
        colorAttachments: [
          {view, loadOp: load, storeOp: 'store', clearValue: [0, 0, 0, 1]},
        ],
      });
      p.setPipeline(pipe);
      p.setBindGroup(0, bg);
      p.draw(3);
      p.end();
    };
    // TAA resolve into history[cur] (reads history[1-cur]).
    fullscreenPass(
      'taa',
      this.history[cur].createView(),
      this.taaPipe,
      this.taaBGs[cur],
    );

    // Auto exposure from the resolved frame.
    const cp = enc.beginComputePass({label: 'auto-exposure'});
    cp.setPipeline(this.expBuildPipe);
    cp.setBindGroup(0, this.expBGs[cur]);
    cp.dispatchWorkgroups(
      Math.ceil(this.targets.width / 64),
      Math.ceil(this.targets.height / 64),
    );
    cp.setPipeline(this.expResolvePipe);
    cp.setBindGroup(0, this.expResolveBG);
    cp.dispatchWorkgroups(1);
    cp.end();

    // Bloom.
    for (let i = 0; i < BLOOM_LEVELS; ++i) {
      fullscreenPass(
        `bloom-down-${i}`,
        this.bloomMips[i].createView(),
        this.downPipe,
        this.bloomDownBGs[cur * BLOOM_LEVELS + i],
      );
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; --i) {
      fullscreenPass(
        `bloom-up-${i}`,
        this.bloomMips[i].createView(),
        this.upPipe,
        this.bloomUpBGs[i],
        'load',
      );
    }
    fullscreenPass('tonemap', swapView, this.tonePipe, this.toneBGs[cur]);
    this.histIdx = 1 - cur;
  }
}
