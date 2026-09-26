// Group-0 resources available to every render pass (see frameData.ts).
@group(0) @binding(1) var roadTex: texture_2d<f32>;
@group(0) @binding(2) var clipTex: texture_2d_array<f32>;
@group(0) @binding(3) var transLUT: texture_2d<f32>;
@group(0) @binding(4) var skyLUT: texture_2d<f32>;
@group(0) @binding(5) var apLUT: texture_3d<f32>;
@group(0) @binding(6) var linSampler: sampler;
@group(0) @binding(7) var shadowMap: texture_depth_2d_array;
@group(0) @binding(8) var shadowSampler: sampler_comparison;
@group(0) @binding(9) var repSampler: sampler;
@group(0) @binding(10) var<storage, read> lightsBuf: array<Light>;
@group(0) @binding(11) var matTex: texture_2d_array<f32>;
@group(0) @binding(12) var cloudTex: texture_2d<f32>;

struct Light {
  pos: vec4f,   // xyz local, w = range
  dir: vec4f,   // xyz spot direction, w = cos outer angle (-2 = point)
  color: vec4f, // rgb intensity, w = cos inner angle
};

// Clipmap sample (manual bilinear; rgba32float may not be filterable).
// Returns (height, dh/dx, dh/dz, road distance d).
fn clipSampleLevel(p: vec2f, level: i32) -> vec4f {
  let c = F.clip[level];
  let uv = (p - c.xy) * c.w;
  let i0 = floor(uv);
  let t = uv - i0;
  let ii = vec2i(i0);
  let mx = CLIP_RES - 1;
  let a = textureLoad(clipTex, clamp(ii, vec2i(0), vec2i(mx)), level, 0);
  let b = textureLoad(clipTex, clamp(ii + vec2i(1, 0), vec2i(0), vec2i(mx)), level, 0);
  let cc = textureLoad(clipTex, clamp(ii + vec2i(0, 1), vec2i(0), vec2i(mx)), level, 0);
  let d = textureLoad(clipTex, clamp(ii + vec2i(1, 1), vec2i(0), vec2i(mx)), level, 0);
  return mix(mix(a, b, t.x), mix(cc, d, t.x), t.y);
}

// Finest level >= minLevel that contains p with a safety margin.
fn clipLevelFor(p: vec2f, minLevel: i32) -> i32 {
  for (var l = minLevel; l < CLIP_LEVELS; l++) {
    let c = F.clip[l];
    let ext = c.z * f32(CLIP_RES - 1);
    let m = c.z * 4.0;
    let q = p - c.xy;
    if (all(q > vec2f(m)) && all(q < vec2f(ext - m))) {
      return l;
    }
  }
  return CLIP_LEVELS - 1;
}

// Blends between the chosen level and the next coarser one near the border
// so level transitions are invisible.
fn clipSample(p: vec2f, minLevel: i32) -> vec4f {
  let l = clipLevelFor(p, minLevel);
  let v = clipSampleLevel(p, l);
  if (l >= CLIP_LEVELS - 1) { return v; }
  let c = F.clip[l];
  let ext = c.z * f32(CLIP_RES - 1);
  let q = (p - c.xy) / ext;
  let edge = min(min(q.x, q.y), min(1.0 - q.x, 1.0 - q.y));
  let w = smoothstep(0.08, 0.03, edge);
  if (w <= 0.0) { return v; }
  return mix(v, clipSampleLevel(p, l + 1), w);
}

fn terrainNormal(g: vec4f) -> vec3f {
  return normalize(vec3f(-g.y, 1.0, -g.z));
}

// ---- Atmosphere helpers (megameter units, see atmosphere.wgsl) ----
const EARTH_R = 6.360;
const ATMOS_R = 6.460;

fn transmittanceAt(r: f32, mu: f32) -> vec3f {
  let uv = vec2f(clamp(0.5 + 0.5 * mu, 0.0, 1.0), clamp((r - EARTH_R) / (ATMOS_R - EARTH_R), 0.0, 1.0));
  return textureSampleLevel(transLUT, linSampler, uv, 0.0).rgb;
}

// Aerial perspective: returns (inscatter rgb, transmittance) for a world point.
fn aerialPerspective(worldPos: vec3f) -> vec4f {
  let clip = F.viewProjNJ * vec4f(worldPos, 1.0);
  let ndc = clip.xy / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let dist = length(worldPos - F.cam.xyz) * 0.001; // km
  // Slices are distributed quadratically up to AP_MAX_KM (48 km).
  let w = sqrt(clamp(dist / 48.0, 0.0, 1.0));
  let ap = textureSampleLevel(apLUT, linSampler, vec3f(clamp(uv, vec2f(0.0), vec2f(1.0)), w), 0.0);
  // Fade in over the first slice (no scattering at zero distance).
  let f = saturate(w * 32.0);
  return vec4f(ap.rgb * f, mix(1.0, ap.a, f));
}

// Exponential height fog (snow storms, valley haze) on top of aerial
// perspective. density(y) = F.fog.x * exp(-(y - F.fog.z) / F.fog.y).
fn fogTransmittance(worldPos: vec3f) -> f32 {
  let dens = F.fog.x;
  if (dens <= 0.0) { return 1.0; }
  let d = worldPos - F.cam.xyz;
  let dist = length(d);
  let fall = F.fog.y;
  let e0 = exp(-max(F.cam.y - F.fog.z, -2.0 * fall) / fall);
  var od: f32;
  if (abs(d.y) > 0.05) {
    od = dens * fall * e0 * (1.0 - exp(-clamp(d.y / fall, -20.0, 20.0))) / d.y * dist;
  } else {
    od = dens * e0 * dist;
  }
  return exp(-max(od, 0.0));
}

fn applyFog(worldPos: vec3f, color: vec3f) -> vec3f {
  let t = fogTransmittance(worldPos);
  let v = normalize(worldPos - F.cam.xyz);
  return mix(fogColor(v), color, t);
}

fn fogColor(viewDir: vec3f) -> vec3f {
  // Ambient (SH0) plus a sun-facing lobe.
  let amb = F.sh[0].rgb * 0.282095 * 3.14159;
  let sunL = pow(saturate(dot(viewDir, F.sun.xyz)), 8.0);
  return amb * 1.1 + F.sunColor.rgb * sunL * 0.05;
}

// ---- Irradiance from SH9 ----
fn shIrradiance(n: vec3f) -> vec3f {
  let c1 = 0.429043;
  let c2 = 0.511664;
  let c3 = 0.743125;
  let c4 = 0.886227;
  let c5 = 0.247708;
  let L00 = F.sh[0].rgb; let L1m1 = F.sh[1].rgb; let L10 = F.sh[2].rgb; let L11 = F.sh[3].rgb;
  let L2m2 = F.sh[4].rgb; let L2m1 = F.sh[5].rgb; let L20 = F.sh[6].rgb; let L21 = F.sh[7].rgb; let L22 = F.sh[8].rgb;
  let x = n.x; let y = n.y; let z = n.z;
  let e = c1 * L22 * (x * x - y * y) + c3 * L20 * z * z + c4 * L00 - c5 * L20
    + 2.0 * c1 * (L2m2 * x * y + L21 * x * z + L2m1 * y * z)
    + 2.0 * c2 * (L11 * x + L1m1 * y + L10 * z);
  return max(e, vec3f(0.0)) / PI;
}
