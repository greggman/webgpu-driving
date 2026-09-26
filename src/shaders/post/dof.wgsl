// Bokeh depth of field: circle-of-confusion from depth vs. focus distance,
// golden-angle gather with a scatter-as-gather weighting.
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> dp: vec4f; // focus dist (m), aperture, max coc px, near plane

fn linearDepth(d: f32) -> f32 {
  // Reverse-Z infinite projection: viewZ = near / depth.
  return select(1e6, dp.w / d, d > 0.0);
}

fn coc(depth: f32) -> f32 {
  let z = linearDepth(depth);
  let f = dp.x;
  // Thin-lens-like CoC in pixels.
  let c = dp.y * abs(z - f) / max(z, 0.1) * (f / (f + 1.0)) * 60.0;
  return min(c, dp.z);
}

@fragment
fn fs(in: FsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(srcTex));
  let px = vec2i(in.pos.xy);
  let c0 = textureSampleLevel(srcTex, samp, in.uv, 0.0);
  if (dp.y <= 0.0) { return c0; }
  let d0 = textureLoad(depthTex, px, 0);
  let r0 = coc(d0);
  let maxR = dp.z;
  var acc = c0.rgb;
  var wsum = 1.0;
  let N = 32;
  for (var i = 1; i < N; i++) {
    let fi = f32(i);
    let r = sqrt(fi / f32(N)) * maxR;
    let a = fi * 2.39996323;
    let off = vec2f(cos(a), sin(a)) * r;
    let q = in.uv + off / size;
    let qp = vec2i(clamp(q * size, vec2f(0.0), size - 1.0));
    let dq = textureLoad(depthTex, qp, 0);
    let rq = coc(dq);
    // A sample contributes if its own CoC reaches us; background samples
    // can't bleed over an in-focus foreground.
    let reach = saturate(rq - r + 1.0);
    let behind = select(1.0, saturate(r0 - r + 1.0), dq < d0);
    let w = reach * behind;
    let s = textureSampleLevel(srcTex, samp, q, 0.0).rgb;
    // Slight highlight boost for bokeh.
    acc += s * w * (1.0 + 0.5 * saturate(luminance(s) - 2.0));
    wsum += w * (1.0 + 0.5 * saturate(luminance(s) - 2.0));
  }
  return vec4f(acc / wsum, 1.0);
}
