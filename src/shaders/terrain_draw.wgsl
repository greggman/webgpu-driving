// CDLOD terrain: one 32x32 grid patch instanced per quadtree node. Heights
// come from the clipmap textures; vertices morph toward the next coarser grid
// as they approach the LOD's range, so there is no popping and no cracks.

@group(2) @binding(0) var<uniform> shadowVP: mat4x4f;

struct Node {
  minX: f32,
  minZ: f32,
  size: f32,
  lod: f32,
};
@group(1) @binding(0) var<storage, read> nodes: array<Node>;

const GRID = 32.0;
const LOD_RANGE0 = 48.0;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) viewDist: f32,
};

fn morphRange(lod: f32) -> vec2f {
  let r = LOD_RANGE0 * exp2(lod);
  return vec2f(r * 0.78, r * 0.96);
}

fn terrainVertex(vi: u32, ii: u32, eye: vec3f) -> vec3f {
  let node = nodes[ii];
  let gi = vec2f(f32(vi % 33u), f32(vi / 33u));
  let lod = i32(node.lod);
  let spacing = node.size / GRID;
  let p0 = vec2f(node.minX, node.minZ) + gi * spacing;
  let l0 = clipLevelFor(p0, clamp(lod, 0, CLIP_LEVELS - 1));
  let h0 = clipSampleLevel(p0, l0).x;
  let dist = distance(eye, vec3f(p0.x, h0, p0.y));
  let mr = morphRange(node.lod);
  let k = saturate((dist - mr.x) / (mr.y - mr.x));
  let frac = fract(gi * 0.5) * 2.0;
  let g = gi - frac * k;
  let p = vec2f(node.minX, node.minZ) + g * spacing;
  let l = clipLevelFor(p, clamp(lod, 0, CLIP_LEVELS - 1));
  let h = clipSampleLevel(p, l).x;
  return vec3f(p.x, h, p.y);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let w = terrainVertex(vi, ii, F.cam.xyz);
  var o: VOut;
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.viewDist = distance(w, F.cam.xyz);
  return o;
}

@vertex
fn vsShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  // Shadow geometry uses camera-distance LODs so it matches the main view.
  let w = terrainVertex(vi, ii, F.cam.xyz);
  return shadowVP * vec4f(w, 1.0);
}

// Far-field terrain self-shadowing: march the clipmap toward the sun.
fn heightfieldShadow(p: vec3f) -> f32 {
  if (F.sun.y <= 0.0) { return 1.0; }
  var t = 12.0;
  var occ = 1.0;
  let horiz = length(F.sun.xz);
  for (var i = 0; i < 14; i++) {
    let q = p + F.sun.xyz * t;
    let lvl = clipLevelFor(q.xz, clamp(i32(log2(max(t, 1.0) * 0.06)), 0, CLIP_LEVELS - 1));
    let h = clipSampleLevel(q.xz, lvl).x;
    let dh = q.y - h;
    occ = min(occ, saturate(dh / (t * 0.035 * max(horiz, 0.2)) + 0.5));
    t *= 1.45;
  }
  return occ;
}

// Voronoi field cells (country crops, pastures).
struct Field {
  id: f32,
  edge: f32,
  dir: vec2f,
};
fn fieldCell(p: vec2f) -> Field {
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
  var f: Field;
  f.id = hash01(i32(bid.x) + 3, i32(bid.y) + 101);
  f.edge = (second - best) * s;
  let a = hash01(i32(bid.x) + 9, i32(bid.y) + 5) * 3.14159;
  f.dir = vec2f(cos(a), sin(a));
  return f;
}

