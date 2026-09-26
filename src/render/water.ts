// Ocean (coast environment): Tessendorf FFT waves in two cascades (swell and
// chop) computed on the GPU every frame, rendered on a camera-centred polar
// grid (see water.wgsl).
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
import {Rng} from '../math/noise';
import {RENDER_PRELUDE} from './shaders';
import waterSrc from '../shaders/water.wgsl';
import fftSrc from '../shaders/ocean_fft.wgsl';
import {DEPTH_FORMAT, GBUFFER_TARGETS} from './targets';

const RINGS = 110;
const SEGS = 160;
const N = 256;
const MIPS = 9;
// Tile sizes (m) and the wavenumber that splits them (swell | chop).
const CASCADES = [512, 64];
const K_SPLIT = 0.8;
const CHOPPY = 1.1;

interface Cascade {
  size: number;
  h0: GPUBuffer;
  bufA: GPUBuffer;
  bufB: GPUBuffer;
  disp: GPUTexture;
  slope: GPUTexture;
  params: GPUBuffer[]; // [horizontal, vertical]
  bgSpectrum: GPUBindGroup;
  bgFft: GPUBindGroup[][]; // [dir][A/B]
  bgAssemble: GPUBindGroup;
  bgMips: GPUBindGroup[]; // disp then slope, per level
}

export class Water {
  private pipe!: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private bg!: GPUBindGroup;
  private paramsBuf: GPUBuffer;
  private cascades: Cascade[] = [];
  private spectrumPipe: GPUComputePipeline;
  private fftPipeA: GPUComputePipeline;
  private fftPipeB: GPUComputePipeline;
  private assemblePipe: GPUComputePipeline;
  private mipPipe: GPUComputePipeline;
  private windSpeed = -1;
  enabled = false;

  constructor(
    private device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
  ) {
    const d = device;
    const fftMod = shaderModule(d, fftSrc, 'ocean-fft');
    const mk = (entry: string) =>
      d.createComputePipeline({
        label: `ocean-${entry}`,
        layout: 'auto',
        compute: {module: fftMod, entryPoint: entry},
      });
    this.spectrumPipe = mk('spectrum');
    this.fftPipeA = mk('fftA');
    this.fftPipeB = mk('fftB');
    this.assemblePipe = mk('assemble');
    this.mipPipe = mk('mip');
    this.paramsBuf = d.createBuffer({
      label: 'ocean-render-params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(
      this.paramsBuf,
      0,
      new Float32Array([CASCADES[0], CASCADES[1], N, 0]),
    );
    const tex = {
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      texture: {},
    };
    this.layout = d.createBindGroupLayout({
      label: 'ocean-layout',
      entries: [
        {binding: 0, ...tex},
        {binding: 1, ...tex},
        {binding: 2, ...tex},
        {binding: 3, ...tex},
        {
          binding: 4,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {type: 'uniform'},
        },
      ],
    });
    const module = shaderModule(d, RENDER_PRELUDE + '\n' + waterSrc, 'water');
    deferRenderPipeline(
      d,
      {
        label: 'ocean',
        layout: d.createPipelineLayout({
          label: 'ocean-pl',
          bindGroupLayouts: [frameLayout, this.layout],
        }),
        vertex: {module, entryPoint: 'vs'},
        fragment: {module, entryPoint: 'fs', targets: GBUFFER_TARGETS},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
        },
      },
      p => (this.pipe = p),
    );
    for (const size of CASCADES) this.cascades.push(this.makeCascade(size));
    this.bg = d.createBindGroup({
      label: 'ocean-bg',
      layout: this.layout,
      entries: [
        {binding: 0, resource: this.cascades[0].disp.createView()},
        {binding: 1, resource: this.cascades[0].slope.createView()},
        {binding: 2, resource: this.cascades[1].disp.createView()},
        {binding: 3, resource: this.cascades[1].slope.createView()},
        {binding: 4, resource: {buffer: this.paramsBuf}},
      ],
    });
  }

