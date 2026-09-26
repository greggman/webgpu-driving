// GPU scatter: every frame, each grid cell around the camera deterministically
// decides (from world-space hashes) whether it holds a plant/rock, where, and
// which one; then frustum-culls it and appends it to the instance list of the
// right mesh LOD (indirect draw args are bumped atomically).

struct TypeInfo {
  mesh: u32,       // first mesh index
  variants: u32,   // number of mesh variants
  weight: f32,     // base probability
  cluster: u32,    // mask mode
  minRoad: f32,
  maxSlope: f32,
  scaleMin: f32,
  scaleMax: f32,
};

struct ScatterParams {
  gridMin: vec2f,  // local, aligned to the world cell grid
  cell: f32,
  dim: u32,
  lod0: f32,
  lod1: f32,
  maxDist: f32,
  typeCount: u32,
  planes: array<vec4f, 6>,
  types: array<TypeInfo, 8>,
  seed: u32,
  impostors: u32,
  pad0: u32,
  pad1: u32,
};

@group(1) @binding(0) var<uniform> SP: ScatterParams;
@group(1) @binding(1) var<storage, read_write> insts: array<Inst>;
@group(1) @binding(2) var<storage, read_write> args: array<atomic<u32>>;
@group(1) @binding(3) var<storage, read> meshes: array<MeshInfo>;
@group(1) @binding(4) var<uniform> caps: array<vec4u, 48>; // per draw: base, capacity

fn fieldEdge(p: vec2f) -> vec2f {
  // Distance to the nearest Voronoi field boundary + field id (matches terrain).
  let s = 90.0;
  let g = p / s;
  let i = floor(g);
  var best = 1e9;
  var second = 1e9;
  var bid = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = i + vec2f(f32(x), f32(y));
      let o = vec2f(hash01(i32(c.x), i32(c.y)), hash01(i32(c.x) + 71, i32(c.y) + 13));
      let d = length(g - c - o * 0.85);
      if (d < best) { second = best; best = d; bid = c; } else if (d < second) { second = d; }
    }
  }
  return vec2f((second - best) * s, hash01(i32(bid.x) + 3, i32(bid.y) + 101));
}

fn sphereVisible(c: vec3f, r: f32) -> bool {
  for (var i = 0; i < 6; i++) {
    let pl = SP.planes[i];
    if (dot(pl.xyz, c) + pl.w < -r) { return false; }
  }
  return true;
}

fn emit(drawIdx: u32, inst: Inst) {
  let cap = caps[drawIdx];
  let slot = atomicAdd(&args[drawIdx * 5u + 1u], 1u);
  if (slot < cap.y) {
    insts[cap.x + slot] = inst;
  }
}

@compute @workgroup_size(8, 8)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(SP.dim))) { return; }
  let cellMin = SP.gridMin + vec2f(id.xy) * SP.cell;
  let wc = cellMin + F.misc.xy;
  let ix = i32(floor(wc.x / SP.cell + 0.5));
  let iz = i32(floor(wc.y / SP.cell + 0.5));
  let h0 = pcg(bitcast<u32>(ix) + pcg(bitcast<u32>(iz) + SP.seed));
  let r0 = rand01(h0);
  let r1 = rand01(pcg(h0 + 1u));
  let r2 = rand01(pcg(h0 + 2u));
  let r3 = rand01(pcg(h0 + 3u));
  let r4 = rand01(pcg(h0 + 4u));
  let p = cellMin + vec2f(r1, r2) * SP.cell;
  let dist = distance(p, F.cam.xz);
  if (dist > SP.maxDist) { return; }
  let lvl = clamp(i32(log2(max(dist, 1.0) * 0.004 / 0.5)), 0, CLIP_LEVELS - 1);
  let g = clipSample(p, lvl);
  let n = terrainNormal(g);
  let slope = 1.0 - n.y;
  let roadD = abs(g.w);
  let world = p + F.misc.xy;
  if (g.x < 1.0 && F.palette[9].w > 0.5 && F.terrain[3].x != 0.0) { return; } // sea

  // Pick a type by cumulative masked probability.
  var acc = 0.0;
  var chosen = -1;
  for (var t = 0u; t < SP.typeCount; t++) {
    let ti = SP.types[t];
    var w = ti.weight;
    if (roadD < ti.minRoad || slope > ti.maxSlope) { w = 0.0; }
    if (ti.cluster == 1u) {
      // Forest patches.
      let f = fbm2(world * 0.0035 + vec2f(f32(SP.seed % 97u)), 4);
      w *= smoothstep(0.38, 0.62, f);
      // Trees stay out of crop fields.
      if (F.palette[10].x > 0.0) {
        let fe = fieldEdge(world);
        if (fe.y < 0.55 * F.palette[10].x && fe.x > 6.0) { w = 0.0; }
      }
    } else if (ti.cluster == 2u) {
      // Hedgerows along field boundaries.
      let fe = fieldEdge(world);
      w *= 1.0 - smoothstep(1.0, 2.5, fe.x);
    } else if (ti.cluster == 3u) {
      // Roadside band.
      w *= 1.0 - smoothstep(ti.minRoad + 6.0, ti.minRoad + 14.0, roadD);
    } else if (ti.cluster == 4u) {
      // Rocks prefer slopes and cuts.
      w *= 0.25 + saturate(slope * 4.0);
    } else if (ti.cluster == 5u) {
      // Sparse, with gentle clumping.
      w *= 0.4 + 1.2 * fbm2(world * 0.01, 3);
    }
    acc += w;
    if (r0 < acc) { chosen = i32(t); break; }
  }
  if (chosen < 0) { return; }
  let ti = SP.types[chosen];
  let variant = u32(r3 * f32(ti.variants)) % ti.variants;
  let mesh = ti.mesh + variant;
  let mi = meshes[mesh];
  let scale = mix(ti.scaleMin, ti.scaleMax, r4);
  let pos = vec3f(p.x, g.x - 0.08 * scale, p.y);
  let center = pos + vec3f(0.0, mi.centerY * scale, 0.0);
  let radius = mi.radius * scale;
  let d3 = distance(center, F.cam.xyz);
  // Near objects are kept even off-screen so they still cast shadows.
  if (d3 > 70.0 + radius && !sphereVisible(center, radius)) { return; }

  var inst: Inst;
  inst.pos = pos;
  inst.scale = scale;
  inst.rot = rand01(pcg(h0 + 5u)) * 6.2831853;
  inst.tint = rand01(pcg(h0 + 6u));
  inst.mesh = mesh;
  // LOD selection. Each instance switches at its own hashed distance (+-15%)
  // so transitions are spread out and never need screen-space dithering
  // (which fights TAA's neighbourhood clamp and reads as a checkerboard).
  let jit = 0.85 + 0.3 * rand01(pcg(h0 + 7u));
  let l0 = SP.lod0 * (0.6 + 0.4 * scale) * jit;
  let l1 = SP.lod1 * (0.6 + 0.4 * scale) * jit;
  let base = mesh * 3u;
  inst.fade = 0.0;
  if (d3 < l0) {
    emit(base, inst);
  } else if (d3 < l1) {
    emit(base + 1u, inst);
  } else if (SP.impostors != 0u && dist < SP.maxDist * (0.9 + 0.1 * jit)) {
    emit(base + 2u, inst);
  }
}
