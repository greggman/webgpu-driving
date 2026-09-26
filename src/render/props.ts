// Roadside props (filled in by later milestones).
import {Biome} from '../world/biome';
import {Road} from '../world/road';
import {RoadMesh} from './roadMesh';

export class Props {
  constructor(
    private device: GPUDevice,
    private frameLayout: GPUBindGroupLayout,
    private shadowLayout: GPUBindGroupLayout,
  ) {}

  setWorld(biome: Biome, road: Road) {
    void biome;
    void road;
  }

  update(
    s: number,
    ox: number,
    oz: number,
    planes: Float32Array,
    roadMesh: RoadMesh,
  ) {
    void s;
    void ox;
    void oz;
    void planes;
    void roadMesh;
  }

  draw(pass: GPURenderPassEncoder) {
    void pass;
  }

  drawShadow(pass: GPURenderPassEncoder) {
    void pass;
  }
}
