// Projects the sky-view LUT (plus a ground bounce) onto SH9 for diffuse
// ambient lighting. One workgroup; result is copied into the frame uniforms.
@group(0) @binding(1) var skyTex: texture_2d<f32>;
@group(0) @binding(2) var shSampler: sampler;
@group(0) @binding(3) var<storage, read_write> shOut: array<vec4f, 9>;

var<workgroup> acc: array<array<vec3f, 9>, 64>;

fn skyLookup(dir: vec3f) -> vec3f {
  let el = asin(clamp(dir.y, -1.0, 1.0));
  let az = atan2(dir.x, dir.z);
  let hEl = select(-sqrt(-el / (PI * 0.5)), sqrt(el / (PI * 0.5)), el >= 0.0);
  let v = 0.5 - 0.5 * hEl;
  let u = fract(az / (2.0 * PI) + 1.0);
  return textureSampleLevel(skyTex, shSampler, vec2f(u, v), 0.0).rgb;
}

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li: u32) {
  var s: array<vec3f, 9>;
  for (var k = 0; k < 9; k++) { s[k] = vec3f(0.0); }
  let perThread = 32u;
  let total = 64u * perThread;
  let cov = F.sky.x;
  for (var i = 0u; i < perThread; i++) {
    let n = li * perThread + i;
    // Fibonacci sphere.
    let y = 1.0 - (f32(n) + 0.5) / f32(total) * 2.0;
    let r = sqrt(max(0.0, 1.0 - y * y));
    let phi = f32(n) * 2.39996323;
    let d = vec3f(cos(phi) * r, y, sin(phi) * r);
    var L: vec3f;
    if (d.y >= 0.0) {
      L = skyLookup(d);
      // Overcast skies: flatten toward a gray, brighter-at-zenith dome.
      let gray = vec3f(luminance(skyLookup(vec3f(0.0, 1.0, 0.0)))) * (0.6 + 0.6 * d.y);
      L = mix(L, gray * (1.0 - 0.45 * cov), cov * cov);
    } else {
      // Ground bounce.
      let gAlb = vec3f(0.18, 0.17, 0.12) + vec3f(0.5) * F.weather.z;
      L = gAlb * (F.sunColor.rgb * max(F.sun.y, 0.0) / PI + skyLookup(vec3f(0.0, 1.0, 0.0)) * 0.6);
    }
    let x = d.x; let yy = d.y; let z = d.z;
    s[0] += L * 0.282095;
    s[1] += L * 0.488603 * yy;
    s[2] += L * 0.488603 * z;
    s[3] += L * 0.488603 * x;
    s[4] += L * 1.092548 * x * yy;
    s[5] += L * 1.092548 * yy * z;
    s[6] += L * 0.315392 * (3.0 * z * z - 1.0);
    s[7] += L * 1.092548 * x * z;
    s[8] += L * 0.546274 * (x * x - yy * yy);
  }
  for (var k = 0; k < 9; k++) { acc[li][k] = s[k]; }
  workgroupBarrier();
  if (li == 0u) {
    let w = 4.0 * PI / f32(total);
    for (var k = 0; k < 9; k++) {
      var t = vec3f(0.0);
      for (var j = 0; j < 64; j++) { t += acc[j][k]; }
      shOut[k] = vec4f(t * w, 0.0);
    }
  }
}
