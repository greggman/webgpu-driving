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
  p6: vec4f,      // driver x, dash top y, style (kind index), -
        p7: vec4f,      // axle z shift, ground clearance, wheel width scale, third axle z (0 = none)
      p8: vec4f,      // tailgate shut line: half width, bottom y (0 = trunk lid); chin trim top y, start z (0 = none)
    p9: vec4f,      // cladding: lower band top y, arch band outer radius (0 = none); skid plates front, rear (half width cm + top m)
};

@group(1) @binding(0) var<storage, read> cars: array<Car>;

// Dashboard map route (see CarRenderer.setNav): 32 points (left, forward)
// in metres relative to the player's car; misc = car world x, z (mod
// 1000), forward x, z.
struct Nav {
  pts: array<vec4f, 16>,
  misc: vec4f,
};
@group(1) @binding(1) var<uniform> NAV: Nav;

fn navPoint(i: u32) -> vec2f {
  let v = NAV.pts[i / 2u];
  return select(v.xy, v.zw, (i & 1u) == 1u);
}

fn segDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = saturate(dot(p - a, ab) / max(dot(ab, ab), 1e-6));
  return length(p - a - ab * t);
}

// The navigation screen: north-up-free "heading up" map of the road ahead
// over a world-aligned grid (it scrolls and turns with the car), with the
// car as an arrow near the bottom. su in [-1, 1]^2.
fn navScreen(su: vec2f) -> vec3f {
  // Metres on the map: 170 m ahead fill the screen above the car.
  let m = vec2f(su.x * 0.14, (su.y + 0.7) * 0.075) * 1330.0;
  // World position of this map point for the grid.
  let f = NAV.misc.zw;
  let l = vec2f(f.y, -f.x);
  let w = NAV.misc.xy + l * m.x + f * m.y;
  let g = abs(fract(w / 40.0) - 0.5);
  let grid = smoothstep(0.47, 0.49, max(g.x, g.y));
  let g2 = abs(fract(w / 200.0) - 0.5);
  let major = smoothstep(0.485, 0.495, max(g2.x, g2.y));
  var d = 1e9;
  for (var i = 0u; i < 31u; i++) {
    d = min(d, segDist(m, navPoint(i), navPoint(i + 1u)));
  }
  var col = vec3f(0.015, 0.035, 0.06) + vec3f(0.03, 0.07, 0.06) * grid + vec3f(0.03, 0.06, 0.08) * major;
  let px = 1330.0 * 0.075 / 60.0; // ~metres per screen pixel-ish
  col = mix(col, vec3f(0.05, 0.12, 0.2), 1.0 - smoothstep(7.0, 7.0 + px, d));
  col = mix(col, vec3f(0.15, 0.55, 1.0), 1.0 - smoothstep(3.5, 3.5 + px, d));
  // Car arrow.
  let q = m;
  let arrow = step(abs(q.x) * 1.6, 9.0 - q.y) * step(-5.0, q.y) * step(q.y, 9.0);
  col = mix(col, vec3f(1.0, 0.85, 0.3), arrow);
  return col;
}
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

fn wheelLocal(p: vec3f, ci: u32, wi: u32, mat: f32) -> vec3f {
  let c = cars[ci];
  let R = c.p0.z;
    // Wheels 0-1 front axle, 2-3 rear, 4-5 an extra (tandem) axle.
  let axle = wi / 2u;
  let front = axle == 0u;
  let side = select(-1.0, 1.0, (wi & 1u) == 1u);
    // Mirror the wheel for the left side so the rim faces outward; dual
  // tyres on trucks are one wider wheel.
  var q = vec3f(p.x * side * c.p7.z, p.y, p.z) * R;
  // No third axle: collapse those wheels to a point.
  if (axle == 2u && c.p7.w == 0.0) { q = vec3f(0.0); }
  // Brake calipers are fixed to the knuckle.
  let a = select(c.p0.w, 0.0, mat > 21.5);
  let ca = cos(a);
  let sa = sin(a);
  q = vec3f(q.x, q.y * ca - q.z * sa, q.y * sa + q.z * ca);
  if (front) {
    let st = c.p1.x;
    let cs = cos(st);
    let ss = sin(st);
    q = vec3f(q.x * cs + q.z * ss, q.y, -q.x * ss + q.z * cs);
  }
    var z = select(-0.5, 0.5, front) * c.p0.x + c.p7.x;
  if (axle == 2u) { z = c.p7.w; }
  let off = vec3f(side * (c.p0.y * 0.5), R, z);
  return q + off;
}

@vertex
fn vsWheel(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
    let ci = ii / 6u;
  let wi = ii % 6u;
  let c = cars[ci];
  let lp = wheelLocal(v.pos, ci, wi, v.mat);
  let side = select(-1.0, 1.0, (wi & 1u) == 1u);
  var ln = vec3f(v.normal.x * side, v.normal.yz);
  let a = select(c.p0.w, 0.0, v.mat > 21.5);
  ln = vec3f(ln.x, ln.y * cos(a) - ln.z * sin(a), ln.y * sin(a) + ln.z * cos(a));
  var o: VOut;
  let w = c.model * vec4f(lp, 1.0);
  o.world = w.xyz;
  o.prevWorld = (c.prevModel * vec4f(wheelLocal(v.pos, ci, wi, v.mat), 1.0)).xyz;
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
    // Glass lets sunlight into the cabin; lamp lenses into the lamps.
  if (in.mat == 1u || in.mat == 26u) { discard; }
}

@vertex
fn vsWheelShadow(v: VIn, @builtin(instance_index) ii: u32) -> CSOut {
    let ci = ii / 6u;
  var o: CSOut;
  o.pos = shadowVP * (cars[ci].model * vec4f(wheelLocal(v.pos, ci, ii % 6u, v.mat), 1.0));
  o.mat = 7u;
  return o;
}

// Car reflection environment: the shared prefiltered environment map
// (sky + clouds + distant hills band + ground).
// What a mirror at local point lp shows along world ray rw: above the
// horizon the environment; below it the road the car is driving on
// (asphalt with the centre / edge lines, the verge beyond), traced to the
// ground and fogged by distance. The env map alone has no nearby road.
fn mirrorView(rw: vec3f, lp: vec3f, c: Car) -> vec3f {
  if (rw.y > -0.003) { return envRadiance(rw, 0.0); }
  let m = c.model;
  let rl = vec3f(dot(m[0].xyz, rw), dot(m[1].xyz, rw), dot(m[2].xyz, rw));
  let t = max(lp.y, 0.3) / -rw.y;
    let x = lp.x + rl.x * t; // car-local lateral (+x left); US right lane
  let light = F.sunColor.rgb * max(F.sun.y, 0.0) / PI + shIrradiance(vec3f(0.0, 1.0, 0.0));
  var col = envRadiance(normalize(vec3f(rw.x, -0.06, rw.z)), 0.0); // verge
  if (x > -1.95 && x < 5.4) {
    col = vec3f(0.07, 0.07, 0.075) * light;
    let yl = abs(abs(x - 1.75) - 0.08) < 0.05;
    let wl = abs(x + 1.85) < 0.07;
        if (yl) { col = vec3f(0.5, 0.38, 0.06) * light; }
    if (wl) { col = vec3f(0.55) * light; }
    // Faint tyre-track darkening in the lane.
        col *= 1.0 - 0.15 * (1.0 - smoothstep(0.2, 0.5, abs(abs(x) - 0.8)));
  }
  return mix(fogColor(rw), col, fogTransmittance(F.cam.xyz + rw * t));
}

