// Per-pixel motion blur along the velocity buffer (180-degree shutter).
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var velTex: texture_2d<f32>;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var<uniform> mb: vec4f; // x = shutter scale

@fragment
fn fs(in: FsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(srcTex));
  let px = vec2i(in.pos.xy);
  let c0 = textureSampleLevel(srcTex, samp, in.uv, 0.0);
  var vel = textureLoad(velTex, px, 0).xy * mb.x;
  // Clamp to a maximum blur length (in pixels).
  let lenPx = length(vel * size);
  let maxPx = 40.0;
  if (lenPx > maxPx) { vel *= maxPx / lenPx; }
  if (length(vel * size) < 0.75) { return c0; }
  let d0 = textureLoad(depthTex, px, 0);
  let N = 10;
  let noise = fract(52.9829189 * fract(dot(in.pos.xy, vec2f(0.06711056, 0.00583715))) + F.misc2.z * 0.618) - 0.5;
  var acc = c0.rgb;
  var wsum = 1.0;
  for (var i = 0; i < N; i++) {
    let t = (f32(i) + noise + 0.5) / f32(N) - 0.5;
    let uv = in.uv - vel * t;
    let q = vec2i(clamp(uv * size, vec2f(0.0), size - 1.0));
    let dq = textureLoad(depthTex, q, 0);
    let vq = textureLoad(velTex, q, 0).xy * mb.x;
    // Don't smear background over sharper foreground (reverse-Z: larger = closer).
    var w = 1.0;
    if (dq > d0 * 1.02 && length(vq * size) < length(vel * size) * 0.5) { w = 0.0; }
    acc += textureSampleLevel(srcTex, samp, uv, 0.0).rgb * w;
    wsum += w;
  }
  return vec4f(acc / wsum, 1.0);
}
