// Car bodies and wheels. Clear-coated metallic paint with flakes, tinted
// glass, trim, and emissive head/tail lights.

struct Car {
  model: mat4x4f,
  prevModel: mat4x4f,
  color: vec4f,   // paint rgb, metallic
  p0: vec4f,      // wheelbase, track, wheel radius, wheel spin angle
  p1: vec4f,      // steer, brake, lights on, dirt
  p2: vec4f,      // half length, half width, front cap y, rear cap y
};

@group(1) @binding(0) var<storage, read> cars: array<Car>;
@group(2) @binding(0) var<uniform> shadowVP: mat4x4f;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) mat: f32,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) prevWorld: vec3f,
  @location(2) normal: vec3f,
  @location(3) local: vec3f,
  @location(4) @interpolate(flat) mat: u32,
  @location(5) @interpolate(flat) car: u32,
};

@vertex
fn vsBody(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let c = cars[ii];
  var o: VOut;
  let w = c.model * vec4f(v.pos, 1.0);
  o.world = w.xyz;
  o.prevWorld = (c.prevModel * vec4f(v.pos, 1.0)).xyz;
  o.pos = F.viewProj * w;
  o.normal = (c.model * vec4f(v.normal, 0.0)).xyz;
  o.local = v.pos;
  o.mat = u32(v.mat + 0.5);
  o.car = ii;
  return o;
}

fn wheelLocal(p: vec3f, ci: u32, wi: u32, spinOffset: f32) -> vec3f {
  let c = cars[ci];
  let R = c.p0.z;
  let front = wi < 2u;
  let side = select(-1.0, 1.0, (wi & 1u) == 1u);
  // Mirror the wheel for the left side so the rim faces outward.
  var q = vec3f(p.x * side, p.y, p.z) * R;
  let a = c.p0.w + spinOffset;
  let ca = cos(a);
  let sa = sin(a);
  q = vec3f(q.x, q.y * ca - q.z * sa, q.y * sa + q.z * ca);
  if (front) {
    let st = c.p1.x;
    let cs = cos(st);
    let ss = sin(st);
    q = vec3f(q.x * cs + q.z * ss, q.y, -q.x * ss + q.z * cs);
  }
  let off = vec3f(side * (c.p0.y * 0.5), R, select(-0.5, 0.5, front) * c.p0.x);
  return q + off;
}

@vertex
fn vsWheel(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let ci = ii / 4u;
  let wi = ii % 4u;
  let c = cars[ci];
  let lp = wheelLocal(v.pos, ci, wi, 0.0);
  let side = select(-1.0, 1.0, (wi & 1u) == 1u);
  var ln = vec3f(v.normal.x * side, v.normal.yz);
  let a = c.p0.w;
  ln = vec3f(ln.x, ln.y * cos(a) - ln.z * sin(a), ln.y * sin(a) + ln.z * cos(a));
  var o: VOut;
  let w = c.model * vec4f(lp, 1.0);
  o.world = w.xyz;
  o.prevWorld = (c.prevModel * vec4f(wheelLocal(v.pos, ci, wi, -c.p1.w * 0.0), 1.0)).xyz;
  o.pos = F.viewProj * w;
  o.normal = (c.model * vec4f(ln, 0.0)).xyz;
  // Rim-space coordinates for the spoke pattern (unrotated wheel).
  o.local = v.pos;
  o.mat = u32(v.mat + 0.5);
  o.car = ci;
  return o;
}

@vertex
fn vsBodyShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return shadowVP * (cars[ii].model * vec4f(v.pos, 1.0));
}

@vertex
fn vsWheelShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let ci = ii / 4u;
  return shadowVP * (cars[ci].model * vec4f(wheelLocal(v.pos, ci, ii % 4u, 0.0), 1.0));
}

// Car-commercial environment: sky above a sharp dark horizon.
fn carEnv(r: vec3f, rough: f32) -> vec3f {
  if (r.y >= 0.0) {
    let rr = normalize(vec3f(r.x, max(r.y, 0.03), r.z));
    let sky = skyRadiance(rr);
    return mix(sky, shIrradiance(vec3f(0.0, 1.0, 0.0)), saturate(rough * 1.5));
  }
  let horizon = skyRadiance(normalize(vec3f(r.x, 0.03, r.z)));
  let ground = shIrradiance(vec3f(0.0, 1.0, 0.0)) * 0.15;
  return mix(horizon * 0.35, ground, saturate(-r.y * 6.0 + rough));
}

fn clearcoatShade(base: Surface, wp: vec3f, sh: f32, coat: f32) -> vec3f {
  var col = shadeSurface(base, wp, sh);
  if (coat <= 0.0) { return col; }
  let v = normalize(F.cam.xyz - wp);
  let n = base.n;
  let nv = saturate(dot(n, v));
  let fc = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  let r = reflect(-v, n);
  let l = F.sun.xyz;
  let h = normalize(v + l);
  let nl = saturate(dot(n, l));
  let spec = D_GGX(saturate(dot(n, h)), 0.035) * V_SmithGGX(max(nv, 1e-3), nl, 0.035) * fc;
  col = col * (1.0 - fc * coat) + (carEnv(r, 0.03) * fc + spec * F.sunColor.rgb * sh * nl) * coat;
  return col;
}

