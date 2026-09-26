// Physically-inspired bloom: 13-tap downsample chain + tent upsample.
@group(0) @binding(3) var srcTex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var<uniform> bp: vec4f; // texel size xy, filter radius, first-pass flag

fn karisWeight(c: vec3f) -> f32 {
  return 1.0 / (1.0 + luminance(c) * 0.25);
}

@fragment
fn down(in: FsOut) -> @location(0) vec4f {
  let t = bp.xy;
  let uv = in.uv;
  let a = textureSampleLevel(srcTex, samp, uv + t * vec2f(-2.0, -2.0), 0.0).rgb;
  let b = textureSampleLevel(srcTex, samp, uv + t * vec2f(0.0, -2.0), 0.0).rgb;
  let c = textureSampleLevel(srcTex, samp, uv + t * vec2f(2.0, -2.0), 0.0).rgb;
  let d = textureSampleLevel(srcTex, samp, uv + t * vec2f(-2.0, 0.0), 0.0).rgb;
  let e = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let f = textureSampleLevel(srcTex, samp, uv + t * vec2f(2.0, 0.0), 0.0).rgb;
  let g = textureSampleLevel(srcTex, samp, uv + t * vec2f(-2.0, 2.0), 0.0).rgb;
  let h = textureSampleLevel(srcTex, samp, uv + t * vec2f(0.0, 2.0), 0.0).rgb;
  let i = textureSampleLevel(srcTex, samp, uv + t * vec2f(2.0, 2.0), 0.0).rgb;
  let j = textureSampleLevel(srcTex, samp, uv + t * vec2f(-1.0, -1.0), 0.0).rgb;
  let k = textureSampleLevel(srcTex, samp, uv + t * vec2f(1.0, -1.0), 0.0).rgb;
  let l = textureSampleLevel(srcTex, samp, uv + t * vec2f(-1.0, 1.0), 0.0).rgb;
  let m = textureSampleLevel(srcTex, samp, uv + t * vec2f(1.0, 1.0), 0.0).rgb;
  var col: vec3f;
  if (bp.w > 0.5) {
    // First pass: Karis average per 2x2 group to kill fireflies.
    let g0 = (a + b + d + e) * 0.25;
    let g1 = (b + c + e + f) * 0.25;
    let g2 = (d + e + g + h) * 0.25;
    let g3 = (e + f + h + i) * 0.25;
    let g4 = (j + k + l + m) * 0.25;
    let w0 = karisWeight(g0) * 0.125;
    let w1 = karisWeight(g1) * 0.125;
    let w2 = karisWeight(g2) * 0.125;
    let w3 = karisWeight(g3) * 0.125;
    let w4 = karisWeight(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  return vec4f(max(col, vec3f(0.0)), 1.0);
}

@fragment
fn up(in: FsOut) -> @location(0) vec4f {
  let t = bp.xy * bp.z;
  let uv = in.uv;
  var c = textureSampleLevel(srcTex, samp, uv, 0.0).rgb * 4.0;
  c += (textureSampleLevel(srcTex, samp, uv + vec2f(-t.x, 0.0), 0.0).rgb
      + textureSampleLevel(srcTex, samp, uv + vec2f(t.x, 0.0), 0.0).rgb
      + textureSampleLevel(srcTex, samp, uv + vec2f(0.0, -t.y), 0.0).rgb
      + textureSampleLevel(srcTex, samp, uv + vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  c += textureSampleLevel(srcTex, samp, uv + vec2f(-t.x, -t.y), 0.0).rgb
     + textureSampleLevel(srcTex, samp, uv + vec2f(t.x, -t.y), 0.0).rgb
     + textureSampleLevel(srcTex, samp, uv + vec2f(-t.x, t.y), 0.0).rgb
     + textureSampleLevel(srcTex, samp, uv + vec2f(t.x, t.y), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}
