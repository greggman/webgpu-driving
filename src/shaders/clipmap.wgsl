// Clipmap level update. Texel (i, j) of level L holds the terrain at local
// position F.clip[L].xy + (i, j) * texel, so CDLOD vertices on multiples of the
// texel size hit texel centers exactly and neighboring LODs agree bit-for-bit.

struct LevelParams {
  level: u32,
};
@group(0) @binding(2) var<uniform> P: LevelParams;
@group(0) @binding(3) var heightTmp: texture_storage_2d<rg32float, write>;
@group(0) @binding(4) var heightIn: texture_2d<f32>;
@group(0) @binding(5) var clipOut: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn heights(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(u32(CLIP_RES)))) { return; }
  let c = F.clip[P.level];
  let p = c.xy + vec2f(id.xy) * c.z;
  let ri = roadInfo(p);
  let n = naturalHeight(p.x + F.misc.x, p.y + F.misc.y, ri.d);
  let h = roadBlend(n, ri.d, ri.y, ri.bridge, ri.tunnel);
  textureStore(heightTmp, id.xy, vec4f(h, ri.d, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn normals(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(u32(CLIP_RES)))) { return; }
  let c = F.clip[P.level];
  let i = vec2i(id.xy);
  let mx = CLIP_RES - 1;
  let hc = textureLoad(heightIn, i, 0);
  let hl = textureLoad(heightIn, clamp(i - vec2i(1, 0), vec2i(0), vec2i(mx)), 0).x;
  let hr = textureLoad(heightIn, clamp(i + vec2i(1, 0), vec2i(0), vec2i(mx)), 0).x;
  let hd = textureLoad(heightIn, clamp(i - vec2i(0, 1), vec2i(0), vec2i(mx)), 0).x;
  let hu = textureLoad(heightIn, clamp(i + vec2i(0, 1), vec2i(0), vec2i(mx)), 0).x;
  let sx = select(2.0, 1.0, i.x == 0 || i.x == mx);
  let sz = select(2.0, 1.0, i.y == 0 || i.y == mx);
  let dhdx = (hr - hl) / (sx * c.z);
  let dhdz = (hu - hd) / (sz * c.z);
  textureStore(clipOut, i, vec4f(hc.x, dhdx, dhdz, hc.y));
}

// Debug probe: evaluate the terrain function directly at a point.
@group(0) @binding(6) var<storage, read_write> probe: array<vec4f, 2>;

@compute @workgroup_size(1)
fn probeHeight() {
  let p = probe[0].xy;
  let ri = roadInfo(p);
  let n = naturalHeight(p.x + F.misc.x, p.y + F.misc.y, ri.d);
  probe[1] = vec4f(roadBlend(n, ri.d, ri.y, ri.bridge, ri.tunnel), ri.d, ri.y, n);
}
