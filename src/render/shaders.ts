// WGSL source composition. Shaders are concatenated from small libraries
// (esbuild imports .wgsl files as text).
import frame from '../shaders/frame.wgsl';
import noise from '../shaders/noise.wgsl';
import bindings from '../shaders/bindings.wgsl';
import terrain from '../shaders/terrain.wgsl';
import lighting from '../shaders/lighting.wgsl';
import atmosphere from '../shaders/atmosphere.wgsl';

// Everything a main-pass (lit, group-0) shader needs.
export const RENDER_PRELUDE = [frame, noise, bindings, terrain, lighting].join(
  '\n',
);

// For compute shaders that only need the Frame uniform + noise.
export const FRAME_PRELUDE = [frame, noise].join('\n');

export const ATMO_PRELUDE = [frame, noise, atmosphere].join('\n');

// Terrain evaluation without the group-0 render bindings (clipmap update).
export function terrainComputePrelude(roadBinding: number): string {
  return [
    frame,
    noise,
    `@group(0) @binding(${roadBinding}) var roadTex: texture_2d<f32>;`,
    terrain,
  ].join('\n');
}
