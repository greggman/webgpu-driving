// Atmosphere LUTs (transmittance, multi-scattering, sky-view, aerial
// perspective), SH ambient, cloud noise, and the sky draw.
import {shaderModule} from '../gpu/gpu';
import {ts} from '../gpu/profiler';
import {ATMO_PRELUDE, FRAME_PRELUDE, RENDER_PRELUDE} from './shaders';
import lutSrc from '../shaders/atmo_lut.wgsl';
import apSrc from '../shaders/atmo_ap.wgsl';
import shSrc from '../shaders/atmo_sh.wgsl';
import cloudGenSrc from '../shaders/clouds_gen.wgsl';
import skySrc from '../shaders/sky.wgsl';
import {FrameData} from './frameData';
import {GBUFFER_TARGETS} from './targets';

export class Atmosphere {
  readonly transLUT: GPUTexture;
  readonly msLUT: GPUTexture;
  readonly skyLUT: GPUTexture;
  readonly apLUT: GPUTexture;
  readonly cloudTex: GPUTexture;
  readonly shBuffer: GPUBuffer;
  private sampler: GPUSampler;
  private transPipe: GPUComputePipeline;
  private msPipe: GPUComputePipeline;
  private skyPipe: GPUComputePipeline;
  private apPipe: GPUComputePipeline;
  private shPipe: GPUComputePipeline;
  private transBG: GPUBindGroup;
  private msBG: GPUBindGroup;
  private skyBG: GPUBindGroup;
  private apBG: GPUBindGroup;
  private shBG: GPUBindGroup;
  skyDrawPipe!: GPURenderPipeline;
  private lutsDirty = true;
  private lastMie = -1;