@fragment
fn fs(in: VOut) -> GBufferOut {
  let c = cars[in.car];
  var n = normalize(in.normal);
  let wp = in.world;
  let lp = in.local;
  let v = normalize(F.cam.xyz - wp);
  if (dot(n, v) < 0.0) { n = -n; }
  var s: Surface;
  s.n = n;
  s.ao = 1.0;
  s.spec = 1.0;
  s.sss = 0.0;
  s.metal = 0.0;
  var coat = 0.0;
  var emissive = vec3f(0.0);
  let lightsOn = c.p1.z;
  let halfL = c.p2.x;
  let halfW = c.p2.y;
  // Ambient occlusion toward the underside and wheel wells.
  let ao = saturate(0.45 + lp.y * 0.9);
  var mat = in.mat;

  // Head / tail light zones on the body.
  var isHead = false;
  var isTail = false;
  var isGrille = false;
  if (mat == 0u || mat == 3u) {
    let ax = abs(lp.x) / halfW;
    if (lp.z > halfL - 0.32 && lp.y > c.p2.z - 0.04 && lp.y < c.p2.z + 0.14 && ax > 0.5 && ax < 0.93) {
      isHead = true;
    }
    if (mat == 3u && ax < 0.45 && lp.y < c.p2.z - 0.02 && lp.y > c.p2.z - 0.22) {
      isGrille = true;
    }
  }
  if (mat == 0u || mat == 4u) {
    let ax = abs(lp.x) / halfW;
    if (lp.z < -halfL + 0.2 && lp.y > c.p2.w - 0.02 && lp.y < c.p2.w + 0.18 && ax > 0.55) {
      isTail = true;
    }
  }

  if (isHead) {
    s.albedo = vec3f(0.6);
    s.rough = 0.05;
    s.metal = 1.0;
    let beam = 0.3 + 30.0 * lightsOn;
    emissive = vec3f(1.0, 0.97, 0.9) * beam * smoothstep(0.1, 0.0, abs(fract(lp.x * 8.0) - 0.5) - 0.3);
    emissive = max(emissive, vec3f(1.0, 0.97, 0.9) * (0.2 + 8.0 * lightsOn));
  } else if (isTail) {
    s.albedo = vec3f(0.35, 0.02, 0.02);
    s.rough = 0.1;
    let brake = c.p1.y;
    emissive = vec3f(1.0, 0.05, 0.02) * (0.15 + 4.0 * lightsOn + 10.0 * brake);
  } else if (isGrille) {
    let slat = step(0.5, fract(lp.y * 40.0));
    s.albedo = vec3f(0.02 + 0.03 * slat);
    s.rough = 0.4;
  } else if (mat == 0u || mat == 3u || mat == 4u) {
    // Paint with metallic flakes and a clear coat.
    let flakeCell = floor(lp * 900.0);
    let fh = hash01(i32(flakeCell.x + flakeCell.z * 13.0), i32(flakeCell.y));
    let fn2 = vec3f(hash01(i32(flakeCell.x), i32(flakeCell.y + 7.0)), fh, hash01(i32(flakeCell.z), i32(flakeCell.x + 3.0))) - 0.5;
    s.n = normalize(n + fn2 * 0.25 * c.color.w);
    s.albedo = c.color.rgb;
    s.metal = c.color.w;
    s.rough = 0.38;
    coat = 1.0;
    // Road grime toward the bottom.
    let grime = saturate((0.45 - lp.y) * 3.0) * c.p1.w;
    s.albedo = mix(s.albedo, vec3f(0.12, 0.1, 0.08), grime);
    coat *= 1.0 - grime;
    if (mat == 3u || mat == 4u) {
      // Bumper lower valance in black.
      if (lp.y < c.p2.z - 0.25 || (mat == 4u && lp.y < c.p2.w - 0.12)) {
        s.albedo = vec3f(0.03);
        s.metal = 0.0;
        s.rough = 0.55;
        coat = 0.0;
      }
    }
  } else if (mat == 1u) {
    // Glass: dark, very smooth, strongly reflective at grazing angles.
    s.albedo = vec3f(0.015, 0.018, 0.02);
    s.rough = 0.02;
    coat = 1.0;
  } else if (mat == 2u) {
    s.albedo = vec3f(0.025);
    s.rough = 0.55;
  } else if (mat == 5u) {
    s.albedo = vec3f(0.02);
    s.rough = 0.9;
  } else if (mat == 6u) {
    s.albedo = vec3f(0.9);
    s.metal = 1.0;
    s.rough = 0.12;
  } else if (mat == 7u) {
    // Tire rubber, tread grooves on the tread face.
    let groove = step(0.8, fract(lp.x * 9.0 + 0.5));
    s.albedo = vec3f(0.025 - 0.01 * groove);
    s.rough = 0.85;
  } else {
    // Rim: machined alloy with 5 spokes.
    let a = atan2(lp.z, lp.y);
    let r = length(lp.yz);
    let spoke = smoothstep(0.55, 0.75, cos(a * 5.0)) ;
    let hub = 1.0 - smoothstep(0.18, 0.22, r);
    let solid = max(spoke, hub);
    s.albedo = mix(vec3f(0.04), vec3f(0.75), max(solid, step(0.6, r)));
    s.metal = mix(0.0, 1.0, max(solid, step(0.6, r)));
    s.rough = 0.25;
  }
  s.ao = ao;
  let sh = sunShadow(wp, s.n) * cloudShadow(wp);
  var col = clearcoatShade(s, wp, sh, coat);
  col += emissive;
  col = finishColor(col, wp);
  return gbuffer(col, wp, in.prevWorld, s.n, s.rough);
}
