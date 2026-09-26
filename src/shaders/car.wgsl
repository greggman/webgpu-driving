// Car bodies and wheels. Clear-coated metallic paint with flakes, tinted
// glass, trim, and emissive head/tail lights.

struct Car {
  model: mat4x4f,
  prevModel: mat4x4f,
  color: vec4f,   // paint rgb, metallic
  p0: vec4f,      // wheelbase, track, wheel radius, wheel spin angle
  p1: vec4f,      // steer, brake, lights on, dirt
  p2: vec4f,      // half length, half width, front cap y, rear cap y
  p3: vec4f,      // windshield base z, B-pillar z, rear glass base z, beltline y
  p4: vec4f,      // interior view (1), speed km/h, rpm, steering wheel angle
  p5: vec4f,      // steering wheel center xyz, tilt
  p6: vec4f,      // driver x, dash top y, -, -
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
  @location(6) lnormal: vec3f,
};

// Steering wheel vertices spin around the column axis.
fn steerLocal(p: vec3f, mat: f32, c: Car) -> vec3f {
  if (u32(mat + 0.5) != 13u) { return p; }
  let axis = vec3f(0.0, sin(c.p5.w), -cos(c.p5.w));
  let q = p - c.p5.xyz;
  let a = c.p4.w;
  let cs = cos(a);
  let sn = sin(a);
  let r = q * cs + cross(axis, q) * sn + axis * dot(axis, q) * (1.0 - cs);
  return c.p5.xyz + r;
}

fn steerNormal(n: vec3f, mat: f32, c: Car) -> vec3f {
  if (u32(mat + 0.5) != 13u) { return n; }
  let axis = vec3f(0.0, sin(c.p5.w), -cos(c.p5.w));
  let a = c.p4.w;
  return n * cos(a) + cross(axis, n) * sin(a) + axis * dot(axis, n) * (1.0 - cos(a));
}

@vertex
fn vsBody(v0: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let c = cars[ii];
  var v = v0;
  v.pos = steerLocal(v0.pos, v0.mat, c);
  v.normal = steerNormal(v0.normal, v0.mat, c);
  var o: VOut;
  let w = c.model * vec4f(v.pos, 1.0);
  o.world = w.xyz;
  o.prevWorld = (c.prevModel * vec4f(v.pos, 1.0)).xyz;
  o.pos = F.viewProj * w;
  o.normal = (c.model * vec4f(v.normal, 0.0)).xyz;
  o.local = v.pos;
  o.mat = u32(v.mat + 0.5);
  o.car = ii;
  o.lnormal = v.normal;
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
  o.lnormal = v.normal;
  return o;
}

struct CSOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) mat: u32,
};

@vertex
fn vsBodyShadow(v: VIn, @builtin(instance_index) ii: u32) -> CSOut {
  var o: CSOut;
  o.pos = shadowVP * (cars[ii].model * vec4f(v.pos, 1.0));
  o.mat = u32(v.mat + 0.5);
  return o;
}

@fragment
fn fsShadow(in: CSOut) {
  // Glass lets sunlight into the cabin.
  if (in.mat == 1u) { discard; }
}

@vertex
fn vsWheelShadow(v: VIn, @builtin(instance_index) ii: u32) -> CSOut {
  let ci = ii / 4u;
  var o: CSOut;
  o.pos = shadowVP * (cars[ci].model * vec4f(wheelLocal(v.pos, ci, ii % 4u, 0.0), 1.0));
  o.mat = 7u;
  return o;
}