  constructor(
    private device: GPUDevice,
    private frame: FrameData,
  ) {
    const tex = (
      label: string,
      w: number,
      h: number,
      d = 1,
      format: GPUTextureFormat = 'rgba16float',
    ) =>
      device.createTexture({
        label,
        size: [w, h, d],
        dimension: d > 1 ? '3d' : '2d',
        format,
        usage:
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.transLUT = tex('atmo-transmittance-lut', 256, 64);
    this.msLUT = tex('atmo-multiscatter-lut', 32, 32);
    this.skyLUT = tex('atmo-skyview-lut', 192, 108);
    this.apLUT = tex('atmo-aerial-perspective-lut', 32, 32, 32);
    this.cloudTex = device.createTexture({
      label: 'cloud-noise',
      size: [512, 512],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shBuffer = device.createBuffer({
      label: 'sky-sh9',
      size: 9 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.sampler = device.createSampler({
      label: 'atmo-lut-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const lutModule = shaderModule(
      device,
      ATMO_PRELUDE + '\n' + lutSrc,
      'atmo-lut',
    );
    const mk = (label: string, module: GPUShaderModule, entryPoint: string) =>
      device.createComputePipeline({
        label,
        layout: 'auto',
        compute: {module, entryPoint},
      });
    this.transPipe = mk('atmo-transmittance', lutModule, 'transmittance');
    this.msPipe = mk('atmo-multiscatter', lutModule, 'multiscatter');
    this.skyPipe = mk('atmo-skyview', lutModule, 'skyview');
    this.apPipe = mk(
      'atmo-aerial-perspective',
      shaderModule(device, ATMO_PRELUDE + '\n' + apSrc, 'atmo-ap'),
      'main',
    );
    this.shPipe = mk(
      'atmo-sh',
      shaderModule(device, RENDER_PRELUDE_SH(), 'atmo-sh'),
      'main',
    );

    const fb = {binding: 0, resource: {buffer: frame.buffer}};
    // Transmittance only uses F + output.
    this.transBG = device.createBindGroup({
      label: 'atmo-transmittance-bg',
      layout: this.transPipe.getBindGroupLayout(0),
      entries: [fb, {binding: 4, resource: this.transLUT.createView()}],
    });
    this.msBG = device.createBindGroup({
      label: 'atmo-multiscatter-bg',
      layout: this.msPipe.getBindGroupLayout(0),
      entries: [
        fb,
        {binding: 1, resource: this.transLUT.createView()},
        {binding: 3, resource: this.sampler},
        {binding: 4, resource: this.msLUT.createView()},
      ],
    });
    this.skyBG = device.createBindGroup({
      label: 'atmo-skyview-bg',
      layout: this.skyPipe.getBindGroupLayout(0),
      entries: [
        fb,
        {binding: 1, resource: this.transLUT.createView()},
        {binding: 2, resource: this.msLUT.createView()},
        {binding: 3, resource: this.sampler},
        {binding: 4, resource: this.skyLUT.createView()},
      ],
    });
    this.apBG = device.createBindGroup({
      label: 'atmo-ap-bg',
      layout: this.apPipe.getBindGroupLayout(0),
      entries: [
        fb,
        {binding: 1, resource: this.transLUT.createView()},
        {binding: 2, resource: this.msLUT.createView()},
        {binding: 3, resource: this.sampler},
        {binding: 4, resource: this.apLUT.createView()},
      ],
    });
    this.shBG = device.createBindGroup({
      label: 'atmo-sh-bg',
      layout: this.shPipe.getBindGroupLayout(0),
      entries: [
        fb,
        {binding: 1, resource: this.skyLUT.createView()},
        {binding: 2, resource: this.sampler},
        {binding: 3, resource: {buffer: this.shBuffer}},
      ],
    });

    // Cloud noise, generated once.
    const cloudPipe = mk(
      'cloud-noise-gen',
      shaderModule(device, FRAME_PRELUDE + '\n' + cloudGenSrc, 'cloud-gen'),
      'main',
    );
    const enc = device.createCommandEncoder({label: 'cloud-noise-gen'});
    const pass = enc.beginComputePass({label: 'cloud-noise-gen'});
    pass.setPipeline(cloudPipe);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        label: 'cloud-gen-bg',
        layout: cloudPipe.getBindGroupLayout(0),
        entries: [{binding: 1, resource: this.cloudTex.createView()}],
      }),
    );
    pass.dispatchWorkgroups(64, 64);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  createSkyPipeline(layout: GPUPipelineLayout) {
    const module = shaderModule(
      this.device,
      RENDER_PRELUDE + '\n' + skySrc,
      'sky',
    );
    this.skyDrawPipe = this.device.createRenderPipeline({
      label: 'sky-draw',
      layout,
      vertex: {module, entryPoint: 'vs'},
      fragment: {module, entryPoint: 'fs', targets: GBUFFER_TARGETS},
      primitive: {topology: 'triangle-list'},
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
    });
  }

  // mieScale changes -> LUTs must be rebuilt.
  setMie(mie: number) {
    if (mie !== this.lastMie) {
      this.lastMie = mie;
      this.lutsDirty = true;
    }
  }

  update(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({
      label: 'atmosphere',
      timestampWrites: ts('atmosphere'),
    });
    if (this.lutsDirty) {
      this.lutsDirty = false;
      pass.setPipeline(this.transPipe);
      pass.setBindGroup(0, this.transBG);
      pass.dispatchWorkgroups(256 / 8, 64 / 8);
      pass.setPipeline(this.msPipe);
      pass.setBindGroup(0, this.msBG);
      pass.dispatchWorkgroups(4, 4);
    }
    pass.setPipeline(this.skyPipe);
    pass.setBindGroup(0, this.skyBG);
    pass.dispatchWorkgroups(192 / 8, Math.ceil(108 / 8));
    pass.setPipeline(this.apPipe);
    pass.setBindGroup(0, this.apBG);
    pass.dispatchWorkgroups(4, 4);
    pass.setPipeline(this.shPipe);
    pass.setBindGroup(0, this.shBG);
    pass.dispatchWorkgroups(1);
    pass.end();
    // SH -> frame uniforms (after the queue's writeBuffer of this frame).
    enc.copyBufferToBuffer(
      this.shBuffer,
      0,
      this.frame.buffer,
      this.frame.offsetBytes('sh'),
      9 * 16,
    );
  }
}

function RENDER_PRELUDE_SH(): string {
  return FRAME_PRELUDE + '\n' + shSrc;
}
