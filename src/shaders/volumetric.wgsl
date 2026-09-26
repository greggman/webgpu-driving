// Froxel volumetric fog: a frustum-aligned 160x90x64 grid (exponential depth
// slices out to VOL_FAR). Each froxel's in-scattering comes from the sun
// (through the cascaded shadow maps -> god rays), the sky ambient, and the
// nearest spot lights (headlight beams). A second step integrates front to
// back so surfaces can look up (inscatter, transmittance) at their depth.

const VOL_W = 160u;
const VOL_H = 90u;
const VOL_D = 64u;
const VOL_NEAR = 0.5;
const VOL_FAR = 220.0;

@group(0) @binding(7) var shadowMapV: texture_depth_2d_array;
@group(0) @binding(8) var shadowSamplerV: sampler_comparison;
@group(0) @binding(10) var<storage, read> lightsV: array<Light>;
@group(0) @binding(12) var cloudTexV: texture_2d<f32>;
@group(0) @binding(9) var repSamplerV: sampler;
@group(0) @binding(13) var volOut: texture_storage_3d<rgba16float, write>;

struct Light {
  pos: vec4f,
  dir: vec4f,
  color: vec4f,
};

fn sliceDepth(s: f32) -> f32 {
  return VOL_NEAR * pow(VOL_FAR / VOL_NEAR, s / f32(VOL_D));
}

fn volShadow(p: vec3f) -> f32 {
  let viewZ = -(F.view * vec4f(p, 1.0)).z;
  var ci = 3;
  for (var i = 0; i < 4; i++) {
    if (viewZ < F.cascade[i]) { ci = i; break; }
  }
  let sp = F.shadow[ci] * vec4f(p, 1.0);
  let uv = vec2f(sp.x * 0.5 + 0.5, 0.5 - sp.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  return textureSampleCompareLevel(shadowMapV, shadowSamplerV, uv, ci, sp.z + 0.0005);
}

fn hgPhase(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= VOL_W || id.y >= VOL_H) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(f32(VOL_W), f32(VOL_H));
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let wp = F.invViewProj * vec4f(ndc, 0.5, 1.0);
  let rd = normalize(wp.xyz / wp.w - F.cam.xyz);
  // Distance along the ray per unit of view depth.
  let cosF = max(dot(rd, F.camFwd.xyz), 0.05);
  let density0 = F.volume.x;
  let g = F.volume.y;
  let heightFall = F.volume.z;
  let baseY = F.fog.z;
  let sunPhase = hgPhase(dot(rd, F.sun.xyz), g);
  let amb = F.sh[0].rgb * 0.282095 * 3.14159;
  let sunC = F.sunColor.rgb;
  let jitter = fract(52.9829189 * fract(dot(vec2f(id.xy), vec2f(0.06711056, 0.00583715))) + F.misc2.z * 0.618);
  var lum = vec3f(0.0);
  var trans = 1.0;
  var prevT = 0.0;
  let nLights = min(u32(F.lights.x), 8u);
  for (var s = 0u; s < VOL_D; s++) {
    let tEnd = sliceDepth(f32(s) + 1.0) / cosF;
    let tMid = sliceDepth(f32(s) + jitter) / cosF;
    let dt = tEnd - prevT;
    prevT = tEnd;
    let p = F.cam.xyz + rd * tMid;
    // Density: height falloff + drifting wisps.
    let wp2 = p.xz + F.misc.xy + F.weather.xy * F.cam.w * 2.0;
    let wisps = 0.55 + 0.9 * vnoise3(vec3f(wp2 * 0.035, p.y * 0.06 + F.cam.w * 0.05));
    let dens = density0 * exp(-max(p.y - baseY, 0.0) / heightFall) * wisps;
    if (dens > 1e-6) {
      var inS = amb * 0.25;
      if (F.sun.y > -0.05) {
        let sh = volShadow(p);
        // Cloud shadows on the volume too.
        inS += sunC * sunPhase * sh;
      }
      for (var i = 0u; i < nLights; i++) {
        let L = lightsV[i];
        if (L.dir.w < -1.5) { continue; }
        let d = L.pos.xyz - p;
        let dist2 = dot(d, d);
        if (dist2 > L.pos.w * L.pos.w) { continue; }
        let l = d * inverseSqrt(dist2);
        let cone = smoothstep(L.dir.w, L.color.w, dot(-l, L.dir.xyz));
        inS += L.color.rgb * 0.08 * cone * hgPhase(dot(rd, -l), 0.5) / max(dist2, 9.0);
      }
      let ext = dens;
      let st = exp(-ext * dt);
      lum += trans * inS * dens * (1.0 - st) / max(ext, 1e-6);
      trans *= st;
    }
    textureStore(volOut, vec3u(id.xy, s), vec4f(lum, trans));
  }
}