// Car reflection environment: the shared prefiltered environment map
// (sky + clouds + distant hills band + ground).
fn carEnv(r: vec3f, rough: f32) -> vec3f {
  return envRadiance(r, rough);
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

fn dial(uv: vec2f, value: f32, maxV: f32, ticks: f32) -> vec4f {
  // uv in [-1,1]^2; returns (rgb emissive, coverage)
  let r = length(uv);
  let a = atan2(uv.x, uv.y); // 0 at top, clockwise positive
  let start = -2.35;
  let span = 4.7;
  var col = vec3f(0.0);
  var cov = 0.0;
  // Ring.
  let ring = smoothstep(0.03, 0.0, abs(r - 0.92));
  // Ticks.
  let t = (a - start) / span;
  if (t >= 0.0 && t <= 1.0) {
    let tk = abs(fract(t * ticks + 0.5) - 0.5);
    let tick = smoothstep(0.05, 0.02, tk) * step(0.72, r) * step(r, 0.88);
    col += vec3f(0.9) * tick;
  }
  // Needle.
  let na = start + span * saturate(value / maxV);
  let nd = vec2f(sin(na), cos(na));
  let along = dot(uv, nd);
  let perp = abs(uv.x * nd.y - uv.y * nd.x);
  let needle = smoothstep(0.035, 0.015, perp) * step(-0.1, along) * step(along, 0.85);
  col += vec3f(1.0, 0.15, 0.05) * needle * 2.0;
  col += vec3f(0.5, 0.7, 1.0) * ring * 0.6;
  cov = step(r, 1.0);
  return vec4f(col, cov);
}

fn interiorShade(mat: u32, lp: vec3f, c: Car) -> vec4f {
  // Returns (albedo rgb, roughness) or emissive handled by caller.
  if (mat == 12u) {
    // Tan leather with perforation pattern.
    let perf = step(0.85, vnoise(lp.xz * 120.0));
    return vec4f(vec3f(0.32, 0.19, 0.1) * (1.0 - 0.25 * perf), 0.55);
  }
  if (mat == 13u) { return vec4f(vec3f(0.03), 0.75); }
  if (mat == 15u) { return vec4f(vec3f(0.25), 0.45); }
  if (mat == 17u) { return vec4f(vec3f(0.025), 0.95); }
  // Dashboard: soft-touch dark plastic with a fine grain.
  return vec4f(vec3f(0.05, 0.05, 0.055) * (0.9 + 0.2 * vnoise(lp.xz * 80.0)), 0.7);
}

@fragment
fn fs(in: VOut, @builtin(front_facing) ff: bool) -> GBufferOut {
  let c = cars[in.car];
  var n = normalize(in.normal);
  let wp = in.world;
  let lp = in.local;
  let v = normalize(F.cam.xyz - wp);
  let interior = c.p4.x > 0.5;
  if (interior && in.mat == 1u) { discard; }
  if (dot(n, v) < 0.0) { n = -n; }
  // Cabin materials (interior mesh, or the inside of the body shell).
  if (in.mat >= 10u || (interior && !ff && in.mat != 7u && in.mat != 8u)) {
    var s: Surface;
    let im = interiorShade(select(10u, in.mat, in.mat >= 10u), lp, c);
    s.albedo = im.rgb;
    s.rough = im.a;
    if (in.mat < 10u) {
      // Inside of the shell: fabric headliner above, soft-touch door cards below.
      let lnI = normalize(in.lnormal);
      if (lnI.y > 0.45) {
        s.albedo = vec3f(0.32, 0.3, 0.27) * (0.9 + 0.1 * vnoise(lp.xz * 60.0));
        s.rough = 0.95;
      } else {
        let stitch = step(0.96, fract(lp.y * 9.0));
        s.albedo = vec3f(0.07, 0.065, 0.06) + vec3f(0.08, 0.05, 0.03) * stitch;
        s.rough = 0.8;
      }
    }
    s.metal = select(0.0, 1.0, in.mat == 15u);
    s.n = n;
    s.ao = 0.7;
    s.spec = 0.5;
    s.sss = 0.0;
    var emissive = vec3f(0.0);
    let dashLight = 0.25 + 1.5 * c.p1.z;
    if (in.mat == 11u) {
      // Gauge cluster: speedometer (left) and tachometer (right).
      let gu = vec2f((c.p6.x - lp.x) / 0.19, (lp.y - (c.p6.y - 0.065)) / 0.065);
      s.albedo = vec3f(0.01);
      s.rough = 0.2;
      let speedo = dial((gu - vec2f(-0.5, 0.0)) * vec2f(2.0 * 0.19 / 0.065 / 2.0, 1.0) * 1.05, c.p4.y, 240.0, 12.0);
      let tach = dial((gu - vec2f(0.5, 0.0)) * vec2f(2.0 * 0.19 / 0.065 / 2.0, 1.0) * 1.05, c.p4.z, 8000.0, 8.0);
      emissive = (speedo.rgb + tach.rgb) * dashLight;
    } else if (in.mat == 14u) {
      // Navigation screen: stylised map with the route.
      let su = vec2f(lp.x / 0.14, (lp.y - (c.p6.y + 0.025)) / 0.075);
      let road = smoothstep(0.08, 0.04, abs(su.x - 0.3 * sin(su.y * 2.0 + c.p1.x * 4.0)));
      let grid = step(0.95, fract(su.x * 5.0)) + step(0.95, fract(su.y * 3.0));
      let base = vec3f(0.02, 0.05, 0.08) + vec3f(0.03, 0.06, 0.05) * grid;
      emissive = (base + vec3f(0.1, 0.5, 1.0) * road) * dashLight * 2.0;
      s.albedo = vec3f(0.005);
      s.rough = 0.1;
    } else if (in.mat == 16u) {
      // Rear-view mirror: dim reflection of the sky behind.
      s.albedo = vec3f(0.12);
      s.metal = 1.0;
      s.rough = 0.15;
    }
    let sh = sunShadow(wp, n) * cloudShadow(wp);
    var col = shadeSurface(s, wp, sh) + emissive;
    col = finishColor(col, wp);
    return gbuffer(col, wp, in.prevWorld, n, s.rough);
  }
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

  // Fascia details from local position + local normal.
  let ln = normalize(in.lnormal);
  let ax = abs(lp.x) / halfW;
  var isHead = false;
  var isTail = false;
  var isGrille = false;
  var isBlack = false;
  if (mat == 0u || mat == 3u || mat == 4u) {
    let capF = c.p2.z;
    let capR = c.p2.w;
    if (lp.z > halfL - 0.4 && ln.z > 0.15 && lp.y > capF - 0.02 && lp.y < capF + 0.13 && ax > 0.42 && ax < 0.9) {
      isHead = true;
    }
    if (lp.z > halfL - 0.25 && ln.z > 0.5 && ax < 0.42 && lp.y < capF - 0.03 && lp.y > capF - 0.24) {
      isGrille = true;
    }
    // Full-width tail light bar + corner clusters.
    if (lp.z < -halfL + 0.35 && ln.z < -0.2) {
      let bar = abs(lp.y - (capR + 0.06)) < 0.035;
      let corner = ax > 0.62 && lp.y > capR - 0.03 && lp.y < capR + 0.14;
      if (bar || corner) { isTail = true; }
    }
    // Black lower bumpers / valances.
    if (abs(lp.z) > halfL - 0.45 && lp.y < 0.36) { isBlack = true; }
    // Wheel arch liners.
    let wr = c.p0.z;
    for (var w = 0; w < 2; w++) {
      let az = select(-0.5, 0.5, w == 0) * c.p0.x;
      let dd = length(vec2f(lp.z - az, lp.y - wr));
      // Only the arch undersides (downward-facing), not the fender skin.
      if (dd < wr + 0.09 && ax > 0.7 && ln.y < -0.2) { isBlack = true; }
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
  } else if (isBlack) {
    s.albedo = vec3f(0.018);
    s.rough = 0.6;
  } else if (mat == 0u || mat == 3u || mat == 4u) {
    // Paint with metallic flakes and a clear coat.
    let flakeCell = floor(lp * 2500.0);
    let fh = hash01(i32(flakeCell.x + flakeCell.z * 13.0), i32(flakeCell.y));
    let fn2 = vec3f(hash01(i32(flakeCell.x), i32(flakeCell.y + 7.0)), fh, hash01(i32(flakeCell.z), i32(flakeCell.x + 3.0))) - 0.5;
    s.n = normalize(n + fn2 * 0.06 * c.color.w);
    s.albedo = c.color.rgb;
    s.metal = c.color.w;
    s.rough = 0.38;
    coat = 1.0;
    // Road grime toward the bottom.
    let grime = saturate((0.45 - lp.y) * 3.0) * c.p1.w;
    s.albedo = mix(s.albedo, vec3f(0.12, 0.1, 0.08), grime);
    coat *= 1.0 - grime;
    // Door and hood/trunk panel seams.
    if (ax > 0.86 && lp.y < c.p3.w && lp.y > 0.25) {
      let seam = min(min(abs(lp.z - (c.p3.x - 0.05)), abs(lp.z - c.p3.y)), abs(lp.z - (c.p3.z + 0.15)));
      let line = 1.0 - smoothstep(0.003, 0.009, seam);
      s.albedo *= 1.0 - 0.8 * line;
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
    s.albedo = vec3f(0.012, 0.012, 0.014) * (1.0 - 0.4 * groove);
    s.rough = 0.9;
    s.spec = 0.15;
  } else {
    // Rim: machined alloy with 5 spokes.
    let a = atan2(lp.z, lp.y);
    let r = length(lp.yz);
    let spoke = smoothstep(0.55, 0.75, cos(a * 5.0)) ;
    let hub = 1.0 - smoothstep(0.18, 0.22, r);
    let solid = max(spoke, hub);
    s.albedo = mix(vec3f(0.03), vec3f(0.5), max(solid, step(0.6, r)));
    s.metal = mix(0.0, 1.0, max(solid, step(0.6, r)));
    s.rough = 0.32;
  }
  s.ao = ao;
  let sh = sunShadow(wp, s.n) * cloudShadow(wp);
  var col = clearcoatShade(s, wp, sh, coat);
  if (coat > 0.0 && s.metal > 0.0) {
    // Metallic base coat mirrors the environment (horizon/treeline band),
    // tinted by the paint color.
    let rr = reflect(-v, s.n);
    col += carEnv(rr, s.rough * 0.6) * s.albedo * s.metal * 0.55 * s.ao;
  }
  col += emissive;
  col = finishColor(col, wp);
  return gbuffer(col, wp, in.prevWorld, s.n, s.rough);
}

// ---- Windshield overlay (interior view): faint reflections, snow that
// collects on the glass, and wipers that sweep it clear. ----
struct GlassOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
  @location(2) normal: vec4f,
};

fn wiperAngle(t: f32) -> f32 {
  // Sweep up and back in 1.2 s, then rest 0.8 s.
  let period = 2.0;
  let ph = fract(t / period) * period;
  if (ph > 1.2) { return 0.0; }
  return sin(ph / 1.2 * PI) * 1.75;
}

@fragment
fn fsGlass(in: VOut) -> GlassOut {
  let c = cars[in.car];
  if (in.mat != 1u || c.p4.x < 0.5) { discard; }
  let lp = in.local;
  var o: GlassOut;
  o.velocity = vec2f(0.0);
  o.normal = vec4f(0.0);
  let wsBase = c.p3.x;
  let roofFront = c.p3.y + (c.p3.x - c.p3.y) * 0.0;
  // Only the windshield (front glass above the dash).
  if (lp.z < wsBase - 0.9) { discard; }
  let n = normalize(in.normal);
  let v = normalize(F.cam.xyz - in.world);
  let fres = 0.03 + 0.2 * pow(1.0 - saturate(abs(dot(n, v))), 5.0);
  var col = skyRadiance(reflect(-v, n)) * fres * 0.5;
  var a = fres * 0.3;
  // Windshield coordinates: u across (-1..1), v up the glass (0..1).
  let halfW = c.p2.y;
  let uv = vec2f(lp.x / (halfW * 0.8), saturate((wsBase - lp.z) / 0.8));
  let snow = F.weather.z;
  let t = F.cam.w;
  // Wipers pivot near the bottom of the glass.
  let ang = wiperAngle(t);
  var wiper = 0.0;
  var cleared = 0.0;
  for (var i = 0; i < 2; i++) {
    let pivot = vec2f(select(-0.62, 0.08, i == 1), -0.05);
    let d = uv - pivot;
    let r = length(d * vec2f(1.0, 1.6));
    let a0 = atan2(d.y * 1.6, -d.x);
    let bladeA = ang;
    if (r < 0.9) {
      // Blade.
      let da = abs(a0 - bladeA);
      wiper = max(wiper, smoothstep(0.03, 0.0, da * r) * step(0.08, r));
      // Area swept since the start of this cycle.
      if (a0 < bladeA + 0.02 && a0 > -0.05) { cleared = 1.0; }
    }
  }
  if (snow > 0.0) {
    // Sparse flakes landing on the glass, building up between sweeps.
    let ph = fract(t / 2.0) * 2.0;
    let cycle = floor(t / 2.0);
    let sinceSweep = select(ph - 1.2, ph + 0.8, ph < 1.2);
    let g = uv * vec2f(30.0, 16.0);
    let ci = floor(g);
    var fl = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let cc = ci + vec2f(f32(x), f32(y));
        let hh = pcg(bitcast<u32>(i32(cc.x)) + pcg(bitcast<u32>(i32(cc.y)) + u32(cycle) * 7919u));
        let h1 = rand01(hh);
        if (h1 > 0.45 * snow) { continue; }
        let h2 = rand01(pcg(hh + 1u));
        let h3 = rand01(pcg(hh + 2u));
        let h4 = rand01(pcg(hh + 3u));
        let appear = h2 * 1.9;
        if (sinceSweep < appear && !(cleared < 0.5 && ph < 1.2)) { continue; }
        let center = cc + vec2f(h3, h4);
        let r = 0.12 + 0.3 * h2 * h3;
        let d = length((g - center) * vec2f(1.0, 0.9));
        fl = max(fl, smoothstep(r, r * 0.35, d) * (0.55 + 0.45 * h4));
      }
    }
    fl *= snow;
    // Wet snow on glass is lit from the bright sky behind it.
    let back = vec3f(luminance(skyRadiance(normalize(-v + vec3f(0.0, 0.3, 0.0))) * 0.6 + shIrradiance(vec3f(0.0, 1.0, 0.0)) * 0.5));
    col = col * (1.0 - fl) + back * fl;
    a = a + fl * (1.0 - a);
  }
  // Wiper blade (dark rubber).
  col = col * (1.0 - wiper) + vec3f(0.01) * wiper;
  a = a + wiper * (1.0 - a);
  o.color = vec4f(col, a);
  return o;
}
