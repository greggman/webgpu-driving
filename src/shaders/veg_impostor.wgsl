// Octahedral impostors for distant vegetation: a camera-facing quad that
// samples the atlas cell baked from the closest view direction (dithered
// between neighbouring cells; TAA blends them).

@group(1) @binding(0) var<storage, read> insts: array<Inst>;
@group(1) @binding(1) var<storage, read> meshes: array<MeshInfo>;
@group(1) @binding(2) var impAlbedo: texture_2d_array<f32>;
@group(1) @binding(3) var impNormal: texture_2d_array<f32>;
@group(1) @binding(4) var impSampler: sampler;
@group(2) @binding(0) var<uniform> shadowVP: mat4x4f;
@group(3) @binding(0) var<uniform> DI: DrawInfo;

struct IOut {
  @builtin(position) pos: vec4f,
  @location(0) quv: vec2f,
  @location(1) world: vec3f,
  @location(2) @interpolate(flat) inst: u32,
  @location(3) viewObj: vec3f,
};

fn billboard(vi: u32, inst: Inst, eye: vec3f, o: ptr<function, IOut>) -> vec3f {
  let mi = meshes[inst.mesh];
  let R = mi.radius * inst.scale;
  let center = inst.pos + vec3f(0.0, mi.centerY * inst.scale, 0.0);
  let toEye = normalize(eye - center);
  var dir = toEye;
  var right = cross(vec3f(0.0, 1.0, 0.0), dir);
  if (length(right) < 1e-3) { right = vec3f(1.0, 0.0, 0.0); }
  right = normalize(right);
  let up = cross(dir, right);
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  (*o).quv = vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  (*o).viewObj = rotY(toEye, -inst.rot);
  // Pull the quad toward the viewer so it doesn't clip into terrain.
  return center + (right * corner.x + up * corner.y) * R + dir * R * 0.3;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> IOut {
  let idx = DI.base + ii;
  let inst = insts[idx];
  var o: IOut;
  let w = billboard(vi, inst, F.cam.xyz, &o);
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.inst = idx;
  return o;
}

struct Cell {
  layer: i32,
  uv: vec2f,
};

fn pickCell(viewObj: vec3f, quv: vec2f, px: vec2f) -> vec2f {
  let g = hemiOctEncode(viewObj) * OCT_N - 0.5;
  let base = floor(g);
  let f = g - base;
  // Stochastic bilinear choice between the 4 nearest views.
  let h = ditherHash(px);
  let h2 = fract(h * 7.31 + 0.13);
  let c = base + vec2f(select(0.0, 1.0, h2 < f.x), select(0.0, 1.0, h < f.y));
  let cc = clamp(c, vec2f(0.0), vec2f(OCT_N - 1.0));
  return (cc + quv) / OCT_N;
}

@fragment
fn fs(in: IOut) -> GBufferOut {
  let inst = insts[in.inst];
  if (fadeDiscard(inst.fade, in.pos.xy)) { discard; }
  let uv = pickCell(normalize(in.viewObj), in.quv, in.pos.xy);
  let layer = i32(inst.mesh);
  let a = textureSampleLevel(impAlbedo, impSampler, uv, layer, 0.0);
  if (a.a < 0.5) { discard; }
  let nn = textureSampleLevel(impNormal, impSampler, uv, layer, 0.0);
  let n = normalize(rotY(nn.xyz * 2.0 - 1.0, inst.rot));
  let t = inst.tint - 0.5;
  var s: Surface;
  s.albedo = a.rgb * (0.85 + 0.4 * t);
  s.n = n;
  s.rough = 0.7;
  s.metal = 0.0;
  s.ao = 1.0;
  s.spec = 0.4;
  s.sss = nn.a * 0.5;
  let snow = F.palette[7].w;
  if (snow > 0.0) {
    s.albedo = mix(s.albedo, vec3f(0.85, 0.87, 0.9), saturate((n.y - 0.3) * 2.0) * snow);
  }
  let sh = sunShadow(in.world, n) * cloudShadow(in.world);
  var col = shadeSurface(s, in.world, sh);
  col = finishColor(col, in.world);
  return gbuffer(col, in.world, in.world, n, 0.7);
}

// Shadow: billboard faces the light.
@vertex
fn vsShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> IOut {
  let idx = DI.base + ii;
  let inst = insts[idx];
  var o: IOut;
  let far = inst.pos + F.sun.xyz * 5000.0;
  let w = billboard(vi, inst, far, &o);
  o.pos = shadowVP * vec4f(w, 1.0);
  o.world = w;
  o.inst = idx;
  return o;
}

@fragment
fn fsShadow(in: IOut) {
  let inst = insts[in.inst];
  let g = hemiOctEncode(normalize(in.viewObj)) * OCT_N - 0.5;
  let cc = clamp(floor(g + 0.5), vec2f(0.0), vec2f(OCT_N - 1.0));
  let uv = (cc + in.quv) / OCT_N;
  let a = textureSampleLevel(impAlbedo, impSampler, uv, i32(inst.mesh), 0.0);
  if (a.a < 0.5) { discard; }
}
