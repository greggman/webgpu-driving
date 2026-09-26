// Clustered light culling: 16x9x24 froxel clusters (exponential depth). Each
// cluster stores up to CL_MAX light indices; fragments only loop over their
// cluster's lights.
const CL_X = 16u;
const CL_Y = 9u;
const CL_Z = 24u;
const CL_MAX = 31u;
const CL_NEAR = 0.3;
const CL_FAR = 600.0;

struct Light {
  pos: vec4f,
  dir: vec4f,
  color: vec4f,
};

@group(0) @binding(10) var<storage, read> lightsC: array<Light>;
@group(0) @binding(14) var<storage, read_write> clusterOut: array<u32>;

fn clusterSliceDepth(k: f32) -> f32 {
  return CL_NEAR * pow(CL_FAR / CL_NEAR, k / f32(CL_Z));
}

@compute @workgroup_size(4, 4, 4)
fn build(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= CL_X || id.y >= CL_Y || id.z >= CL_Z) { return; }
  let tanY = F.camFwd.w;
  let tanX = tanY * F.misc.z / F.misc.w;
  let n0 = vec2f(f32(id.x) / f32(CL_X), f32(id.y) / f32(CL_Y)) * 2.0 - 1.0;
  let n1 = vec2f(f32(id.x + 1u) / f32(CL_X), f32(id.y + 1u) / f32(CL_Y)) * 2.0 - 1.0;
  let z0 = clusterSliceDepth(f32(id.z));
  let z1 = clusterSliceDepth(f32(id.z + 1u));
  // View-space AABB of the froxel (y flipped: tile rows go down the screen).
  var mn = vec3f(1e9);
  var mx = vec3f(-1e9);
  for (var c = 0u; c < 8u; c++) {
    let nx = select(n0.x, n1.x, (c & 1u) != 0u);
    let ny = -select(n0.y, n1.y, (c & 2u) != 0u);
    let z = select(z0, z1, (c & 4u) != 0u);
    let p = vec3f(nx * tanX * z, ny * tanY * z, -z);
    mn = min(mn, p);
    mx = max(mx, p);
  }
  let base = ((id.z * CL_Y + id.y) * CL_X + id.x) * (CL_MAX + 1u);
  var count = 0u;
  let n = u32(F.lights.x);
  for (var i = 0u; i < n; i++) {
    let L = lightsC[i];
    let vp = (F.view * vec4f(L.pos.xyz, 1.0)).xyz;
    let q = clamp(vp, mn, mx);
    let d = vp - q;
    if (dot(d, d) <= L.pos.w * L.pos.w && count < CL_MAX) {
      clusterOut[base + 1u + count] = i;
      count++;
    }
  }
  clusterOut[base] = count;
}
