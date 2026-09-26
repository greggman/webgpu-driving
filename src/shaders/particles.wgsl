// Procedural particles, no simulation state:
//  * weather (snow, leaves): positions are pure functions of index and time,
//    wrapped into a volume around the camera, motion-stretched, lit per vertex
//    (ambient + sun + headlights);
//  * dust plume: each particle respawns behind the player's car on a fixed
//    cycle; its spawn point comes from a short history of car positions.

struct PP {
  kind: u32,        // 0 = snow, 1 = leaves, 2 = dust
  count: u32,
  volume: f32,      // wrap volume size (m)
  size: f32,
  fall: f32,        // fall speed (m/s)
  life: f32,        // dust lifetime (s)
  histCount: u32,
  pad: u32,
  camVel: vec4f,    // camera velocity (local, m/s)
  color: vec4f,
};

@group(1) @binding(0) var<uniform> P: PP;
@group(1) @binding(1) var<storage, read> hist: array<vec4f>; // car rear pos xyz, speed

struct POut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) light: vec3f,
  @location(2) @interpolate(flat) alpha: f32,
  @location(3) @interpolate(flat) kind: u32,
};

fn wrapAround(p: vec3f, center: vec3f, L: f32) -> vec3f {
  return center + (fract((p - center) / L + 0.5) - 0.5) * L;
}

fn lightAt(p: vec3f, n: vec3f) -> vec3f {
  var c = shIrradiance(vec3f(0.0, 1.0, 0.0)) * 1.35 + F.sunColor.rgb * cloudShadow(p) * 0.5 / PI;
  let count = u32(F.lights.x);
  for (var i = 0u; i < count; i++) {
    let L = lightsBuf[i];
    let d = L.pos.xyz - p;
    let dist2 = dot(d, d);
    if (dist2 > L.pos.w * L.pos.w) { continue; }
    let l = d / sqrt(dist2);
    var att = 1.0 / max(dist2, 0.5);
    if (L.dir.w > -1.5) { att *= smoothstep(L.dir.w, L.color.w, dot(-l, L.dir.xyz)); }
    // Forward scattering toward the camera makes flakes in the beam glow.
    let fwd = 0.4 + 1.6 * pow(saturate(dot(normalize(F.cam.xyz - p), -l)), 4.0);
    c += L.color.rgb * att * fwd / PI;
  }
  return c;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  var o: POut;
  let h = pcg(ii * 7u + 1u);
  let r1 = rand01(h);
  let r2 = rand01(pcg(h + 1u));
  let r3 = rand01(pcg(h + 2u));
  let r4 = rand01(pcg(h + 3u));
  let t = F.cam.w;
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  o.uv = corner;
  o.kind = P.kind;
  var center: vec3f;
  var vel: vec3f;
  var size = P.size * (0.6 + 0.8 * r4);
  var alpha = 1.0;
  if (P.kind == 2u) {
    // Dust: cycle through lifetimes, spawning from the car history.
    let life = P.life * (0.7 + 0.6 * r4);
    let age = fract(t / life + r1) * life;
    let hi = min(u32(age / P.life * f32(P.histCount)), P.histCount - 1u);
    let src = hist[hi];
    let spread = vec3f(r2 - 0.5, 0.0, r3 - 0.5) * 2.2;
    let rise = vec3f((r3 - 0.5) * 1.5, 0.6 + r2 * 0.8, (r1 - 0.5) * 1.5) + vec3f(F.weather.x, 0.0, F.weather.y) * 1.5;
    center = src.xyz + spread + rise * age;
    size = P.size * (0.5 + age * 1.8) * (0.6 + 0.8 * r4);
    alpha = saturate(src.w / 12.0) * (1.0 - age / life) * smoothstep(0.0, 0.15, age) * 0.35;
    vel = rise;
  } else {
    let L = P.volume;
    let wind = vec3f(F.weather.x, 0.0, F.weather.y) * select(3.0, 1.5, P.kind == 1u);
    let swirl = vec3f(sin(t * 0.7 + r1 * 30.0), 0.0, cos(t * 0.6 + r2 * 30.0)) * select(0.4, 0.8, P.kind == 1u);
    vel = wind + swirl + vec3f(0.0, -P.fall * (0.7 + 0.6 * r3), 0.0);
    let base = vec3f(r1, r2, r3) * L * 7.0;
    center = wrapAround(base + vel * t, F.cam.xyz + P.camVel.xyz * 0.25, L);
    let dcam = distance(center, F.cam.xyz);
    alpha = saturate(1.0 - dcam / (L * 0.5)) * smoothstep(1.0, 4.0, dcam) * 0.75;
  }
  // Motion stretch relative to the camera.
  let relVel = vel - P.camVel.xyz;
  let toCam = normalize(F.cam.xyz - center);
  var up = relVel - toCam * dot(relVel, toCam);
  let speed = length(up);
  var right: vec3f;
  var stretch = 1.0;
  if (speed > 0.01) {
    up = up / speed;
    right = normalize(cross(up, toCam));
    stretch = 1.0 + speed * 0.012 / max(size, 0.005) * select(1.0, 0.0, P.kind == 2u);
  } else {
    right = F.camRight.xyz;
    up = F.camUp.xyz;
  }
  if (P.kind == 1u) {
    // Leaves tumble.
    let a = t * (2.0 + r4 * 3.0) + r1 * 6.28;
    let c = cos(a);
    let s = sin(a);
    let r0 = right;
    right = r0 * c + up * s;
    up = up * c - r0 * s;
    stretch = 1.0;
  }
  let world = center + right * corner.x * size + up * corner.y * size * min(stretch, 12.0);
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.light = lightAt(center, toCam);
  o.alpha = alpha * P.color.a / sqrt(min(stretch, 12.0));
  return o;
}

struct TOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
  @location(2) normal: vec4f,
};

@fragment
fn fs(in: POut) -> TOut {
  let r = length(in.uv);
  var a: f32;
  var col = P.color.rgb;
  if (in.kind == 1u) {
    // Leaf silhouette.
    let q = vec2f(in.uv.x * 1.6, in.uv.y);
    a = step(length(q), 1.0) * step(abs(in.uv.x), 0.95 - abs(in.uv.y) * 0.3);
    col = mix(P.color.rgb, P.color.rgb * vec3f(1.3, 0.8, 0.4), fract(in.pos.x * 0.37));
  } else if (in.kind == 2u) {
    a = smoothstep(1.0, 0.0, r) * (0.6 + 0.4 * vnoise(in.uv * 3.0 + in.pos.xy * 0.01));
  } else {
    a = smoothstep(1.0, 0.3, r);
  }
  a *= in.alpha;
  if (a < 0.003) { discard; }
  var o: TOut;
  let c = finishColor(col * in.light, F.cam.xyz);
  o.color = vec4f(c * a, a);
  o.velocity = vec2f(0.0);
  o.normal = vec4f(0.0);
  return o;
}
