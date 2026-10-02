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
  let mi = meshes[instMesh(inst.mesh)];
  let R = mi.radius * inst.scale;
  var center = inst.pos + vec3f(0.0, mi.centerY * inst.scale, 0.0);
  if (instLeaning(inst.mesh)) {
    center += instLean(inst.mesh, mi.centerY * inst.scale, mi.height * inst.scale);
  }
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

// Blend of the four nearest baked views (bilinear over the octahedral view
// grid, weighted by each view's coverage) so the impostor changes smoothly
// as the viewing angle sweeps past the baked directions.
struct ImpSample {
  albedo: vec3f,
  alpha: f32,
  normal: vec4f,
};

fn sampleImpostor(viewObj: vec3f, quv: vec2f, layer: i32) -> ImpSample {
  let g = hemiOctEncode(viewObj) * OCT_N - 0.5;
  let base = floor(g);
  let f = g - base;
  var col = vec3f(0.0);
  var alpha = 0.0;
  var nrm = vec4f(0.0);
  for (var i = 0; i < 4; i++) {
    let o = vec2f(f32(i & 1), f32(i >> 1));
    let w = select(1.0 - f.x, f.x, o.x > 0.5) * select(1.0 - f.y, f.y, o.y > 0.5);
    let cc = clamp(base + o, vec2f(0.0), vec2f(OCT_N - 1.0));
    let uv = (cc + quv) / OCT_N;
    let a = textureSampleLevel(impAlbedo, impSampler, uv, layer, 0.0);
    let nn = textureSampleLevel(impNormal, impSampler, uv, layer, 0.0);
    col += a.rgb * a.a * w;
    alpha += a.a * w;
    nrm += nn * a.a * w;
  }
  var s: ImpSample;
  s.alpha = alpha;
  s.albedo = col / max(alpha, 1e-4);
  s.normal = nrm / max(alpha, 1e-4);
  return s;
}

@fragment
fn fs(in: IOut) -> GBufferOut {
  let inst = insts[in.inst];
  if (fadeDiscard(inst.fade, in.pos.xy)) { discard; }
  let im = sampleImpostor(normalize(in.viewObj), in.quv, i32(instMesh(inst.mesh)));
  if (im.alpha < 0.5) { discard; }
  let a = vec4f(im.albedo, im.alpha);
  let nn = im.normal;
  let n = normalize(rotY(nn.xyz * 2.0 - 1.0, inst.rot));
  let t = inst.tint - 0.5;
  var s: Surface;
    s.albedo = a.rgb * (0.85 + 0.4 * t);
  // Broadleaf foliage (baked neutral) gets its autumn colour here.
  if (meshes[instMesh(inst.mesh)].kind > 0.5 && nn.a > 0.05) {
    s.albedo = autumnize(s.albedo, inst.tint);
  }
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
  if (fadeDiscard(inst.fade, in.pos.xy)) { discard; }
  let a = textureSampleLevel(impAlbedo, impSampler, uv, i32(instMesh(inst.mesh)), 0.0);
  if (a.a < 0.5) { discard; }
}