// The rear-view mirror also sees the car's own cabin: the rear bench top,
// then the rear window framed by headliner, C-pillars and parcel shelf.
fn rearViewMirror(rw: vec3f, lp: vec3f, c: Car) -> vec3f {
  let m = c.model;
  let rl = vec3f(dot(m[0].xyz, rw), dot(m[1].xyz, rw), dot(m[2].xyz, rw));
  let belt = c.p3.w;
    let inside = vec3f(dot(shIrradiance(vec3f(0.0, 1.0, 0.0)), vec3f(0.3, 0.55, 0.15))) * 0.35;
  if (rl.z > -0.05) { return vec3f(0.18, 0.17, 0.15) * inside; }
  // Rear bench top.
  let zb = c.p3.z + 0.3;
  let tb = (zb - lp.z) / rl.z;
  let yb = lp.y + rl.y * tb;
  let xb = lp.x + rl.x * tb;
  if (yb < belt - 0.05 && abs(xb) < c.p2.y * 0.75) {
    return vec3f(0.32, 0.19, 0.1) * inside;
  }
  // Rear window opening (mid-backlight plane).
  let zw = c.p3.z + 0.45;
  let tw = (zw - lp.z) / rl.z;
  let x = lp.x + rl.x * tw;
  let y = lp.y + rl.y * tw;
  let hx = c.p2.y * 0.58;
    let top = lp.y + 0.09; // the roof, just above the mirror
  let bot = belt + 0.07;
  // Rounded-rectangle opening.
  let q = vec2f(abs(x) - (hx - 0.08), abs(y - (top + bot) * 0.5) - ((top - bot) * 0.5 - 0.08));
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 0.08;
  if (d > 0.0) {
    if (y < bot) { return vec3f(0.03) * inside; } // parcel shelf
    if (y > top - 0.02) { return vec3f(0.22, 0.21, 0.19) * inside; } // headliner
    return vec3f(0.12, 0.115, 0.1) * inside; // C-pillar trim
  }
  // Through the tinted rear glass, with a thin dark frit at its edge.
  let frit = 1.0 - smoothstep(-0.03, -0.015, d);
  return mirrorView(rw, lp, c) * mix(0.7, 0.05, 1.0 - frit);
}

fn carEnv(r: vec3f, rough: f32) -> vec3f {
  return envRadiance(r, rough);
}

