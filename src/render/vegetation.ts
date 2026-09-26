// GPU-driven vegetation, water and particles (filled in by later milestones).
import {Biome} from '../world/biome';
import {Road} from '../world/road';
import {FrameData} from './frameData';
import {SceneState} from './renderer';

export class Vegetation {
  readonly materialView: GPUTextureView;

  constructor(
    private device: GPUDevice,
    private frame: FrameData,
    private frameLayout: GPUBindGroupLayout,
    private shadowLayout: GPUBindGroupLayout,
  ) {
    const tex = device.createTexture({
      label: 'material-array',
      size: [4, 4, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.materialView = tex.createView({dimension: '2d-array'});
  }

  setWorld(biome: Biome, road: Road) {
    void biome;
    void road;
  }

  update(
    scene: SceneState,
    eye: number[],
    planes: Float32Array,
    ox: number,
    oz: number,
  ) {
    void scene;
    void eye;
    void planes;
    void ox;
    void oz;
  }

  encodeCompute(enc: GPUCommandEncoder, frameBG: GPUBindGroup) {
    void enc;
    void frameBG;
  }

  draw(pass: GPURenderPassEncoder) {
    void pass;
  }

  drawShadow(pass: GPURenderPassEncoder, cascade: number) {
    void pass;
    void cascade;
  }

  drawWater(pass: GPURenderPassEncoder) {
    void pass;
  }

  drawParticles(pass: GPURenderPassEncoder) {
    void pass;
  }
}
