// Vegetation mesh draw (LOD0/LOD1), shadow and impostor bake.

@group(1) @binding(0) var<storage, read> insts: array<Inst>;
@group(1) @binding(1) var<storage, read> meshes: array<MeshInfo>;
@group(1) @binding(2) var impAlbedo: texture_2d_array<f32>;
@group(1) @binding(3) var impNormal: texture_2d_array<f32>;
@group(1) @binding(4) var impSampler: sampler;
@group(2) @binding(0) var<uniform> shadowVP: mat4x4f;
@group(3) @binding(0) var<uniform> DI: DrawInfo;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) mat: f32,
  @location(4) wind: f32,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) local: vec3f,
  @location(4) @interpolate(flat) mat: u32,
  @location(5) @interpolate(flat) inst: u32,
};

fn instWorld(v: VIn, inst: Inst) -> vec3f {
  let lp = rotY(v.pos * inst.scale, inst.rot);
  var w = inst.pos + lp;
  w += windOffset(w, v.wind * (0.4 + 0.6 * inst.scale), inst.tint);
  return w;
}

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let idx = DI.base + ii;
  let inst = insts[idx];
  var o: VOut;
  let w = instWorld(v, inst);
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.normal = rotY(v.normal, inst.rot);
  o.uv = v.uv;
  o.local = v.pos;
  o.mat = u32(v.mat + 0.5);
  o.inst = idx;
  return o;
}

fn isCard(mat: u32) -> bool {
  return mat == 1u || mat == 2u || mat == 7u;
}

@fragment
fn fs(in: VOut, @builtin(front_facing) ff: bool) -> GBufferOut {
  let inst = insts[in.inst];
  if (fadeDiscard(inst.fade, in.pos.xy)) { discard; }
  let card = isCard(in.mat);
  if (card) {
    let a = leafAlpha(in.uv, in.mat, fract(inst.tint * 7.0 + f32(in.inst % 13u) * 0.1));
    if (a < 0.5) { discard; }
  }
  let m = vegMaterial(in.mat, in.uv, inst.tint, in.local);
  var n = normalize(in.normal);
  if (!card && !ff) { n = -n; }
  var s: Surface;
  s.albedo = m.albedo;
  s.n = n;
  s.rough = m.rough;
  s.metal = 0.0;
  // Crown self-occlusion: darker toward the inside/bottom of the crown.
  let mi = meshes[inst.mesh];
  var ao = 1.0;
  if (card) {
    let h = saturate(in.local.y / max(mi.height, 0.1));
    ao = mix(0.45, 1.0, h);
  } else if (in.mat != 3u && in.mat != 4u) {
    ao = mix(0.5, 1.0, saturate(in.local.y / max(mi.height * 0.5, 0.1)));
  }
  s.ao = ao;
  s.spec = m.spec;
  s.sss = m.sss;
  // Snow cover on upward-facing surfaces.
  let snow = F.palette[7].w;
  if (snow > 0.0) {
    let sm = saturate((n.y - 0.3) * 2.0) * snow;
    s.albedo = mix(s.albedo, vec3f(0.85, 0.87, 0.9), sm);
  }
  let sh = sunShadow(in.world, n) * cloudShadow(in.world);
  var col = shadeSurface(s, in.world, sh);
  col = finishColor(col, in.world);
  return gbuffer(col, in.world, in.world, n, s.rough);
}

// ---- Shadows ----
struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) mat: u32,
  @location(2) @interpolate(flat) inst: u32,
};

@vertex
fn vsShadow(v: VIn, @builtin(instance_index) ii: u32) -> SOut {
  let idx = DI.base + ii;
  let inst = insts[idx];
  var o: SOut;
  o.pos = shadowVP * vec4f(instWorld(v, inst), 1.0);
  o.uv = v.uv;
  o.mat = u32(v.mat + 0.5);
  o.inst = idx;
  return o;
}

@fragment
fn fsShadow(in: SOut) {
  if (isCard(in.mat)) {
    let inst = insts[in.inst];
    let a = leafAlpha(in.uv, in.mat, fract(inst.tint * 7.0 + f32(in.inst % 13u) * 0.1));
    if (a < 0.5) { discard; }
  }
}

// ---- Impostor bake: 8x8 hemi-octahedral views into one atlas layer ----
struct BakeOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) mat: u32,
};

@group(1) @binding(5) var<uniform> bakeMesh: MeshInfo;

@vertex
fn vsBake(v: VIn, @builtin(instance_index) view: u32) -> BakeOut {
  let cell = vec2f(f32(view % 8u), f32(view / 8u));
  let dir = hemiOctDecode((cell + 0.5) / OCT_N);
  var right = cross(vec3f(0.0, 1.0, 0.0), dir);
  if (length(right) < 1e-3) { right = vec3f(1.0, 0.0, 0.0); }
  right = normalize(right);
  let up = cross(dir, right);
  let R = bakeMesh.radius;
  let q = v.pos - vec3f(0.0, bakeMesh.centerY, 0.0);
  let x = dot(q, right) / R;
  let y = dot(q, up) / R;
  let z = dot(q, dir) / R;
  let ndc = vec2f(x, y) / OCT_N + vec2f((cell.x + 0.5) / OCT_N * 2.0 - 1.0, 1.0 - (cell.y + 0.5) / OCT_N * 2.0);
  var o: BakeOut;
  o.pos = vec4f(ndc, 0.5 + 0.5 * z, 1.0);
  o.uv = v.uv;
  o.normal = v.normal;
  o.local = v.pos;
  o.mat = u32(v.mat + 0.5);
  return o;
}

struct BakeTargets {
  @location(0) albedo: vec4f,
  @location(1) normal: vec4f,
};

@fragment
fn fsBake(in: BakeOut, @builtin(front_facing) ff: bool) -> BakeTargets {
  let card = isCard(in.mat);
  if (card) {
    if (leafAlpha(in.uv, in.mat, 0.37) < 0.5) { discard; }
  }
  let m = vegMaterial(in.mat, in.uv, 0.5, in.local);
  var n = normalize(in.normal);
  if (!card && !ff) { n = -n; }
  var ao = 1.0;
  if (card) { ao = mix(0.45, 1.0, saturate(in.local.y / max(bakeMesh.height, 0.1))); }
  var o: BakeTargets;
  o.albedo = vec4f(m.albedo * ao, 1.0);
  o.normal = vec4f(n * 0.5 + 0.5, select(0.0, 1.0, card));
  return o;
}
