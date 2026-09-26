// Per-frame uniform shared by every pass. Layout mirrored in
// src/render/frameData.ts (FRAME_FIELDS) — keep in sync.
struct Frame {
  viewProj: mat4x4f,      // jittered
  viewProjNJ: mat4x4f,    // unjittered
  prevViewProj: mat4x4f,  // unjittered, previous frame (same origin)
  invViewProj: mat4x4f,   // unjittered inverse
  view: mat4x4f,
  shadow: array<mat4x4f, 4>,
  cascade: vec4f,         // cascade far distances
  cam: vec4f,             // xyz = camera (local), w = time (s)
  sun: vec4f,             // xyz = direction to main light, w = 1 if sun, 0 if moon
  sunColor: vec4f,        // rgb = light illuminance at ground, w = exposure
  moon: vec4f,            // xyz = moon direction, w = night factor 0..1
  misc: vec4f,            // origin.x, origin.z, width, height
  misc2: vec4f,           // jitter.xy (ndc), -, -
  road: vec4f,            // road tex z base (local), dz, count, paved half width
  weather: vec4f,         // wind.xz, snow, wetness
  camRight: vec4f,
  camUp: vec4f,
  camFwd: vec4f,          // w = tan(fovY/2)
  clip: array<vec4f, 8>,  // clipmap levels: min.xz (local), texel, 1/texel
  sh: array<vec4f, 9>,    // sky irradiance SH9 (rgb)
  terrain: array<vec4f, 8>,
  palette: array<vec4f, 12>,
  sky: vec4f,             // cloud coverage, cloud scale, dust, star brightness
  lights: vec4f,          // light count, headlight intensity, lane width, lanes per dir
  prevCam: vec4f,
  grade: vec4f,           // rgb balance, saturation
  grade2: vec4f,          // contrast, vignette, grain, letterbox
  car: vec4f,             // player car pos (local) xyz, heading
  fog: vec4f,             // density at base, falloff height, base height, mie scale
  volume: vec4f,          // volumetric fog density, anisotropy g, height falloff, enabled
    post: vec4f,            // bloom strength, -, -, -
  weather2: vec4f,        // rain 0..1, lightning flash, strike direction xz
  glass: vec4f,           // player speed (m/s), glass FX on, wipers on, -
};

@group(0) @binding(0) var<uniform> F: Frame;

const PI = 3.14159265359;
const CLIP_LEVELS = 8;
const CLIP_RES = 512;

fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn saturate3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.0), vec3f(1.0)); }
fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn pal(i: i32) -> vec3f { return F.palette[i].rgb; }