@fragment
fn fs(in: VOut) -> GBufferOut {
  let wp = in.world;
  let dist = in.viewDist;
  let minL = clamp(i32(floor(log2(max(dist * 0.004, 0.5) / 0.5))), 0, CLIP_LEVELS - 1);
  let g = clipSample(wp.xz, minL);
  var n = terrainNormal(g);
  let roadD = abs(g.w);
  let halfW = F.road.w;
  let world2 = wp.xz + F.misc.xy;

  // ---- Material ----
  let macroN = fbm2(world2 * 0.0025, 4);
  let mid = fbm2(world2 * 0.03, 4);
  let fine = vnoise(world2 * 0.9) * 0.5 + vnoise(world2 * 3.1) * 0.5;
  let slope = 1.0 - n.y;

  // Detail normal (fades with distance).
  let dn = saturate(1.0 - dist / 120.0);
  if (dn > 0.0) {
    // Analytic gradient-noise slopes (C2 smooth, no grid artifacts).
    let g1 = noised(world2 * 0.9).yz * 0.9;
    let g2 = noised(world2 * 2.7 + 13.1).yz * 2.7 * 0.35;
    let g3 = noised(world2 * 8.1 + 7.7).yz * 8.1 * 0.1;
    let slope2 = (g1 + g2 + g3) * 0.12 * dn;
    n = normalize(n + vec3f(-slope2.x, 0.0, -slope2.y));
  }

  var grass = mix(pal(0), pal(1), saturate(macroN * 1.8 - 0.4));
  grass = mix(grass, pal(2), saturate(mid * 2.2 - 1.1) * 0.6);
  grass *= 0.8 + 0.4 * fine;
  var albedo = grass;
  var rough = 0.85;

  // Farm fields (country).
  if (F.palette[10].x > 0.0 && roadD > halfW + 8.0) {
    let fld = fieldCell(world2);
    if (fld.id < 0.55 * F.palette[10].x) {
      let rows = sin(dot(world2, fld.dir) * 3.14159 / 0.9);
      let kind = fld.id / (0.55 * F.palette[10].x);
      var crop: vec3f;
      if (kind < 0.33) { crop = vec3f(0.62, 0.52, 0.22); }       // wheat
      else if (kind < 0.6) { crop = vec3f(0.2, 0.33, 0.07); }     // green crop
      else if (kind < 0.8) {                                      // plowed furrows
        crop = vec3f(0.3, 0.22, 0.14) * (0.75 + 0.35 * (0.5 + 0.5 * rows));
        let fs = cos(dot(world2, fld.dir) * 3.14159 / 0.9) * 0.6 * saturate(1.0 - dist / 250.0);
        n = normalize(n + vec3f(fld.dir.x, 0.0, fld.dir.y) * fs);
      }
      else { crop = vec3f(0.42, 0.45, 0.14); }                    // hay
      crop *= 0.85 + 0.15 * rows * saturate(1.0 - dist / 400.0) + 0.1 * (fine - 0.5);
      let edgeMask = smoothstep(1.5, 4.0, fld.edge);
      albedo = mix(albedo, crop, edgeMask);
    }
  }

  // Rock on steep slopes and road cuts.
  let rockCol = pal(4) * (0.7 + 0.5 * mid) * (0.85 + 0.3 * fine);
  let strata = 0.9 + 0.1 * sin(wp.y * 1.7 + mid * 6.0);
  let rockMask = smoothstep(0.32, 0.5, slope + (mid - 0.5) * 0.2);
  albedo = mix(albedo, rockCol * strata, rockMask);
  rough = mix(rough, 0.75, rockMask);

  // Sand near the sea / desert washes.
  let sandMask = smoothstep(4.0, 1.0, wp.y) * F.palette[9].w;
  albedo = mix(albedo, pal(5) * (0.9 + 0.2 * fine), saturate(sandMask));
  // Wet sand where waves wash up (darker, glossy).
  let wet = smoothstep(1.4, 0.3, wp.y) * F.palette[9].w * step(0.5, abs(F.terrain[3].x));
  albedo *= 1.0 - 0.45 * wet;
  rough = mix(rough, 0.2, wet);

  // Road shoulder: gravel/dirt strip.
  let shoulder = 1.0 - smoothstep(halfW + 0.3, halfW + 2.2 + mid * 1.5, roadD);
  albedo = mix(albedo, pal(3) * (0.8 + 0.4 * fine), shoulder);

  // Snow cover (flat areas first).
  let snowAmt = F.palette[7].w;
  if (snowAmt > 0.0) {
    let sm = saturate((n.y - 0.6 + (mid - 0.5) * 0.3) * 4.0) * snowAmt;
    albedo = mix(albedo, vec3f(0.9, 0.92, 0.96), sm);
    rough = mix(rough, 0.6, sm);
  }

  var s: Surface;
  s.albedo = albedo;
  s.n = n;
  s.rough = rough;
  s.metal = 0.0;
  s.ao = 1.0;
  s.spec = 0.5;
  s.sss = 0.0;
  var sh = sunShadow(wp, n) * cloudShadow(wp);
  if (dist > F.cascade[2] * 0.6) {
    let hs = heightfieldShadow(wp + n * 2.0);
    sh = min(sh, mix(1.0, hs, saturate((dist - F.cascade[2] * 0.6) / (F.cascade[2] * 0.4))));
  }
  var col = shadeSurface(s, wp, sh);
  col = finishColor(col, wp);
  return gbuffer(col, wp, wp, n, rough);
}
