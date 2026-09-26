// Roadside props: fences, guardrails, poles, wires, piers, farm buildings,
// signs. Point props are instanced (pos, yaw, stretch); linear props (rails,
// wires) are baked per road chunk in local coordinates (identity instance).

struct PropInst {
  pos: vec3f,
  yaw: f32,
  stretch: f32, // y scale
  scale: f32,
  tint: f32,
  roll: f32, // rotation about the local x axis (tumbleweeds)
};

@group(1) @binding(0) var<storage, read> props: array<PropInst>;
@group(2) @binding(0) var<uniform> shadowVP: mat4x4f;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) mat: f32,
  @location(4) wind: f32,
};

struct POut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) local: vec3f,
  @location(4) @interpolate(flat) mat: u32,
  @location(5) @interpolate(flat) tint: f32,
};

fn rotX(v: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

fn propWorld(v: VIn, p: PropInst) -> vec3f {
  var lp = vec3f(v.pos.x * p.scale, v.pos.y * p.stretch, v.pos.z * p.scale);
  if (p.roll != 0.0) { lp = rotX(lp, p.roll); }
  return p.pos + rotY(lp, p.yaw);
}

fn rotY(v: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> POut {
  let p = props[ii];
  var o: POut;
  let w = propWorld(v, p);
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.normal = rotY(select(v.normal, rotX(v.normal, p.roll), p.roll != 0.0), p.yaw);
  o.uv = v.uv;
  o.local = v.pos;
  o.mat = u32(v.mat + 0.5);
  o.tint = p.tint;
  return o;
}

@vertex
fn vsShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return shadowVP * vec4f(propWorld(v, props[ii]), 1.0);
}

@fragment
fn fs(in: POut, @builtin(front_facing) ff: bool) -> GBufferOut {
  var n = normalize(in.normal);
  if (!ff) { n = -n; }
  let wp = in.world;
  let w2 = wp.xz + F.misc.xy;
  let grain = vnoise(vec2f(in.uv.x * 3.0 + wp.y * 0.5, wp.y * 12.0 + w2.x * 0.3));
  let dirt = fbm2(w2 * 0.7 + wp.y, 3);
  var s: Surface;
  s.n = n;
  s.metal = 0.0;
  s.rough = 0.8;
  s.ao = 1.0;
  s.spec = 0.5;
  s.sss = 0.0;
  var emissive = vec3f(0.0);
  let t = in.tint - 0.5;
  switch (in.mat) {
    case 0u: { s.albedo = vec3f(0.36, 0.27, 0.17) * (0.75 + 0.35 * grain) * (0.9 + 0.3 * t); }
    case 10u: { s.albedo = vec3f(0.2, 0.15, 0.1) * (0.7 + 0.4 * grain); }
    case 1u: {
      s.albedo = vec3f(0.42, 0.43, 0.44) * (0.8 + 0.3 * dirt);
      s.metal = 0.6;
      s.rough = 0.5 + 0.3 * dirt;
    }
    case 2u: { s.albedo = vec3f(0.52, 0.5, 0.46) * (0.75 + 0.35 * dirt); s.rough = 0.9; }
    case 3u: {
      // Weathered barn red with vertical boards.
      let boards = 0.85 + 0.15 * step(0.1, fract(in.local.x * 3.0 + in.local.z * 3.0));
      s.albedo = vec3f(0.42, 0.07, 0.05) * boards * (0.75 + 0.4 * dirt);
    }
    case 4u: { s.albedo = vec3f(0.78, 0.77, 0.72) * (0.85 + 0.2 * dirt); }
    case 5u: {
      // Corrugated metal / shingles.
      let corr = 0.8 + 0.2 * sin(in.uv.x * 120.0);
      s.albedo = vec3f(0.22, 0.22, 0.24) * corr * (0.8 + 0.3 * dirt);
      s.metal = 0.5;
      s.rough = 0.5;
    }
    case 6u: {
      // Yellow warning diamond with a black curve arrow.
      let q = in.uv - 0.5;
      let border = step(0.44, abs(q.x) + abs(q.y));
      let arrow = step(abs(q.x - 0.08 * sin(q.y * 9.0)), 0.035) * step(abs(q.y), 0.25);
      s.albedo = mix(vec3f(0.85, 0.65, 0.05), vec3f(0.02), max(border, arrow));
      s.rough = 0.4;
      // Retroreflective at night.
      emissive = s.albedo * localRetro(wp) * 0.6;
    }
    case 7u: {
      s.albedo = vec3f(0.9, 0.9, 0.9);
      s.rough = 0.2;
      emissive = vec3f(1.0, 0.95, 0.85) * localRetro(wp) * 2.0;
    }
    case 8u: {
      s.albedo = vec3f(0.02, 0.025, 0.03);
      s.rough = 0.05;
      // Warm window light at night.
      emissive = vec3f(1.0, 0.7, 0.35) * F.moon.w * step(0.4, in.tint) * 1.2;
    }
    case 9u: { s.albedo = vec3f(0.03); s.rough = 0.5; }
    default: { s.albedo = vec3f(0.5); }
  }
  let snow = F.palette[7].w;
  if (snow > 0.0 && in.mat != 8u) {
    s.albedo = mix(s.albedo, vec3f(0.85, 0.87, 0.9), saturate((n.y - 0.5) * 3.0) * snow);
  }
  let sh = sunShadow(wp, n) * cloudShadow(wp);
  var col = shadeSurface(s, wp, sh) + emissive;
  col = finishColor(col, wp);
  return gbuffer(col, wp, wp, n, s.rough);
}

// Retroreflection: brightness from headlights pointing back at the viewer.
fn localRetro(wp: vec3f) -> f32 {
  let count = u32(F.lights.x);
  var r = 0.0;
  for (var i = 0u; i < count; i++) {
    let L = lightsBuf[i];
    if (L.dir.w < -1.5) { continue; }
    let d = wp - L.pos.xyz;
    let dist = length(d);
    let cd = dot(d / dist, L.dir.xyz);
    let toCam = normalize(F.cam.xyz - wp);
    r += smoothstep(L.dir.w, L.color.w, cd) * saturate(dot(-d / dist, toCam) * 4.0 - 3.0) * 400.0 / max(dist * dist, 4.0);
  }
  return r;
}
