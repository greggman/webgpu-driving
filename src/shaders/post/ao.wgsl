// Screen-space ambient occlusion (horizon-based, GTAO-style) from depth and
// normals. Output is multiplied into the HDR color before TAA, which also
// denoises it (directions rotate every frame).
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var normalTex: texture_2d<f32>;

fn viewPos(px: vec2i, size: vec2f) -> vec3f {
  let d = textureLoad(depthTex, px, 0);
  let uv = (vec2f(px) + 0.5) / size;
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, max(d, 1e-7), 1.0);
  let w = F.invViewProj * ndc;
  return w.xyz / w.w;
}

@fragment
fn fs(in: FsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(depthTex));
  let px = vec2i(in.pos.xy);
  let d = textureLoad(depthTex, px, 0);
  if (d <= 0.0) { return vec4f(1.0); }
  let P = viewPos(px, size);
  let n = normalize(textureLoad(normalTex, px, 0).xyz * 2.0 - 1.0);
  let dist = distance(P, F.cam.xyz);
  // World-space radius, projected to pixels.
  let R = clamp(dist * 0.06, 0.4, 3.0);
  let pxR = R / (dist * F.camFwd.w * 2.0) * size.y;
  if (pxR < 1.5) { return vec4f(1.0); }
  let noise = fract(52.9829189 * fract(dot(in.pos.xy, vec2f(0.06711056, 0.00583715))) + F.misc2.z * 0.618);
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
        let q = vec2i(in.pos.xy + dir * sgn * pxR * t);
        if (any(q < vec2i(0)) || any(q >= vec2i(size))) { break; }
        let Q = viewPos(q, size);
        let v = Q - P;
        let l = length(v);
        if (l < 1e-3) { continue; }
        let h = dot(v / l, n) * saturate(1.0 - l / R);
        maxH = max(maxH, h);
      }
      occ += saturate(maxH);
    }
  }
  let ao = 1.0 - occ / f32(DIRS * 2);
  let a = mix(1.0, ao * ao, 0.85);
  return vec4f(a, a, a, 1.0);
}