  private makeCascade(size: number): Cascade {
    const d = this.device;
    const buf = (label: string, usage: number) =>
      d.createBuffer({label, size: N * N * 16, usage});
    const S = GPUBufferUsage.STORAGE;
    const h0 = buf(`ocean-h0-${size}`, S | GPUBufferUsage.COPY_DST);
    const bufA = buf(`ocean-fft-a-${size}`, S);
    const bufB = buf(`ocean-fft-b-${size}`, S);
    const texDesc = (label: string): GPUTextureDescriptor => ({
      label,
      size: [N, N],
      mipLevelCount: MIPS,
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const disp = d.createTexture(texDesc(`ocean-displacement-${size}`));
    const slope = d.createTexture(texDesc(`ocean-slope-${size}`));
    const params = [0, 1].map(v => {
      const b = d.createBuffer({
        label: `ocean-params-${size}-${v}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      return b;
    });
    const bg = (
      pipe: GPUComputePipeline,
      label: string,
      entries: GPUBindGroupEntry[],
    ) =>
      d.createBindGroup({label, layout: pipe.getBindGroupLayout(0), entries});
    const u = (i: number) => ({binding: 0, resource: {buffer: params[i]}});
    const mipView = (t: GPUTexture, m: number) =>
      t.createView({baseMipLevel: m, mipLevelCount: 1});
    const bgMips: GPUBindGroup[] = [];
    for (const t of [disp, slope]) {
      for (let m = 1; m < MIPS; ++m) {
        bgMips.push(
          bg(this.mipPipe, `ocean-mip-${size}-${m}`, [
            {binding: 6, resource: mipView(t, m - 1)},
            {binding: 7, resource: mipView(t, m)},
          ]),
        );
      }
    }
    return {
      size,
      h0,
      bufA,
      bufB,
      disp,
      slope,
      params,
      bgSpectrum: bg(this.spectrumPipe, `ocean-spectrum-${size}`, [
        u(0),
        {binding: 1, resource: {buffer: h0}},
        {binding: 2, resource: {buffer: bufA}},
        {binding: 3, resource: {buffer: bufB}},
      ]),
      bgFft: [0, 1].map(dir => [
        bg(this.fftPipeA, `ocean-fft-a-${size}-${dir}`, [
          u(dir),
          {binding: 2, resource: {buffer: bufA}},
          {binding: 3, resource: {buffer: bufB}},
        ]),
        bg(this.fftPipeB, `ocean-fft-b-${size}-${dir}`, [
          u(dir),
          {binding: 2, resource: {buffer: bufA}},
          {binding: 3, resource: {buffer: bufB}},
        ]),
      ]),
      bgAssemble: bg(this.assemblePipe, `ocean-assemble-${size}`, [
        u(0),
        {binding: 2, resource: {buffer: bufA}},
        {binding: 3, resource: {buffer: bufB}},
        {binding: 4, resource: mipView(disp, 0)},
        {binding: 5, resource: mipView(slope, 0)},
      ]),
      bgMips,
    };
  }

  // Phillips spectrum with directional spreading, split between cascades by
  // wavenumber and normalised to a target significant wave height.
  private buildSpectra(wind: number, dirX: number, dirZ: number) {
    const V = 5 + 9 * wind; // wind speed (m/s)
    const Lw = (V * V) / 9.81;
    const wl = Math.hypot(dirX, dirZ) || 1;
    const wx = dirX / wl,
      wz = dirZ / wl;
    const rng = new Rng(4242);
    const gauss = () => {
      const u = Math.max(rng.next(), 1e-9),
        v = rng.next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const phillips = (kx: number, kz: number) => {
      const k2 = kx * kx + kz * kz;
      if (k2 < 1e-12) return 0;
      const k = Math.sqrt(k2);
      const cosT = (kx * wx + kz * wz) / k;
      let dirF = cosT * cosT;
      if (cosT < 0) dirF *= 0.07; // little energy against the wind
      const small = 0.05; // suppress tiny capillary waves
      return (
        (Math.exp(-1 / (k2 * Lw * Lw)) / (k2 * k2)) *
        dirF *
        Math.exp(-k2 * small * small)
      );
    };
    const data = CASCADES.map(() => new Float32Array(N * N * 4));
    let variance = 0;
    CASCADES.forEach((size, ci) => {
      const dk = (2 * Math.PI) / size;
      const amp = (kx: number, kz: number) => {
        const k = Math.hypot(kx, kz);
        const inBand = ci === 0 ? k < K_SPLIT : k >= K_SPLIT;
        return inBand ? Math.sqrt(phillips(kx, kz) * dk * dk * 0.5) : 0;
      };
      const out = data[ci];
      for (let j = 0; j < N; ++j) {
        for (let i = 0; i < N; ++i) {
          const kx = (i - N / 2) * dk,
            kz = (j - N / 2) * dk;
          const a = amp(kx, kz),
            b = amp(-kx, -kz);
          const hr = gauss() * a,
            hi = gauss() * a;
          const mr = gauss() * b,
            mi = gauss() * b;
          // h0(k), conj(h0(-k))
          out.set([hr, hi, mr, -mi], (j * N + i) * 4);
          variance += hr * hr + hi * hi;
        }
      }
    });
    // Target significant wave height ~1.4 m (sigma = Hs / 4).
    const sigma = 0.35 + 0.25 * wind;
    const scale = sigma / Math.sqrt(Math.max(variance, 1e-12));
    CASCADES.forEach((_, ci) => {
      const out = data[ci];
      for (let i = 0; i < out.length; ++i) out[i] *= scale;
      this.device.queue.writeBuffer(this.cascades[ci].h0, 0, out);
    });
  }

  setWind(wind: number) {
    if (wind !== this.windSpeed) {
      this.windSpeed = wind;
      this.buildSpectra(wind, 0.8, 0.6);
    }
  }

  encode(enc: GPUCommandEncoder, time: number) {
    if (!this.enabled) return;
    const d = this.device;
    for (const c of this.cascades) {
      d.queue.writeBuffer(
        c.params[0],
        0,
        new Float32Array([c.size, time, CHOPPY, 0]),
      );
      const v = new ArrayBuffer(16);
      new Float32Array(v).set([c.size, time, CHOPPY]);
      new Uint32Array(v)[3] = 1;
      d.queue.writeBuffer(c.params[1], 0, v);
    }
    const pass = enc.beginComputePass({label: 'ocean-fft'});
    for (const c of this.cascades) {
      pass.setPipeline(this.spectrumPipe);
      pass.setBindGroup(0, c.bgSpectrum);
      pass.dispatchWorkgroups(N / 16, N / 16);
      for (const dir of [0, 1]) {
        pass.setPipeline(this.fftPipeA);
        pass.setBindGroup(0, c.bgFft[dir][0]);
        pass.dispatchWorkgroups(N);
        pass.setPipeline(this.fftPipeB);
        pass.setBindGroup(0, c.bgFft[dir][1]);
        pass.dispatchWorkgroups(N);
      }
      pass.setPipeline(this.assemblePipe);
      pass.setBindGroup(0, c.bgAssemble);
      pass.dispatchWorkgroups(N / 16, N / 16);
      pass.setPipeline(this.mipPipe);
      let k = 0;
      for (let t = 0; t < 2; ++t) {
        for (let m = 1; m < MIPS; ++m) {
          const s = Math.max(1, N >> m);
          pass.setBindGroup(0, c.bgMips[k++]);
          pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8));
        }
      }
    }
    pass.end();
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.enabled) return;
    pass.setPipeline(this.pipe);
    pass.setBindGroup(1, this.bg);
    pass.draw(RINGS * SEGS * 6);
  }
}
