// Screen-space ambient occlusion (horizon-based, GTAO-style) from depth and
// normals, at half resolution (fsHalf: every other full-res pixel), then
// upsampled with depth-aware weights (fsUp) and multiplied into the HDR color
// before TAA, which also denoises it (directions rotate every frame). fs is
// the same at full resolution (debug=fullao).
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
// fsUp: half-res (ao, distance from the camera).
@group(0) @binding(3) var aoTex: texture_2d<f32>;

fn worldPos(px: vec2i, size: vec2f) -> vec3f {
  let d = textureLoad(depthTex, px, 0);
  let uv = (vec2f(px) + 0.5) / size;
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, max(d, 1e-7), 1.0);
  let w = F.invViewProj * ndc;
  return w.xyz / w.w;
}

// AO at full-res pixel px: (ao, distance from the camera); sky (1, 1e4).
fn ao(px: vec2i, size: vec2f) -> vec2f {
  let d = textureLoad(depthTex, px, 0);
  if (d <= 0.0) { return vec2f(1.0, 1e4); }
  let P = worldPos(px, size);
  let n = normalize(textureLoad(normalTex, px, 0).xyz * 2.0 - 1.0);
  let dist = distance(P, F.cam.xyz);
  // World-space radius, projected to pixels.
  let R = clamp(dist * 0.06, 0.4, 3.0);
  let pxR = R / (dist * F.camFwd.w * 2.0) * size.y;
  if (pxR < 1.5) { return vec2f(1.0, dist); }
  let fp = vec2f(px) + 0.5;
  let noise = fract(52.9829189 * fract(dot(fp, vec2f(0.06711056, 0.00583715))) + F.misc2.z * 0.618);
  var occ = 0.0;
  let DIRS = 4;
  let STEPS = 5;
  for (var i = 0; i < DIRS; i++) {
    let a = (f32(i) + noise) / f32(DIRS) * 3.14159265;
    let dir = vec2f(cos(a), sin(a));
    for (var sgn = -1.0; sgn <= 1.0; sgn += 2.0) {
      var maxH = -1.0;
      for (var s = 1; s <= STEPS; s++) {
        let t = (f32(s) - 0.5 + noise * 0.5) / f32(STEPS);
        let q = vec2i(fp + dir * sgn * pxR * t);
        if (any(q < vec2i(0)) || any(q >= vec2i(size))) { break; }
        let Q = worldPos(q, size);
        let v = Q - P;
        let l = length(v);
        if (l < 1e-3) { continue; }
        let h = dot(v / l, n) * saturate(1.0 - l / R);
        maxH = max(maxH, h);
      }
      occ += saturate(maxH);
    }
  }
  let o = 1.0 - occ / f32(DIRS * 2);
  return vec2f(mix(1.0, o * o, 0.85), dist);
}

@fragment
fn fs(in: FsOut) -> @location(0) vec4f {
  let a = ao(vec2i(in.pos.xy), vec2f(textureDimensions(depthTex))).x;
  return vec4f(a, a, a, 1.0);
}

@fragment
fn fsHalf(in: FsOut) -> @location(0) vec4f {
  return vec4f(ao(vec2i(in.pos.xy) * 2, vec2f(textureDimensions(depthTex))), 0.0, 0.0);
}

@fragment
fn fsUp(in: FsOut) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy);
  let size = vec2f(textureDimensions(depthTex));
  if (textureLoad(depthTex, px, 0) <= 0.0) { return vec4f(1.0); }
  let dist = distance(worldPos(px, size), F.cam.xyz);
  // Half-res texel h was computed at full-res pixel 2h: bilinear over the
  // four around px, each weighted by how close its depth is to this one's.
  let hmax = vec2i(textureDimensions(aoTex)) - 1;
  let base = px >> vec2u(1u);
  let f = vec2f(px & vec2i(1)) * 0.5;
  var sum = 0.0;
  var wsum = 0.0;
  var best = vec2f(1.0, 1e9); // (ao, depth difference) of the closest sample
  for (var i = 0; i < 4; i++) {
    let o = vec2i(i & 1, i >> 1);
    let s = textureLoad(aoTex, min(base + o, hmax), 0).xy;
    let bw = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    let dd = abs(s.y - dist);
    let w = bw * exp(-dd / (0.03 * dist + 0.05));
    sum += s.x * w;
    wsum += w;
    if (dd < best.y) { best = vec2f(s.x, dd); }
  }
  let a = select(best.x, sum / wsum, wsum > 1e-4);
  return vec4f(a, a, a, 1.0);
}
