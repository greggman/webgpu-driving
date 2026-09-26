// Aerial perspective froxel volume (32 x 32 x 32), per frame.
@group(0) @binding(1) var tLUT: texture_2d<f32>;
@group(0) @binding(2) var msLUT: texture_2d<f32>;
@group(0) @binding(3) var lutSampler: sampler;
@group(0) @binding(4) var apOut: texture_storage_3d<rgba16float, write>;

fn sampleT(pos: vec3f, sunDir: vec3f) -> vec3f {
  return textureSampleLevel(tLUT, lutSampler, tlutUV(pos, sunDir), 0.0).rgb;
}
fn sampleMS(pos: vec3f, sunDir: vec3f) -> vec3f {
  return textureSampleLevel(msLUT, lutSampler, tlutUV(pos, sunDir), 0.0).rgb;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(32u))) { return; }
  let uv = (vec2f(id.xy) + 0.5) / 32.0;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let wp = F.invViewProj * vec4f(ndc, 0.5, 1.0);
  let rd = normalize(wp.xyz / wp.w - F.cam.xyz);
  let sunDir = F.sun.xyz;
  let intensity = mix(20.0, 20.0 * 0.02, 1.0 - F.sun.w);
  let pos0 = vec3f(0.0, GROUND_R + max(F.cam.y, 0.0) * 1e-6 + 0.00002, 0.0);
  let ct = dot(rd, sunDir);
  let mp = miePhase(ct);
  let rp = rayleighPhase(-ct);
  var lum = vec3f(0.0);
  var trans = vec3f(1.0);
  var t = 0.0; // Mm
  for (var slice = 0u; slice < 32u; slice++) {
    let w = (f32(slice) + 0.5) / 32.0;
    let tgt = w * w * 48.0 * 0.001; // Mm
    // Two sub-steps per slice.
    for (var k = 0; k < 2; k++) {
      let nt = mix(t, tgt, 0.5 * f32(k + 1));
      let dt = nt - t;
      let p = pos0 + (t + dt * 0.5) * rd;
      t = nt;
      let s = scatteringAt(p);
      let st = exp(-dt * s.ext);
      let sunT = sampleT(p, sunDir);
      let ms = sampleMS(p, sunDir);
      let inS = s.rayleigh * (rp * sunT + ms) + vec3f(s.mie) * (mp * sunT + ms);
      lum += trans * (inS - inS * st) / s.ext;
      trans *= st;
    }
    textureStore(apOut, vec3u(id.xy, slice), vec4f(lum * intensity, dot(trans, vec3f(1.0 / 3.0))));
  }
}