fn clearcoatShade(base: Surface, wp: vec3f, sh: f32, coat: f32) -> vec3f {
  var col = shadeSurface(base, wp, sh);
  if (coat <= 0.0) { return col; }
  let v = normalize(F.cam.xyz - wp);
  let n = base.n;
  let nv = saturate(dot(n, v));
    // Clear-coat Fresnel, capped at grazing angles (the coat's slight
  // roughness and orange peel keep the paint colour from vanishing into a
  // silver sheen on panels seen edge-on).
  let fc = min(0.04 + 0.96 * pow(1.0 - nv, 5.0), 0.6);
  let r = reflect(-v, n);
  let l = F.sun.xyz;
  let h = normalize(v + l);
  let nl = saturate(dot(n, l));
  let spec = D_GGX(saturate(dot(n, h)), 0.035) * V_SmithGGX(max(nv, 1e-3), nl, 0.035) * fc;
    // Reflection occlusion: surfaces facing the ground mirror the road, not
  // the sky (and occluded ones mirror little).
  let envOcc = mix(0.15, 1.0, smoothstep(-0.2, 0.08, r.y)) * base.ao;
  col = col * (1.0 - fc * coat) + (carEnv(r, 0.03) * envOcc * fc + spec * F.sunColor.rgb * sh * nl) * coat;
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

fn interiorShade(mat: u32, lp: vec3f, c: Car, ln: vec3f) -> vec4f {
  // Surface pattern coordinates projected along the dominant normal axis
  // (no streaks down vertical faces).
  let an = abs(ln);
  let puv = select(select(lp.xy, lp.zy, an.x > an.z), lp.xz, an.y > max(an.x, an.z));
  // Returns (albedo rgb, roughness) or emissive handled by caller.
    if (mat == 12u) {
    // Tan leather: fine low-contrast grain, a perforated centre insert
    // between stitched seams, and a moulded plastic shell on the backs.
    if (ln.z < -0.6 && lp.y > c.p6.y - 0.45) { return vec4f(vec3f(0.035), 0.5); }
    let rearSeat = lp.z < c.p3.y - 0.45;
    let edge = select(0.135, (c.p2.y - 0.1) * 0.68, rearSeat);
    let dxs = select(abs(abs(lp.x) - c.p6.x), abs(lp.x), rearSeat);
    let sd = abs(dxs - edge);
    let insert = dxs < edge;
    var col = vec3f(0.32, 0.19, 0.1) * (0.94 + 0.06 * vnoise(puv * 260.0));
    let perf = step(0.85, vnoise(puv * 140.0)) * select(0.0, 1.0, insert);
    col *= 1.0 - 0.1 * perf;
    // Horizontal pleats across the insert.
    let pleat = abs(fract(lp.y / 0.11) - 0.5) * 0.11;
    let seam = max(1.0 - smoothstep(0.0015, 0.0035, sd), select(0.0, 1.0 - smoothstep(0.001, 0.0025, pleat), insert && abs(ln.y) < 0.6));
    col *= 1.0 - 0.55 * seam;
    // Contrast stitching beside the side seams.
    let stitch = step(abs(sd - 0.007), 0.0011) * step(0.45, fract((lp.y + lp.z) * 90.0));
    col = mix(col, vec3f(0.5, 0.42, 0.3), stitch * 0.8);
    return vec4f(col, 0.5);
  }
  if (mat == 18u) {
    return vec4f(vec3f(0.22, 0.21, 0.19) * (0.93 + 0.07 * vnoise(puv * 150.0)), 0.95);
  }
  if (mat == 13u) { return vec4f(vec3f(0.03), 0.75); }
  if (mat == 15u) { return vec4f(vec3f(0.25), 0.45); }
  if (mat == 17u) { return vec4f(vec3f(0.025), 0.95); }
  // Dashboard: soft-touch dark plastic with a fine grain.
  return vec4f(vec3f(0.05, 0.05, 0.055) * (0.9 + 0.2 * vnoise(puv * 80.0)), 0.7);
}

@fragment
fn fs(in: VOut, @builtin(front_facing) ff: bool) -> GBufferOut {
  let c = cars[in.car];
  var n = normalize(in.normal);
  let wp = in.world;
  let lp = in.local;
  let v = normalize(F.cam.xyz - wp);
  let interior = c.p4.x > 0.5;
    // Glass and lamp lenses are drawn in the blended pass (fsGlass).
  if (in.mat == 1u || in.mat == 26u) { discard; }
  if (dot(n, v) < 0.0) { n = -n; }
  // Cabin materials (interior mesh, or the inside of the body shell).
  let wheelMat = in.mat == 7u || in.mat == 8u || in.mat >= 20u;
    // (Underbody / wheel-well liners stay dark from either side.)
  if ((in.mat >= 10u && in.mat < 20u) || (!ff && !wheelMat && in.mat != 5u)) {
    var s: Surface;
        let im = interiorShade(select(10u, in.mat, in.mat >= 10u), lp, c, normalize(in.lnormal));
    s.albedo = im.rgb;
    s.rough = im.a;
    if (in.mat < 10u) {
      // Inside of the shell: fabric headliner above, soft-touch door cards below.
      let lnI = normalize(in.lnormal);
            if (lnI.y > 0.45) {
        // Fabric headliner: fine weave noise, darker toward the glass
        // edges where the roof curves down (occlusion).
        s.albedo = vec3f(0.22, 0.21, 0.19) * (0.93 + 0.07 * vnoise(lp.xz * 150.0)) * (0.92 + 0.08 * vnoise(lp.xz * 9.0));
                s.albedo *= mix(0.55, 1.0, smoothstep(0.5, 0.95, lnI.y));
        // Pillar bases darken where they meet the dash / door.
        s.albedo *= mix(0.45, 1.0, smoothstep(c.p6.y, c.p6.y + 0.3, lp.y));
        s.rough = 0.95;
      } else {
                // Soft-touch door card: fine grain, one stitched seam line.
        let seamY = abs(lp.y - (c.p3.w - 0.14));
        let stitch = step(seamY, 0.0012) * step(0.5, fract(lp.z * 90.0));
        s.albedo = vec3f(0.07, 0.065, 0.06) * (0.92 + 0.08 * vnoise(lp.yz * 180.0)) + vec3f(0.12, 0.09, 0.06) * stitch;
        s.rough = 0.8;
      }
    }
    s.metal = select(0.0, 1.0, in.mat == 15u);
    s.n = n;
        // Seen from outside, the roof and pillars shade the cabin (it reads
    // dark through the glass, as on a real car in daylight).
        s.ao = select(0.25, 0.7, interior);
    s.albedo = s.albedo * select(0.14, 1.0, interior);
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
      emissive = navScreen(su) * dashLight * 2.0;
      s.albedo = vec3f(0.005);
      s.rough = 0.1;
    } else if (in.mat == 16u) {
                  // Rear-view mirror glass.
      s.albedo = vec3f(0.0);
      s.metal = 0.0;
      s.rough = 1.0;
      s.spec = 0.0;
            emissive = rearViewMirror(reflect(-v, n), lp, c) * 0.8;
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

  // Lamps, grille, intakes and plates from local position + local normal
  // (the body mesh only carries front / rear fascia material ids).
  let ln = normalize(in.lnormal);
  let ax = abs(lp.x) / halfW;
  let hy = c.p2.z; // headlight centre height
  let ty = c.p2.w; // tail light centre height
    let body = mat == 0u || mat == 3u || mat == 4u;
  // Bodies with modelled lamp / grille openings don't get painted ones.
  let decals = c.p6.w < 0.5;
  var part = 0u; // 1 headlight, 2 tail light, 3 grille, 4 black plastic, 5 chrome
  let style = u32(c.p6.z + 0.5); // sedan hatch suv coupe wagon pickup
  let gx = ax;
  let gy = lp.y - hy;
  var cell = 0u; // grille pattern: 0 slats, 1 honeycomb, 2 big rectangles
  var recess = 1.0;
    if (body && decals && lp.z > 0.0) {
    // Headlight units in the upper corners of the nose, wrapping around
    // onto the fender.
    let hu = (ax - select(0.5, 0.46, style == 0u)) / select(0.42, 0.46, style == 0u);
        // Thickens and sweeps up outboard.
    var top = 0.03 + 0.07 * saturate(hu);
    var bot = -0.035 - 0.02 * saturate(hu);
    if (style == 2u || style == 5u) { top = 0.07; bot = -0.06; }
    if (style == 3u) { top = 0.035 + 0.04 * saturate(hu); bot = -0.035; }
    let front = ln.z > 0.08 || (ax > 0.88 && lp.z > halfL - 0.32);
    if (lp.z > halfL - 0.6 && front && hu > 0.0 && hu < 1.1 && gy > bot && gy < top) {
      part = 1u;
    }
    // Main grille: shape per kind, chrome / gloss surround.
    if (lp.z > halfL - 0.35 && ln.z > 0.25) {
                                    // Trapezoid narrowing toward the bottom (Accord / Camry).
            var y0 = -0.36; var y1 = 0.0; var wt = 0.5; var wb = 0.4;
      cell = 1u;
      if (style == 1u) { y0 = -0.07; y1 = 0.0; wt = 0.4; wb = 0.36; }
      if (style == 2u) { y0 = -0.26; y1 = 0.05; wt = 0.46; wb = 0.46; cell = 1u; }
      if (style == 3u) { y0 = -0.3; y1 = -0.1; wt = 0.5; wb = 0.62; cell = 1u; }
      if (style == 4u) { cell = 1u; }
      if (style == 5u) { y0 = -0.32; y1 = 0.07; wt = 0.5; wb = 0.5; cell = 2u; }
      let t = saturate((gy - y0) / (y1 - y0));
      let gw = mix(wb, wt, t);
      let inside = gy > y0 && gy < y1 && gx < gw;
      let edge = min(min(gy - y0, y1 - gy), (gw - gx) * halfW);
      if (inside) {
                // Surround: gloss black on the sedan, chrome on the others.
        part = select(3u, select(5u, 4u, style == 0u), edge < 0.014 && style != 3u);
        recess = smoothstep(0.0, 0.05, edge);
      }
      // Lower intake below a body-colour bumper bar.
            var li0 = select(-0.42, -0.36, style == 3u);
      var lw = select(0.62, 0.72, style == 1u);
      var liTop = y0 - 0.07;
      if (style == 0u) { li0 = -0.46; lw = 0.58; liTop = y0 - 0.05; }
      if (style != 3u && gy > li0 && gy < liTop && gx < lw && gy < -0.12) {
        part = 3u;
        cell = select(select(1u, 2u, style == 5u), 0u, style == 0u);
        recess = smoothstep(0.0, 0.04, min(gy - li0, (lw - gx) * halfW));
      }
    }
        if (lp.z > halfL - 0.4 && gy < -0.44 && ln.z > 0.35) { part = 4u; }
    // Fog lamp pods in the bumper corners.
    if (style != 3u && lp.z > halfL - 0.45 && ln.z > 0.2) {
            // Vertical black corner blades (fog lamps sit inside, lit at night).
                  if (style == 0u) {
        // Sedan: dark corner intakes with a horizontal blade.
        if (ax > 0.7 && ax < 0.95 && gy > -0.44 && gy < -0.28 && ln.z > 0.3) {
          part = select(4u, 5u, abs(gy + 0.36) < 0.008);
        }
      } else if (abs(ax - 0.84) * halfW < 0.07 && gy > -0.44 && gy < -0.26 && ln.z > 0.35) {
        // Vertical black corner blades (fog lamps sit inside, lit at night).
        part = select(4u, 6u, lightsOn > 0.5 && abs(gy + 0.35) < 0.02);
      }
    }
  }
  if (body && lp.z < 0.0) {
        // Tail lamps on the rear face, wrapping onto the rear quarters.
        if (decals && lp.z < -halfL + 0.5 && (ln.z < -0.1 || (ax > 0.9 && lp.z < -halfL + 0.35))) {
      let dy = lp.y - ty;
      var lamp = false;
      var bezel = false;
      if (style == 2u || style == 4u || style == 5u) {
        // Tall vertical clusters at the corners.
        lamp = ax > 0.72 && ax < 0.97 && dy > -0.12 && dy < 0.14;
        bezel = ax > 0.69 && ax < 0.99 && dy > -0.14 && dy < 0.16;
      } else if (style == 3u) {
        // Full-width light blade.
        lamp = ax < 0.96 && abs(dy - 0.04) < 0.028;
        bezel = ax < 0.98 && abs(dy - 0.04) < 0.04;
      } else {
                        // Wraparound L clusters (vertical outboard, horizontal on top) and a
        // thin centre bar joining them.
        lamp = (ax > 0.55 && ax < 0.99 && dy > 0.0 && dy < 0.11) || (ax > 0.84 && ax < 0.99 && dy > -0.07) || (ax <= 0.58 && abs(dy - 0.08) < 0.008);
        if (ln.z > -0.1) {
          // On the rear quarter the lamp tapers to a point as it wraps.
          let fwd = lp.z + halfL;
          lamp = fwd < 0.22 && dy < 0.11 && dy > -0.02 + fwd * 0.5;
        }
                // Thin gloss-black surround only.
        bezel = (ax > 0.53 && dy > -0.012 && dy < 0.125) || (ax > 0.82 && dy > -0.085 && dy < 0.125);
      }
      if (lamp) { part = 2u; } else if (bezel) { part = 4u; }
    }
    // Rear diffuser with exhaust tips.
                    // Rear diffuser (sedan: a lower, narrower centre section).
    let diffuser = select(lp.y < ty - 0.5, lp.y < 0.28 && ax < 0.75, style == 0u);
        if (decals && lp.z < -halfL + 0.4 && diffuser) {
      part = 4u;
      if (style != 2u && style != 5u && ln.z < -0.2) {
                // Rectangular black exhaust finishers.
        let ex = vec2f((ax - 0.55) * halfW, lp.y - (ty - 0.5));
        let eb = max(abs(ex.x) - 0.05, abs(ex.y) - 0.018);
        if (eb < 0.0) { part = select(4u, 7u, eb < -0.006); }
      }
    }
  }
  if (part == 1u) {
    // Clear cover over a dark chrome housing: two projector lenses and an
    // LED daytime-running-light signature along the lower / outer edge.
    let px = ax * halfW;
    let dy = gy;
        // Bright reflector housing behind a clear cover, framed by a black brow.
    s.albedo = vec3f(0.45);
    s.metal = 1.0;
    s.rough = 0.2;
    coat = 1.0;
    var lens = 0.0;
    var ring = 0.0;
    for (var k = 0; k < 2; k++) {
      let cx = halfW * (0.62 + 0.17 * f32(k));
      let d = length(vec2f(px - cx, dy - 0.01));
      lens = max(lens, 1.0 - smoothstep(0.024, 0.028, d));
      ring = max(ring, smoothstep(0.026, 0.03, d) * (1.0 - smoothstep(0.038, 0.042, d)));
    }
    // Reflector bowls behind the lenses.
    let bowl = 1.0 - smoothstep(0.03, 0.06, abs(dy - 0.01));
        s.albedo = mix(s.albedo, vec3f(0.8), bowl * 0.7);
    s.albedo = mix(s.albedo, vec3f(0.02), smoothstep(0.03, 0.05, dy));
            s.albedo = mix(s.albedo, vec3f(0.25), ring);
    s.rough = mix(s.rough, 0.06, ring);
    if (style == 0u) {
      // Sedan: dark housing, glassy projector lenses with a chrome ring.
      s.albedo = mix(vec3f(0.05), vec3f(0.75), ring);
      s.metal = 0.9;
      s.rough = mix(0.12, 0.05, ring);
      s.albedo = mix(s.albedo, vec3f(0.015), lens);
      s.rough = mix(s.rough, 0.02, lens);
    }
    let hu = (ax - select(0.5, 0.46, style == 0u)) / select(0.42, 0.46, style == 0u);
    var drl = (1.0 - smoothstep(0.004, 0.008, abs(dy + 0.035))) * step(0.03, hu) * step(hu, 1.05);
    if (style == 2u || style == 5u) {
      // C-shaped signature.
      drl = max(drl, (1.0 - smoothstep(0.004, 0.008, abs(hu - 0.08) * halfW * 0.42)) * step(abs(dy), 0.05));
      drl = max(drl, (1.0 - smoothstep(0.004, 0.008, abs(dy - 0.055))) * step(0.03, hu) * step(hu, 0.5));
    } else {
            drl = max(drl, (1.0 - smoothstep(0.006, 0.012, abs(min(hu, 0.98) - 0.97) * halfW * 0.42)) * step(dy, 0.03) * step(-0.05, dy));
    }
    let white = vec3f(1.0, 0.97, 0.92);
    emissive = white * (saturate(drl) * (2.5 + 6.0 * lightsOn) + lens * (0.05 + 40.0 * lightsOn));
    s.albedo = mix(s.albedo, vec3f(0.9), saturate(drl));
  } else if (part == 2u) {
    // Layered tail lamp: smoked outer lens, bright inner light-guide lines.
    let brake = c.p1.y;
    let dy = lp.y - ty;
        // Smoked lens with one LED light guide along its upper edge.
    var strip = 1.0 - smoothstep(0.004, 0.009, abs(dy - 0.03));
    if (style == 2u || style == 4u || style == 5u) {
      strip = max(strip, 1.0 - smoothstep(0.004, 0.009, abs(dy + 0.06)));
    }
        s.albedo = vec3f(0.3, 0.012, 0.01);
    s.rough = 0.05;
    coat = 1.0;
    emissive = vec3f(1.0, 0.04, 0.02) * (strip * (6.0 + 5.0 * lightsOn) + 0.9 + 14.0 * brake);
  } else if (part == 3u) {
    // Grille insert, recessed: bright walls, dark cells, shadowed toward
    // the surround.
    var wall = 0.0;
    if (cell == 1u) {
      let q = vec2f(lp.x, lp.y) * 42.0;
      let r = vec2f(1.0, 1.732);
      let h = r * 0.5;
      let a = (q - r * floor(q / r)) - h;
      let b = (q - h - r * floor((q - h) / r)) - h;
      let g = select(b, a, dot(a, a) < dot(b, b));
      let hexD = max(abs(g.x) * 0.866 + abs(g.y) * 0.5, abs(g.y));
      wall = smoothstep(0.36, 0.44, hexD);
    } else if (cell == 2u) {
      let q = vec2f(lp.x * 9.0, lp.y * 14.0);
      let f = abs(fract(q) - 0.5);
      wall = smoothstep(0.36, 0.42, max(f.x, f.y));
    } else {
            let freq = select(select(30.0, 18.0, style == 0u), 9.0, style == 5u);
      wall = smoothstep(select(0.3, 0.22, style == 5u), select(0.4, 0.3, style == 5u), abs(fract(lp.y * freq) - 0.5));
    }
        var bright = select(0.06, 0.5, cell == 0u || cell == 2u);
    if (style == 0u) { bright = 0.1; } // gloss black on the sedan
    s.albedo = mix(vec3f(0.003), vec3f(bright), wall);
        s.metal = select(select(0.0, 1.0, cell != 1u) * wall, 0.0, style == 0u);
    s.rough = mix(0.8, 0.2, wall);
    s.ao = mix(0.4, 1.0, recess);
  } else if (part == 5u) {
    s.albedo = vec3f(0.85);
    s.metal = 1.0;
    s.rough = 0.12;
    coat = 1.0;
  } else if (part == 6u) {
    // Fog lamp lens.
        s.albedo = vec3f(0.06);
    s.metal = 1.0;
    s.rough = 0.1;
    coat = 1.0;
    emissive = vec3f(1.0, 0.95, 0.85) * 6.0 * lightsOn;
  } else if (part == 7u) {
    s.albedo = vec3f(0.005);
    s.rough = 0.9;
  } else if (part == 4u) {
    s.albedo = vec3f(0.02);
    s.rough = 0.55;
  } else if (body) {
    // Paint with metallic flakes and a clear coat.
    let flakeCell = floor(lp * 2500.0);
    let fh = hash01(i32(flakeCell.x + flakeCell.z * 13.0), i32(flakeCell.y));
    let fn2 = vec3f(hash01(i32(flakeCell.x), i32(flakeCell.y + 7.0)), fh, hash01(i32(flakeCell.z), i32(flakeCell.x + 3.0))) - 0.5;
    s.n = normalize(n + fn2 * 0.06 * c.color.w);
        s.albedo = c.color.rgb;
    s.metal = c.color.w;
        s.rough = mix(0.45, 0.3, c.color.w);
    // Under the clear coat there is no dielectric sheen of its own (that
    // read as a grey haze on the upward panels); only the flakes reflect.
    s.spec = 0.0;
    coat = 1.0;
        // Gloss-black chin splitter band (constant height, from ahead of the
    // front arches).
    if (c.p8.z > 0.0 && lp.z > c.p8.w && lp.y < c.p8.z) {
      s.albedo = vec3f(0.018);
      s.metal = 0.0;
      s.rough = 0.25;
    }
        // Matte black plastic cladding: the lower body and a band around the
    // wheel arches.
    if (c.p9.x > 0.0) {
      let R = c.p0.z;
      let dF = length(vec2f(lp.z - (c.p7.x + c.p0.x * 0.5), lp.y - R));
      let dR = length(vec2f(lp.z - (c.p7.x - c.p0.x * 0.5), lp.y - R));
      if (lp.y < c.p9.x || (min(dF, dR) < c.p9.y && ax > 0.6)) {
        s.albedo = vec3f(0.03, 0.03, 0.032) * (0.9 + 0.2 * vnoise(lp.xz * 300.0 + lp.y * 170.0));
        s.metal = 0.0;
        s.rough = 0.8;
        coat = 0.15;
      }
    }
        // Satin-silver skid plates on the lower fascias, with a thin black edge.
    let skid = select(c.p9.w, c.p9.z, lp.z > 0.0);
    if (skid > 0.0 && abs(lp.z) > halfL - 0.35) {
      let shw = floor(skid) / 100.0;
      let stop = fract(skid);
      let e = min(stop - lp.y, shw - abs(lp.x));
      if (e > 0.0) {
                // Silver-painted plastic: mostly diffuse (a full metal down here
        // only mirrored the dark road and read black).
        s.albedo = select(vec3f(0.02), vec3f(0.5, 0.51, 0.53), e > 0.012);
        s.metal = select(0.0, 0.25, e > 0.012);
        s.rough = select(0.4, 0.42, e > 0.012);
        s.ao = max(s.ao, 0.8);
        coat = 0.0;
      }
    }
    // Lower body AO: sills and bumper undersides stop mirroring the sky.
    s.ao = min(s.ao, 0.35 + 0.65 * saturate((lp.y - 0.15) / 0.35));
    // Road grime toward the bottom.
    let grime = saturate((0.45 - lp.y) * 3.0) * c.p1.w;
    s.albedo = mix(s.albedo, vec3f(0.12, 0.1, 0.08), grime);
    coat *= 1.0 - grime;
    // Panel gaps: doors (front / rear / B pillar), hood and trunk shut lines.
    var seam = 1.0;
    let doorBot = c.p7.y + 0.14;
    let doorF = c.p3.x - 0.08;
        var doorR = select(c.p3.z + 0.1, c.p3.y, style == 3u); // coupe: p3.y = its one rear shut line
    // Sedan rear doors end ~1 m behind the B pillar (not in the quarter).
    if (style == 0u) { doorR = c.p3.y - 1.0; }
    if (style == 5u) { doorR = c.p3.y; }
    if (ax > 0.8 && lp.y < c.p3.w && lp.y > doorBot) {
      seam = min(min(abs(lp.z - doorF), abs(lp.z - c.p3.y)), abs(lp.z - doorR));
    }
    if (ax > 0.8 && lp.z < doorF && lp.z > doorR) { seam = min(seam, abs(lp.y - doorBot)); }
    if (ln.y > 0.5) {
      seam = min(seam, abs(lp.z - (c.p3.x + 0.03)));
            // Hood side shut lines (only on the hood: an upward-facing shoulder
      // ledge along the doors would get one too).
      if (lp.z > c.p3.x - 0.05) { seam = min(seam, abs(ax - 0.9) * halfW); }
      // Trunk lid (sedan, coupe) front edge.
      if (style == 0u || style == 3u) { seam = min(seam, abs(lp.z - (c.p3.z - 0.05))); }
    }
            // Bumper parting lines front and rear.
                if (lp.z < -halfL + 0.6 || (decals && lp.z > halfL - 0.6)) { seam = min(seam, abs(lp.y - 0.55)); }
    // The rear bumper cover's upper edge runs forward to the rear arch.
    if (lp.z < c.p7.x - c.p0.x * 0.5 && lp.z > -halfL + 0.5) {
      seam = min(seam, abs(lp.y - 0.55) + step(0.1, abs(lp.y - 0.55)));
    }
    
    if (ln.z < -0.3) {
      // Trunk / tailgate opening on the rear face.
                  
            if (c.p8.x > 0.0) {
        // Hatch tailgate: along its bottom edge and up both sides.
        if (abs(lp.x) < c.p8.x) { seam = min(seam, abs(lp.y - c.p8.y)); }
        if (lp.y > c.p8.y) { seam = min(seam, abs(abs(lp.x) - c.p8.x)); }
      } else {
        // The trunk lid shuts just above the lamps.
        if (ax < 0.8) { seam = min(seam, abs(lp.y - (ty + 0.13))); }
        if (lp.y > ty + 0.13) { seam = min(seam, abs(ax - 0.8) * halfW); }
      }
            // Recessed plate pocket (modelled bodies have a real one).
      if (decals) {
        let pp = vec2f(abs(lp.x) - 0.3, abs(lp.y - (ty - 0.3)) - 0.09);
        if (max(pp.x, pp.y) < 0.0) { s.ao = 0.55; }
        seam = min(seam, abs(max(pp.x, pp.y)));
      }
    }
    if (style == 5u) {
      // Gap between the cab and the bed.
      if (ax > 0.8) { seam = min(seam, abs(lp.z - (c.p3.z - 0.09)) * 0.4); }
    }
    let line = 1.0 - smoothstep(0.002, 0.006, seam);
    s.albedo *= 1.0 - 0.85 * line;
    coat *= 1.0 - line;
  } else if (mat == 1u) {
    // Glass: dark tint, very smooth, strongly reflective at grazing angles.
    s.albedo = vec3f(0.012, 0.015, 0.018);
    s.rough = 0.02;
    coat = 1.0;
  } else if (mat == 2u) {
    // Gloss-black trim (window frames, pillars, seals).
    s.albedo = vec3f(0.02);
    s.rough = 0.22;
    } else if (mat == 5u) {
    // Underbody / wheel-well liners: near black, in shadow.
    s.albedo = vec3f(0.006);
    s.rough = 0.9;
    s.ao *= 0.3;
  } else if (mat == 6u) {
    s.albedo = vec3f(0.9);
    s.metal = 1.0;
    s.rough = 0.12;
  } else if (mat == 7u) {
    // Tyre: tread blocks on the crown, faint raised lettering ring on the wall.
    let r = length(lp.yz);
    let ang = atan2(lp.z, lp.y);
    var dark = 0.0;
    if (abs(ln.x) < 0.6) {
      let groove = step(0.82, fract(lp.x * 12.0 + 0.5));
      let sipe = step(0.9, fract(ang * 70.0 / 6.2831853 + lp.x * 3.0));
      dark = max(groove, sipe * step(0.2, abs(lp.x) * 4.0));
    } else {
      let band = 1.0 - smoothstep(0.0, 0.015, abs(r - 0.86));
      let letters = step(0.5, fract(ang * 40.0 / 6.2831853)) * step(0.7, fract(ang * 3.0));
      s.albedo = vec3f(band * letters * 0.02);
    }
    s.albedo = vec3f(0.016) * (1.0 - 0.6 * dark) + s.albedo;
            s.rough = 0.93;
    s.spec = 0.06;
    // Rubber sits partly in the arch shadow.
    s.ao = 0.6;
    } else if (mat >= 23u && mat <= 31u) {
    // Modelled lamp / grille parts (see carBody.ts openings).
    let brake = c.p1.y;
    if (mat == 23u) {
      // Headlamp housing: brushed chrome reflector with facets.
      let facet = 0.8 + 0.2 * step(0.5, fract(lp.x * 40.0));
      s.albedo = vec3f(0.55) * facet;
      s.metal = 1.0;
      s.rough = 0.25;
    } else if (mat == 24u) {
      // Tail lamp body: red reflector optics behind the lens.
      let optic = 0.7 + 0.3 * step(0.5, fract(lp.y * 60.0));
      s.albedo = vec3f(0.35, 0.02, 0.015) * optic;
      s.rough = 0.15;
      coat = 1.0;
      emissive = vec3f(1.0, 0.04, 0.02) * (0.4 + 2.5 * lightsOn + 10.0 * brake) * optic;
    } else if (mat == 25u || mat == 27u) {
      // Grille / intake insert: gloss-black honeycomb with depth.
      let q = vec2f(lp.x, lp.y) * 70.0;
      let rr = vec2f(1.0, 1.732);
      let hh = rr * 0.5;
      let a = (q - rr * floor(q / rr)) - hh;
      let b = (q - hh - rr * floor((q - hh) / rr)) - hh;
      let g = select(b, a, dot(a, a) < dot(b, b));
      let hexD = max(abs(g.x) * 0.866 + abs(g.y) * 0.5, abs(g.y));
      let wall = smoothstep(0.36, 0.44, hexD);
      s.albedo = mix(vec3f(0.003), vec3f(select(0.05, 0.03, mat == 27u)), wall);
      s.rough = mix(0.8, 0.15, wall);
      s.ao = mix(0.35, 1.0, wall);
    } else if (mat == 28u) {
      // DRL: white LED light guide.
      s.albedo = vec3f(0.9);
      s.rough = 0.2;
      emissive = vec3f(1.0, 0.97, 0.92) * (3.0 + 6.0 * lightsOn);
    } else if (mat == 29u) {
      // Projector lens: dark glass, bright when the lights are on.
      s.albedo = vec3f(0.02);
      s.rough = 0.02;
      coat = 1.0;
      emissive = vec3f(1.0, 0.97, 0.9) * (0.05 + 40.0 * lightsOn);
        } else if (mat == 31u) {
            // Door mirror glass.
      s.albedo = vec3f(0.0);
      s.rough = 1.0;
      s.spec = 0.0;
      emissive = mirrorView(reflect(-normalize(F.cam.xyz - in.world), n), lp, c) * 0.8;
    } else {
      // Tail light guide: bright red LED line.
      s.albedo = vec3f(0.5, 0.03, 0.02);
      s.rough = 0.2;
      emissive = vec3f(1.0, 0.05, 0.02) * (6.0 + 5.0 * lightsOn + 14.0 * brake);
    }
  } else if (mat == 20u) {
    // Licence plate: white retro-reflective sheet, dark border and characters.
        let py = lp.y - select(ty - 0.3, hy - 0.32, lp.z > 0.0);
    let px = lp.x + 0.26;
    let border = step(0.5, f32(abs(py) > 0.05 || px < 0.012 || px > 0.508));
    let ci = floor((px - 0.04) / 0.064);
    let cu = fract((px - 0.04) / 0.064);
    let cv = (py + 0.035) / 0.07;
    let cell = vec2i(i32(cu * 3.0 / 0.8), i32(cv * 5.0));
    let on = step(0.45, hash01(i32(ci) * 17 + cell.x + 3 * i32(c.color.x * 97.0), cell.y + 11))
      * step(cu, 0.8) * step(0.0, cv) * step(cv, 1.0) * step(0.0, ci) * step(ci, 6.0);
    s.albedo = mix(vec3f(0.8, 0.8, 0.75), vec3f(0.02, 0.03, 0.08), max(border * 0.9, on));
    s.rough = 0.4;
    emissive = vec3f(1.0, 0.95, 0.85) * lightsOn * 0.3 * s.albedo * step(lp.z, 0.0);
  } else if (mat == 21u) {
    // Brake disc: machined, with curved slots.
    let r = length(lp.yz);
    let ang = atan2(lp.z, lp.y);
    let slot = step(0.9, fract(ang * 6.0 / 6.2831853 * 1.0 + r * 1.5)) * step(0.3, r) * step(r, 0.52);
            // Dark hub hat inside a brighter machined friction ring.
    let hat = 1.0 - step(0.33, r);
    s.albedo = mix(mix(vec3f(0.3), vec3f(0.04), slot), vec3f(0.05), hat);
    s.metal = 1.0 - slot;
    s.rough = 0.35;
  } else if (mat == 22u) {
    s.albedo = vec3f(0.5, 0.03, 0.02);
    s.rough = 0.3;
    coat = 1.0;
  } else {
    // Alloy rim: bright machined spoke faces, darker barrel and cap.
    let r = length(lp.yz);
    let face = saturate(abs(ln.x) * 2.0 - 0.6);
            s.albedo = mix(vec3f(0.08), vec3f(0.6), face);
    s.metal = 1.0;
    s.rough = mix(0.45, 0.25, face);
    // Polished lip at the rim edge.
    if (abs(r - 0.69) < 0.012 && abs(ln.x) > 0.5) { s.albedo = vec3f(0.95); s.rough = 0.1; }
    if (r < 0.2) { s.albedo = vec3f(0.08); s.rough = 0.3; }
    if (abs(r - 0.1) < 0.01) { s.albedo = vec3f(0.8); }
    coat = 0.5;
  }
  s.ao = min(s.ao, ao);
    if (body || mat == 2u || mat == 5u) { s.ao *= mix(1.0, 0.25, saturate(-in.lnormal.y * 1.5)); }
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

// ---- Glass (blended pass): tinted reflective glass on every car; from the
// inside of the player's car also snow that collects on the windows, wipers
// that sweep the windshield, and (fsGlassFx) rain drops that refract the
// view. ----
struct GlassOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
  @location(2) normal: vec4f,
};

const WIPE_PERIOD = 2.0;
const WIPE_SWEEP = 1.2;
const WIPE_MAX = 1.8; // radians

fn wiperAngle(t: f32) -> f32 {
  // Sweep up and back in WIPE_SWEEP s, then rest.
  let ph = t - floor(t / WIPE_PERIOD) * WIPE_PERIOD;
  if (ph > WIPE_SWEEP) { return 0.0; }
  return sin(ph / WIPE_SWEEP * PI) * WIPE_MAX;
}

// Seconds since a blade last passed the angle `a` around its pivot.
fn sinceBlade(t: f32, a: f32) -> f32 {
  if (a > WIPE_MAX || a < 0.0) { return 1e3; }
  let ph = t - floor(t / WIPE_PERIOD) * WIPE_PERIOD;
  let p1 = asin(saturate(a / WIPE_MAX)) / PI * WIPE_SWEEP;
  let p2 = WIPE_SWEEP - p1;
  var last = p2 - WIPE_PERIOD;
  if (ph >= p2) { last = p2; } else if (ph >= p1) { last = p1; }
  return ph - last;
}

// Glass-plane coordinates in metres: windshield (across, up the glass),
// side windows (along the car, up), rear glass (across, up).
struct GlassCoord {
  uv: vec2f,
  region: u32, // 0 windshield, 1 side, 2 rear
};

fn glassCoord(lp: vec3f, ln: vec3f, c: Car) -> GlassCoord {
  var g: GlassCoord;
  let ws = c.p3.x;
  let belt = c.p3.w;
    if (abs(ln.x) > 0.55) {
    g.region = 1u;
    g.uv = vec2f(lp.z, lp.y - belt);
  } else if (lp.z > c.p3.y) {
    g.region = 0u;
    g.uv = vec2f(lp.x, length(vec2f(ws - lp.z, max(lp.y - belt, 0.0))));
  } else {
    g.region = 2u;
    g.uv = vec2f(lp.x, lp.y - belt);
  }
  return g;
}

// Wiper k: pivot, blade radial range. Driver sits on +x (left-hand drive);
// blades rest pointing across toward the passenger and sweep up.
fn wiperPivot(k: u32) -> vec2f { return select(vec2f(-0.08, -0.04), vec2f(0.6, -0.04), k == 0u); }
fn wiperRange(k: u32) -> vec2f { return select(vec2f(0.12, 0.7), vec2f(0.14, 0.8), k == 0u); }

fn wiperPolar(uv: vec2f, k: u32) -> vec2f {
  let q = uv - wiperPivot(k);
  return vec2f(length(q), atan2(q.y, -q.x)); // r, angle from the rest direction
}

// Seconds since this windshield point was last wiped (1e3 if never).
fn sinceWiped(uv: vec2f, t: f32) -> f32 {
  if (F.glass.z < 0.5) { return 1e3; }
  var best = 1e3;
  for (var k = 0u; k < 2u; k++) {
    let pr = wiperPolar(uv, k);
    let rr = wiperRange(k);
    if (pr.x > rr.x - 0.02 && pr.x < rr.y + 0.02) {
      best = min(best, sinceBlade(t, pr.y));
    }
  }
  return best;
}

@fragment
fn fsGlass(in: VOut) -> GlassOut {
    let c = cars[in.car];
  if (in.mat != 1u && in.mat != 26u) { discard; }
  let lp = in.local;
  var o: GlassOut;
  o.velocity = vec2f(0.0);
  o.normal = vec4f(0.0);
  let n = normalize(in.normal);
  let v = normalize(F.cam.xyz - in.world);
  let nn = select(-n, n, dot(n, v) > 0.0);
  let nv = saturate(dot(nn, v));
  let fres = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  if (in.mat == 26u) {
    // Clear lamp lens: nearly untinted, sharp reflections.
    let r = reflect(-v, nn);
    let l = F.sun.xyz;
    let h = normalize(v + l);
    let spec = D_GGX(saturate(dot(nn, h)), 0.0004) * V_SmithGGX(max(nv, 1e-3), saturate(dot(nn, l)), 0.0004) * fres;
    let refl = envRadiance(r, 0.02) * fres + F.sunColor.rgb * min(spec, 200.0) * sunShadow(in.world, nn) * saturate(dot(nn, l));
    o.color = vec4f(refl, 1.0 - 0.92 * (1.0 - fres));
    return o;
  }
  let interior = c.p4.x > 0.5;
    if (!interior && dot(n, v) < 0.0) {
    // The far pane, seen through the cabin: the headliner, shelf and seats
    // behind it block nearly all of the view out.
    o.color = vec4f(vec3f(0.0), 0.93);
    return o;
  }
  if (!interior) {
    // Tinted, reflective glass seen from outside.
    let r = reflect(-v, nn);
    let l = F.sun.xyz;
    let h = normalize(v + l);
    let sh = sunShadow(in.world, nn);
    let spec = D_GGX(saturate(dot(nn, h)), 0.0004) * V_SmithGGX(max(nv, 1e-3), saturate(dot(nn, l)), 0.0004) * fres;
    let refl = envRadiance(r, 0.02) * fres + F.sunColor.rgb * min(spec, 200.0) * sh * saturate(dot(nn, l));
    // Traffic glass is darker (privacy glass) than windscreens.
        let tint = select(0.86, 0.8, lp.z > c.p3.x - 0.9 && nn.y > 0.2);
    let a = 1.0 - (1.0 - tint) * (1.0 - fres);
    o.color = vec4f(refl, a);
    return o;
  }
  // From inside: faint reflections, snow on the glass, wipers.
  let g = glassCoord(lp, normalize(in.lnormal), c);
  let t = F.cam.w;
  var col = skyRadiance(reflect(-v, nn)) * fres * 0.25;
  var a = fres * 0.15;
    // (Water and snow on the glass: fsGlassFx + the tonemap pass.)

  if (g.region == 0u && F.glass.z > 0.5) {
    // Wiper arms and blades (dark rubber / painted steel).
    let ang = wiperAngle(t);
    var wiper = 0.0;
    for (var k = 0u; k < 2u; k++) {
      let pr = wiperPolar(g.uv, k);
      let rr = wiperRange(k);
      let off = abs(pr.y - ang) * pr.x; // metres from the blade line
      let blade = (1.0 - smoothstep(0.009, 0.013, off)) * step(rr.x, pr.x) * step(pr.x, rr.y);
      let arm = (1.0 - smoothstep(0.005, 0.008, off - 0.01)) * step(pr.x, rr.x + 0.3) * step(0.0, pr.x);
      wiper = max(wiper, max(blade, arm * 0.9));
      // Pivot cap.
      wiper = max(wiper, 1.0 - smoothstep(0.018, 0.024, pr.x));
    }
    col = col * (1.0 - wiper) + vec3f(0.008) * wiper;
    a = a + wiper * (1.0 - a);
  }
  o.color = vec4f(col, a);
  return o;
}

// ---- Water and snow on the player's glass (interior cameras): samples
// the simulated water atlas (src/render/glassWater.ts). Output: screen
// sampling offset (refraction through drops), shading (+ darken at drop
// rims / film, - highlight), snow cover; applied by the tonemap pass. ----
struct WaterPanes {
  pane: array<vec4f, 3>, // uMin, uMax, vMax, -
  misc: vec4f,
  wipe: vec4f,
};
@group(3) @binding(0) var waterTex: texture_2d<f32>;
@group(3) @binding(1) var waterSamp: sampler;
@group(3) @binding(2) var<uniform> WP: WaterPanes;

const WATER_HMAX = 0.0025;
const WATER_ATLAS = 2048.0;

fn waterRect(p: u32) -> vec4f {
  if (p == 0u) { return vec4f(0.0, 0.0, 1.0, 0.5); }
  if (p == 1u) { return vec4f(0.0, 0.5, 1.0, 0.25); }
  return vec4f(0.0, 0.75, 1.0, 0.25);
}

@fragment
fn fsGlassFx(in: VOut) -> @location(0) vec4f {
  let c = cars[in.car];
  let g = glassCoord(in.local, normalize(in.lnormal), c);
  // Derivatives first (uniform control flow): glass metres per pixel.
  let dx = dpdx(g.uv);
  let dy = dpdy(g.uv);
  var pane = 0u;
  if (g.region == 1u) { pane = select(2u, 1u, in.local.x > 0.0); }
  let pn = WP.pane[pane];
  let rc = waterRect(pane);
  let span = vec2f(pn.y - pn.x, pn.z);
  let t = vec2f((g.uv.x - pn.x) / span.x, 1.0 - g.uv.y / span.y);
  let auv = rc.xy + t * rc.zw;
  // Texel size in glass metres (for the height gradient).
  let texel = 1.0 / WATER_ATLAS;
  let mPerU = span.x / rc.z;
  let mPerV = span.y / rc.w;
  let w0 = textureSampleLevel(waterTex, waterSamp, auv, 0.0);
  let wx0 = textureSampleLevel(waterTex, waterSamp, auv - vec2f(texel, 0.0), 0.0).r;
  let wx1 = textureSampleLevel(waterTex, waterSamp, auv + vec2f(texel, 0.0), 0.0).r;
  let wy0 = textureSampleLevel(waterTex, waterSamp, auv - vec2f(0.0, texel), 0.0).r;
  let wy1 = textureSampleLevel(waterTex, waterSamp, auv + vec2f(0.0, texel), 0.0).r;
  if (in.mat != 1u || g.region == 2u) { discard; }
  // Height gradient (m/m) in glass coordinates (atlas v runs down the glass).
  let grad = vec2f(
    (wx1 - wx0) * WATER_HMAX / (2.0 * texel * mPerU),
    -(wy1 - wy0) * WATER_HMAX / (2.0 * texel * mPerV));
  // A drop is a lens: it shows an inverted, magnified view, i.e. sampling
  // moves with the surface slope. Convert glass metres -> pixels -> uv.
    // Water film: a rippled sheet streaming with the airflow (up the
  // windshield, back along the side windows), refracting everything behind.
  let speed = min(F.glass.x, 35.0);
  let tm = F.cam.w;
  var fq = vec2f(g.uv.x * 34.0, g.uv.y * 12.0 - tm * (0.4 + speed * 0.05));
  if (g.region == 1u) { fq = vec2f(g.uv.x * 10.0 + tm * (0.3 + speed * 0.06), g.uv.y * 30.0); }
  let e = 0.35;
  let n0 = vnoise(fq) + 0.5 * vnoise(fq * 2.7 + 5.1);
  let nx = vnoise(fq + vec2f(e, 0.0)) + 0.5 * vnoise((fq + vec2f(e, 0.0)) * 2.7 + 5.1);
  let ny = vnoise(fq + vec2f(0.0, e)) + 0.5 * vnoise((fq + vec2f(0.0, e)) * 2.7 + 5.1);
  let film = w0.b;
  let filmGrad = vec2f(nx - n0, ny - n0) / e;
  let offG = grad * 0.03 + filmGrad * film * 0.006;
  let det = dx.x * dy.y - dx.y * dy.x;
  var offUv = vec2f(0.0);
  if (abs(det) > 1e-12) {
    let offPx = vec2f(dy.y * offG.x - dy.x * offG.y, -dx.y * offG.x + dx.x * offG.y) / det;
    offUv = clamp(offPx / F.misc.zw, vec2f(-0.05), vec2f(0.05));
  }
  let slope = length(grad);
  // Rims darken (total internal reflection), a sky highlight on top, and a
  // faint darkening of wet film.
  let n = normalize(vec3f(-grad, 1.0));
  let hi = pow(saturate(dot(n, normalize(vec3f(0.25, 0.55, 1.0)))), 60.0) * step(0.02, w0.r);
    let shade = saturate(slope * 0.5) * 0.6 + film * 0.12 - hi * 1.2;
  return vec4f(offUv, shade, w0.g);
}

// ---- Contact shadow: a soft darkening under the car (sky occlusion the
// shadow maps don't capture), blended over the lit road. ----
struct BlobOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) car: u32,
};

@vertex
fn vsBlob(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BlobOut {
  let c = cars[ii];
  let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let q = corners[vi];
  let lp = vec3f(q.x * (c.p2.y + 0.25), 0.03, q.y * (c.p2.x + 0.3));
  var o: BlobOut;
  o.pos = F.viewProj * (c.model * vec4f(lp, 1.0));
  o.uv = q;
  o.car = ii;
  return o;
}

@fragment
fn fsBlob(in: BlobOut) -> GlassOut {
  let c = cars[in.car];
  // Rounded-rectangle distance in metres, falling off over ~0.3 m.
  let half = vec2f(c.p2.y + 0.25, c.p2.x + 0.3);
  let p = abs(in.uv) * half;
  let inner = vec2f(c.p2.y - 0.1, c.p2.x - 0.15);
  let d = length(max(p - inner, vec2f(0.0)));
  let a = 0.6 * (1.0 - smoothstep(0.0, 0.33, d));
  var o: GlassOut;
  o.color = vec4f(0.0, 0.0, 0.0, a);
  o.velocity = vec2f(0.0);
  o.normal = vec4f(0.0);
  return o;
}
