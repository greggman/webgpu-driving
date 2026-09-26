// Hierarchical-Z pyramid (min depth = farthest in reverse-Z) for occlusion
// culling in the next frame's scatter pass.
@group(0) @binding(0) var depthIn: texture_depth_2d;
@group(0) @binding(1) var hzbOut: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var hzbIn: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn fromDepth(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(hzbOut);
  if (any(id.xy >= dims)) { return; }
  let src = vec2i(textureDimensions(depthIn)) - 1;
  let p = vec2i(id.xy) * 2;
  let a = textureLoad(depthIn, min(p, src), 0);
  let b = textureLoad(depthIn, min(p + vec2i(1, 0), src), 0);
  let c = textureLoad(depthIn, min(p + vec2i(0, 1), src), 0);
  let d = textureLoad(depthIn, min(p + vec2i(1, 1), src), 0);
  textureStore(hzbOut, id.xy, vec4f(min(min(a, b), min(c, d)), 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn downsample(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(hzbOut);
  if (any(id.xy >= dims)) { return; }
  let src = vec2i(textureDimensions(hzbIn)) - 1;
  let p = vec2i(id.xy) * 2;
  let a = textureLoad(hzbIn, min(p, src), 0).x;
  let b = textureLoad(hzbIn, min(p + vec2i(1, 0), src), 0).x;
  let c = textureLoad(hzbIn, min(p + vec2i(0, 1), src), 0).x;
  let d = textureLoad(hzbIn, min(p + vec2i(1, 1), src), 0).x;
  textureStore(hzbOut, id.xy, vec4f(min(min(a, b), min(c, d)), 0.0, 0.0, 0.0));
}
