// Ocean surface (coast environment).
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
import {RENDER_PRELUDE} from './shaders';
import waterSrc from '../shaders/water.wgsl';
import {DEPTH_FORMAT, GBUFFER_TARGETS} from './targets';

const RINGS = 110;
const SEGS = 160;

export class Water {
  private pipe!: GPURenderPipeline;
  enabled = false;

  constructor(device: GPUDevice, frameLayout: GPUBindGroupLayout) {
    const module = shaderModule(
      device,
      RENDER_PRELUDE + '\n' + waterSrc,
      'water',
    );
    deferRenderPipeline(
      device,
      {
        label: 'ocean',
        layout: device.createPipelineLayout({
          label: 'ocean-layout',
          bindGroupLayouts: [frameLayout],
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
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.enabled) return;
    pass.setPipeline(this.pipe);
    pass.draw(RINGS * SEGS * 6);
  }
}
