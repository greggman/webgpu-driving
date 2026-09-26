// Physically based atmosphere after Hillaire 2020, "A Scalable and Production
// Ready Sky and Atmosphere Rendering Technique". Units: megameters (Mm), so
// scattering coefficients below are per Mm.
// Requires frame.wgsl (F) for sun direction / mie scale.

const GROUND_R = 6.360;
const TOP_R = 6.460;
const RAYLEIGH_SCAT = vec3f(5.802, 13.558, 33.1);
const MIE_SCAT = 3.996;
const MIE_ABS = 4.4;
const OZONE_ABS = vec3f(0.650, 1.881, 0.085);
const GROUND_ALBEDO = vec3f(0.25);
const SUN_INTENSITY = 20.0;

struct Scat {
  rayleigh: vec3f,
  mie: f32,
  ext: vec3f,
};

fn scatteringAt(pos: vec3f) -> Scat {
  let altKm = (length(pos) - GROUND_R) * 1000.0;
  let rd = exp(-altKm / 8.0);
  let md = exp(-altKm / 1.2) * F.fog.w;
  var s: Scat;
  s.rayleigh = RAYLEIGH_SCAT * rd;
  s.mie = MIE_SCAT * md;
  let ozone = max(0.0, 1.0 - abs(altKm - 25.0) / 15.0);
  s.ext = s.rayleigh + vec3f(s.mie + MIE_ABS * md) + OZONE_ABS * ozone;
  return s;
}

fn miePhase(c: f32) -> f32 {
  let g = 0.8;
  let scale = 3.0 / (8.0 * PI);
  let num = (1.0 - g * g) * (1.0 + c * c);
  let den = (2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * c, 1.5);
  return scale * num / den;
}

fn rayleighPhase(c: f32) -> f32 {
  return 3.0 * (1.0 + c * c) / (16.0 * PI);
}

// Distance to sphere of radius r from ro along rd (-1 if none ahead).
fn raySphere(ro: vec3f, rd: vec3f, r: f32) -> f32 {
  let b = dot(ro, rd);
  let c = dot(ro, ro) - r * r;
  if (c > 0.0 && b > 0.0) { return -1.0; }
  let disc = b * b - c;
  if (disc < 0.0) { return -1.0; }
  if (disc > b * b) { return -b + sqrt(disc); }
  return -b - sqrt(disc);
}

fn tlutUV(pos: vec3f, sunDir: vec3f) -> vec2f {
  let h = length(pos);
  let up = pos / h;
  let c = dot(sunDir, up);
  return vec2f(clamp(0.5 + 0.5 * c, 0.0, 1.0), clamp((h - GROUND_R) / (TOP_R - GROUND_R), 0.0, 1.0));
}
