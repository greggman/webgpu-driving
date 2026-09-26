// Cascaded shadow maps: 4 cascades fitted with bounding spheres (rotation
// invariant) and snapped to texel increments for stability.
import {lookAt, multiply, orthoReverseZ, invert} from '../math/mat4';

export const SHADOW_RES = 2048;
export const CASCADES = 4;
export const CASCADE_SPLITS = [14, 45, 160, 700];

export class Shadows {
  readonly map: GPUTexture;
  readonly layerViews: GPUTextureView[] = [];
  readonly vpBuf: GPUBuffer;
  readonly layout: GPUBindGroupLayout;
  readonly bindGroups: GPUBindGroup[] = [];
  readonly matrices: Float32Array[] = [];

  constructor(private device: GPUDevice) {
    this.map = device.createTexture({
      label: 'shadow-cascades',
      size: [SHADOW_RES, SHADOW_RES, CASCADES],
      format: 'depth32float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    for (let i = 0; i < CASCADES; ++i) {
      this.layerViews.push(
        this.map.createView({
          label: `shadow-cascade-${i}`,
          dimension: '2d',
          baseArrayLayer: i,
          arrayLayerCount: 1,
        }),
      );
      this.matrices.push(new Float32Array(16));
    }
    this.vpBuf = device.createBuffer({
      label: 'shadow-cascade-matrices',
      size: 256 * CASCADES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.layout = device.createBindGroupLayout({
      label: 'shadow-vp-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: {type: 'uniform'},
        },
      ],
    });
    for (let i = 0; i < CASCADES; ++i) {
      this.bindGroups.push(
        device.createBindGroup({
          label: `shadow-vp-bg-${i}`,
          layout: this.layout,
          entries: [
            {
              binding: 0,
              resource: {buffer: this.vpBuf, offset: i * 256, size: 64},
            },
          ],
        }),
      );
    }
  }

  // camPos/fwd/up/right in local space; fovY, aspect.
  update(
    camPos: number[],
    fwd: number[],
    right: number[],
    up: number[],
    fovY: number,
    aspect: number,
    lightDir: number[],
  ) {
    const tanY = Math.tan(fovY / 2),
      tanX = tanY * aspect;
    let near = 0.1;
    for (let i = 0; i < CASCADES; ++i) {
      const far = CASCADE_SPLITS[i];
      // Bounding sphere of the frustum slice.
      const mid = (near + far) / 2;
      const center = [0, 1, 2].map(k => camPos[k] + fwd[k] * mid);
      const cornerFar = [0, 1, 2].map(
        k =>
          camPos[k] + fwd[k] * far + right[k] * far * tanX + up[k] * far * tanY,
      );
      let radius = Math.hypot(
        cornerFar[0] - center[0],
        cornerFar[1] - center[1],
        cornerFar[2] - center[2],
      );
      radius = Math.ceil(radius * 16) / 16;
      const back = 1500;
      const eye = [0, 1, 2].map(k => center[k] + lightDir[k] * (radius + back));
      const view = lookAt(
        eye,
        center,
        Math.abs(lightDir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0],
      );
      // Snap the center to texel increments in light space.
      const texel = (2 * radius) / SHADOW_RES;
      const cx =
        view[0] * center[0] +
        view[4] * center[1] +
        view[8] * center[2] +
        view[12];
      const cy =
        view[1] * center[0] +
        view[5] * center[1] +
        view[9] * center[2] +
        view[13];
      const ox = Math.round(cx / texel) * texel - cx;
      const oy = Math.round(cy / texel) * texel - cy;
      const proj = orthoReverseZ(
        -radius + ox,
        radius + ox,
        -radius + oy,
        radius + oy,
        0,
        2 * radius + back + 200,
      );
      // orthoReverseZ expects view-space z going negative; our lookAt has the
      // camera looking down -z, so near/far are distances along -z.
      const vp = multiply(proj, view);
      this.matrices[i].set(vp);
      this.device.queue.writeBuffer(this.vpBuf, i * 256, vp);
      near = far * 0.85;
    }
    void invert;
  }
}
