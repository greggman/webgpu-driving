// CPU-side mirror of the WGSL Frame struct (src/shaders/frame.wgsl) plus the
// shared group-0 bind group layout used by every render pipeline.

const FRAME_FIELDS: Array<[string, number]> = [
  ['viewProj', 16],
  ['viewProjNJ', 16],
  ['prevViewProj', 16],
  ['invViewProj', 16],
  ['view', 16],
  ['shadow', 64],
  ['cascade', 4],
  ['cam', 4],
  ['sun', 4],
  ['sunColor', 4],
  ['moon', 4],
  ['misc', 4],
  ['misc2', 4],
  ['road', 4],
  ['weather', 4],
  ['camRight', 4],
  ['camUp', 4],
  ['camFwd', 4],
  ['clip', 32],
  ['sh', 36],
  ['terrain', 32],
  ['palette', 48],
  ['sky', 4],
  ['lights', 4],
  ['prevCam', 4],
  ['grade', 4],
  ['grade2', 4],
  ['car', 4],
  ['fog', 4],
];

export type FrameField =
  | 'viewProj'
  | 'viewProjNJ'
  | 'prevViewProj'
  | 'invViewProj'
  | 'view'
  | 'shadow'
  | 'cascade'
  | 'cam'
  | 'sun'
  | 'sunColor'
  | 'moon'
  | 'misc'
  | 'misc2'
  | 'road'
  | 'weather'
  | 'camRight'
  | 'camUp'
  | 'camFwd'
  | 'clip'
  | 'sh'
  | 'terrain'
  | 'palette'
  | 'sky'
  | 'lights'
  | 'prevCam'
  | 'grade'
  | 'grade2'
  | 'car'
  | 'fog';

const OFFSETS = new Map<string, number>();
let total = 0;
for (const [name, n] of FRAME_FIELDS) {
  OFFSETS.set(name, total);
  total += n;
}
export const FRAME_FLOATS = total;

export class FrameData {
  readonly data = new Float32Array(FRAME_FLOATS);
  readonly buffer: GPUBuffer;
  constructor(private device: GPUDevice) {
    this.buffer = device.createBuffer({
      label: 'frame-uniforms',
      size: FRAME_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  set(field: FrameField, v: ArrayLike<number>, offset = 0) {
    this.data.set(v, OFFSETS.get(field)! + offset);
  }
  offsetBytes(field: FrameField): number {
    return OFFSETS.get(field)! * 4;
  }
  upload() {
    this.device.queue.writeBuffer(this.buffer, 0, this.data);
  }
}

export const FRAME_LAYOUT_ENTRIES: GPUBindGroupLayoutEntry[] = [
  {
    binding: 0,
    visibility:
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    buffer: {type: 'uniform'},
  },
  {
    binding: 1,
    visibility:
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    texture: {sampleType: 'unfilterable-float'},
  },
  {
    binding: 2,
    visibility:
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    texture: {sampleType: 'unfilterable-float', viewDimension: '2d-array'},
  },
  {
    binding: 3,
    visibility:
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    texture: {sampleType: 'float'},
  },
  {
    binding: 4,
    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    texture: {sampleType: 'float'},
  },
  {
    binding: 5,
    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    texture: {sampleType: 'float', viewDimension: '3d'},
  },
  {
    binding: 6,
    visibility:
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    sampler: {type: 'filtering'},
  },
  {
    binding: 7,
    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    texture: {sampleType: 'depth', viewDimension: '2d-array'},
  },
  {
    binding: 8,
    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    sampler: {type: 'comparison'},
  },
  {
    binding: 9,
    visibility:
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    sampler: {type: 'filtering'},
  },
  {
    binding: 10,
    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    buffer: {type: 'read-only-storage'},
  },
  {
    binding: 11,
    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
    texture: {sampleType: 'float', viewDimension: '2d-array'},
  },
  {
    binding: 12,
    visibility:
      GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
    texture: {sampleType: 'float'},
  },
];
