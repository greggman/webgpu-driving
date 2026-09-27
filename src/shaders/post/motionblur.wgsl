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
  var uv0 = in.uv;
  // Heat shimmer over hot ground (desert): refraction that grows with
  // distance, wobbling upward.
  let dust = F.sky.z;
  let dRaw = textureLoad(depthTex, px, 0);
  if (dust > 0.0 && dRaw > 0.0) {
    let viewZ = 0.15 / dRaw;
    let k = saturate((viewZ - 40.0) / 400.0) * dust * F.sun.w;
    let t = F.cam.w;
    let w = vec2f(
      vnoise(in.uv * vec2f(90.0, 260.0) + vec2f(0.0, t * 4.0)) - 0.5,
      vnoise(in.uv * vec2f(70.0, 200.0) + vec2f(13.0, t * 3.0)) - 0.5);
    uv0 += w * k * vec2f(0.0012, 0.002);
  }
  let c0 = textureSampleLevel(srcTex, samp, uv0, 0.0);
    var vel = textureLoad(velTex, px, 0).xy * mb.x;
  // Mirror glass sentinel (car.wgsl MIRROR_VEL): not blurred.
  if (textureLoad(velTex, px, 0).x > 32.0) { vel = vec2f(0.0); }
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
    let uv = uv0 - vel * t;
    let q = vec2i(clamp(uv * size, vec2f(0.0), size - 1.0));
    let dq = textureLoad(depthTex, q, 0);
        var vq = textureLoad(velTex, q, 0).xy * mb.x;
    if (vq.x > 32.0 * mb.x && mb.x > 0.0) { vq = vec2f(0.0); }
    // Don't smear background over sharper foreground (reverse-Z: larger = closer).
    var w = 1.0;
    if (dq > d0 * 1.02 && length(vq * size) < length(vel * size) * 0.5) { w = 0.0; }
    acc += textureSampleLevel(srcTex, samp, uv, 0.0).rgb * w;
    wsum += w;
  }
  return vec4f(acc / wsum, 1.0);
}
