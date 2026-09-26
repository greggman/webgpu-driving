// Temporal anti-aliasing: reprojected history with velocity dilation,
// Catmull-Rom history filtering, and variance clipping in YCoCg.
@group(0) @binding(1) var curTex: texture_2d<f32>;
@group(0) @binding(2) var histTex: texture_2d<f32>;
@group(0) @binding(3) var velTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_depth_2d;
@group(0) @binding(5) var samp: sampler;
@group(0) @binding(6) var<uniform> taaParams: vec4f; // x = reset (1 = no history)

fn toYCoCg(c: vec3f) -> vec3f {
  return vec3f(
    0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
    0.5 * c.r - 0.5 * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
fn fromYCoCg(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

// Karis: tonemapped weights reduce flicker from very bright samples.
fn tm(c: vec3f) -> vec3f { return c / (1.0 + luminance(c)); }
fn itm(c: vec3f) -> vec3f { return c / max(1.0 - luminance(c), 1e-4); }

fn sampleHistoryCR(uv: vec2f, size: vec2f) -> vec3f {
  let sp = uv * size;
  let tc = floor(sp - 0.5) + 0.5;
  let f = sp - tc;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let tc0 = (tc - 1.0) / size;
  let tc3 = (tc + 2.0) / size;
  let tc12 = (tc + w2 / w12) / size;
  var r = vec3f(0.0);
  r += textureSampleLevel(histTex, samp, vec2f(tc12.x, tc0.y), 0.0).rgb * w12.x * w0.y;
  r += textureSampleLevel(histTex, samp, vec2f(tc0.x, tc12.y), 0.0).rgb * w0.x * w12.y;
  r += textureSampleLevel(histTex, samp, vec2f(tc12.x, tc12.y), 0.0).rgb * w12.x * w12.y;
  r += textureSampleLevel(histTex, samp, vec2f(tc3.x, tc12.y), 0.0).rgb * w3.x * w12.y;
  r += textureSampleLevel(histTex, samp, vec2f(tc12.x, tc3.y), 0.0).rgb * w12.x * w3.y;
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / wsum, vec3f(0.0));
}

@fragment
fn fs(in: FsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(curTex));
  let px = vec2i(in.pos.xy);
  let mx = vec2i(size) - 1;
  // Neighborhood statistics + closest-depth velocity dilation.
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var bestDepth = -1.0;
  var bestPx = px;
  var center = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = clamp(px + vec2i(x, y), vec2i(0), mx);
      let c = tm(textureLoad(curTex, q, 0).rgb);
      if (x == 0 && y == 0) { center = c; }
      let yc = toYCoCg(c);
      m1 += yc;
      m2 += yc * yc;
      let dep = textureLoad(depthTex, q, 0);
      if (dep > bestDepth) { bestDepth = dep; bestPx = q; }
    }
  }
  if (taaParams.x > 0.5) {
    return vec4f(itm(center), 1.0);
  }
  let vel = textureLoad(velTex, bestPx, 0).xy;
  let prevUV = in.uv - vel;
  if (any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0))) {
    return vec4f(itm(center), 1.0);
  }
  let mean = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  let gamma = 1.25;
  let mn = mean - sigma * gamma;
  let mxc = mean + sigma * gamma;
  var hist = toYCoCg(tm(sampleHistoryCR(prevUV, size)));
  // Clip toward the mean (AABB clip).
  let c = 0.5 * (mxc + mn);
  let e = 0.5 * (mxc - mn) + 1e-5;
  let v = hist - c;
  let a = abs(v / e);
  let ma = max(a.x, max(a.y, a.z));
  if (ma > 1.0) { hist = c + v / ma; }
  let speed = length(vel * size);
  let alpha = mix(0.08, 0.2, saturate(speed / 30.0));
  let res = mix(fromYCoCg(hist), center, alpha);
  return vec4f(itm(max(res, vec3f(0.0))), 1.0);
}
