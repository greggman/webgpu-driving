// Render targets (HDR color, velocity, normals, depth) sized to the canvas.

export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
export const VELOCITY_FORMAT: GPUTextureFormat = 'rg16float';
export const NORMAL_FORMAT: GPUTextureFormat = 'rgba8unorm';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

export const GBUFFER_TARGETS: GPUColorTargetState[] = [
  {format: HDR_FORMAT},
  {format: VELOCITY_FORMAT},
  {format: NORMAL_FORMAT},
];

export class Targets {
  width = 0;
  height = 0;
  color!: GPUTexture;
  velocity!: GPUTexture;
  normal!: GPUTexture;
  depth!: GPUTexture;
  version = 0;

  constructor(private device: GPUDevice) {}

  resize(width: number, height: number): boolean {
    if (width === this.width && height === this.height) return false;
    this.width = width;
    this.height = height;
    for (const t of [this.color, this.velocity, this.normal, this.depth]) {
      t?.destroy();
    }
    const mk = (label: string, format: GPUTextureFormat) =>
      this.device.createTexture({
        label,
        size: [width, height],
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.color = mk('hdr-color', HDR_FORMAT);
    this.velocity = mk('velocity', VELOCITY_FORMAT);
    this.normal = mk('normal-rough', NORMAL_FORMAT);
    this.depth = mk('depth', DEPTH_FORMAT);
    this.version++;
    return true;
  }
}
