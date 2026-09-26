// Atmosphere LUT generation compute shaders (atmosphere.wgsl included first).

@group(0) @binding(1) var tLUT: texture_2d<f32>;
@group(0) @binding(2) var msLUT: texture_2d<f32>;
@group(0) @binding(3) var lutSampler: sampler;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba16float, write>;

fn sampleT(pos: vec3f, sunDir: vec3f) -> vec3f {
  return textureSampleLevel(tLUT, lutSampler, tlutUV(pos, sunDir), 0.0).rgb;
}

fn sampleMS(pos: vec3f, sunDir: vec3f) -> vec3f {
  return textureSampleLevel(msLUT, lutSampler, tlutUV(pos, sunDir), 0.0).rgb;
}

// ---- Transmittance LUT (256 x 64) ----
@compute @workgroup_size(8, 8)
fn transmittance(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(outTex);
  if (any(id.xy >= dims)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dims);
  let c = uv.x * 2.0 - 1.0;
  let h = mix(GROUND_R, TOP_R, uv.y);
  let pos = vec3f(0.0, h, 0.0);
  let sunDir = normalize(vec3f(0.0, c, sqrt(max(0.0, 1.0 - c * c))));
  var trans = vec3f(0.0);
  if (raySphere(pos, sunDir, GROUND_R) <= 0.0) {
    let tMax = raySphere(pos, sunDir, TOP_R);
    var t = 0.0;
    var od = vec3f(0.0);
    let steps = 40.0;
    for (var i = 0.0; i < steps; i += 1.0) {
      let nt = ((i + 0.3) / steps) * tMax;
      let dt = nt - t;
      t = nt;
      od += scatteringAt(pos + t * sunDir).ext * dt;
    }
    trans = exp(-od);
  }
  textureStore(outTex, id.xy, vec4f(trans, 1.0));
}

// ---- Multiple scattering LUT (32 x 32) ----
@compute @workgroup_size(8, 8)
fn multiscatter(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(outTex);
  if (any(id.xy >= dims)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dims);
  let c = uv.x * 2.0 - 1.0;
  let h = mix(GROUND_R, TOP_R, uv.y);
  let pos = vec3f(0.0, h, 0.0);
  let sunDir = normalize(vec3f(0.0, c, sqrt(max(0.0, 1.0 - c * c))));
  var lumTotal = vec3f(0.0);
  var fms = vec3f(0.0);
  let N = 8;
  let inv = 1.0 / f32(N * N);
  for (var i = 0; i < N; i++) {
    for (var j = 0; j < N; j++) {
      let theta = PI * (f32(i) + 0.5) / f32(N);
      let phi = acos(clamp(1.0 - 2.0 * (f32(j) + 0.5) / f32(N), -1.0, 1.0));
      let rd = vec3f(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));
      let atmoDist = raySphere(pos, rd, TOP_R);
      let groundDist = raySphere(pos, rd, GROUND_R);
      var tMax = atmoDist;
      if (groundDist > 0.0) { tMax = groundDist; }
      let ct = dot(rd, sunDir);
      let mp = miePhase(ct);
      let rp = rayleighPhase(-ct);
      var lum = vec3f(0.0);
      var lumFactor = vec3f(0.0);
      var trans = vec3f(1.0);
      var t = 0.0;
      let steps = 20.0;
      for (var k = 0.0; k < steps; k += 1.0) {
        let nt = ((k + 0.3) / steps) * tMax;
        let dt = nt - t;
        t = nt;
        let p = pos + t * rd;
        let s = scatteringAt(p);
        let st = exp(-dt * s.ext);
        let scatNoPhase = s.rayleigh + vec3f(s.mie);
        let scatF = (scatNoPhase - scatNoPhase * st) / s.ext;
        lumFactor += trans * scatF;
        let sunT = sampleT(p, sunDir);
        let inS = (s.rayleigh * rp + vec3f(s.mie * mp)) * sunT;
        lum += trans * (inS - inS * st) / s.ext;
        trans *= st;
      }
      if (groundDist > 0.0) {
        let hit = normalize(pos + groundDist * rd) * GROUND_R;
        if (dot(pos, sunDir) > 0.0) {
          lum += trans * GROUND_ALBEDO * sampleT(hit, sunDir) * saturate(dot(normalize(hit), sunDir));
        }
      }
      fms += lumFactor * inv;
      lumTotal += lum * inv;
    }
  }
  let psi = lumTotal / (vec3f(1.0) - fms);
  textureStore(outTex, id.xy, vec4f(psi, 1.0));
}

// Single + multiple scattering along a ray; returns (luminance, mean trans).
fn raymarch(pos: vec3f, rd: vec3f, sunDir: vec3f, tMax: f32, steps: f32) -> vec4f {
  let ct = dot(rd, sunDir);
  let mp = miePhase(ct);
  let rp = rayleighPhase(-ct);
  var lum = vec3f(0.0);
  var trans = vec3f(1.0);
  var t = 0.0;
  for (var k = 0.0; k < steps; k += 1.0) {
    let nt = ((k + 0.3) / steps) * tMax;
    let dt = nt - t;
    t = nt;
    let p = pos + t * rd;
    let s = scatteringAt(p);
    let st = exp(-dt * s.ext);
    let sunT = sampleT(p, sunDir);
    let ms = sampleMS(p, sunDir);
    let inS = s.rayleigh * (rp * sunT + ms) + vec3f(s.mie) * (mp * sunT + ms);
    lum += trans * (inS - inS * st) / s.ext;
    trans *= st;
  }
  return vec4f(lum, dot(trans, vec3f(1.0 / 3.0)));
}

fn lightDir() -> vec3f {
  return F.sun.xyz;
}

fn lightIntensity() -> f32 {
  // Moonlight is sunlight scaled way down; exposure compensates later.
  return mix(SUN_INTENSITY, SUN_INTENSITY * 0.02, 1.0 - F.sun.w);
}

fn cameraAtmoPos() -> vec3f {
  return vec3f(0.0, GROUND_R + max(F.cam.y, 0.0) * 1e-6 + 0.00002, 0.0);
}

// ---- Sky-view LUT (192 x 108), absolute azimuth ----
@compute @workgroup_size(8, 8)
fn skyview(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(outTex);
  if (any(id.xy >= dims)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dims);
  let az = uv.x * 2.0 * PI;
  var el: f32;
  if (uv.y < 0.5) {
    let c = 1.0 - 2.0 * uv.y;
    el = c * c * PI * 0.5;
  } else {
    let c = 2.0 * uv.y - 1.0;
    el = -c * c * PI * 0.5;
  }
  let rd = vec3f(cos(el) * sin(az), sin(el), cos(el) * cos(az));
  let pos = cameraAtmoPos();
  let atmoDist = raySphere(pos, rd, TOP_R);
  let groundDist = raySphere(pos, rd, GROUND_R);
  var tMax = atmoDist;
  if (groundDist > 0.0) { tMax = groundDist; }
  let r = raymarch(pos, rd, lightDir(), tMax, 32.0);
  textureStore(outTex, id.xy, vec4f(r.rgb * lightIntensity(), 1.0));
}
