// Frustum-based grass: the CPU picks visible 8 m tiles around the camera
// (denser near the camera), a compute pass spawns blades per tile from
// world-space hashes, culls them, thins them with distance (widening the
// survivors so coverage stays constant) and appends to two LOD lists drawn
// with indirect instanced strips.

struct Tile {
  minX: f32,
  minZ: f32,
  n: f32,     // blades per side
  lod: f32,
};

struct Blade {
  pos: vec3f,
  height: f32,
  width: f32,
  rot: f32,
  bend: f32,
  kindTint: f32, // kind * 10 + tint
};

struct GrassParams {
  planes: array<vec4f, 6>,
  tileCount: u32,
  capNear: u32,
  capFar: u32,
  pad: u32,
};

@group(1) @binding(0) var<uniform> GP: GrassParams;
@group(1) @binding(1) var<storage, read> tiles: array<Tile>;
@group(1) @binding(2) var<storage, read_write> bladesNear: array<Blade>;
@group(1) @binding(3) var<storage, read_write> bladesFar: array<Blade>;
@group(1) @binding(4) var<storage, read_write> gargs: array<atomic<u32>, 8>;

fn fieldInfo(p: vec2f) -> vec4f {
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
  let a = hash01(i32(bid.x) + 9, i32(bid.y) + 5) * 3.14159;
  return vec4f(hash01(i32(bid.x) + 3, i32(bid.y) + 101), (second - best) * s, cos(a), sin(a));
}

fn visible(c: vec3f, r: f32) -> bool {
  for (var i = 0; i < 5; i++) {
    let pl = GP.planes[i];
    if (dot(pl.xyz, c) + pl.w < -r) { return false; }
  }
  return true;
}

@compute @workgroup_size(64)
fn spawn(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let tile = tiles[wg.x];
  let n = u32(tile.n);
  let total = n * n;
  let spacing = 8.0 / tile.n;
  let halfW = F.road.w;
  let density = F.palette[0].w;
  let hScale = F.palette[1].w;
  let crops = F.palette[10].x;
  let flowers = F.palette[11].x;
  for (var k = li; k < total; k += 64u) {
    let cx = k % n;
    let cz = k / n;
    let cell = vec2f(tile.minX, tile.minZ) + vec2f(f32(cx), f32(cz)) * spacing;
    let wc = cell + F.misc.xy;
    let ix = i32(floor(wc.x / spacing + 0.5));
    let iz = i32(floor(wc.y / spacing + 0.5));
    let h0 = pcg(bitcast<u32>(ix) * 3u + pcg(bitcast<u32>(iz) + u32(tile.n)));
    let r1 = rand01(h0);
    let r2 = rand01(pcg(h0 + 11u));
    let r3 = rand01(pcg(h0 + 12u));
    let p = cell + vec2f(r1, r2) * spacing;
    let world = p + F.misc.xy;
    let dist = distance(p, F.cam.xz);
    // Distance thinning (hash-stable, so blades fade rather than pop).
    let keep = saturate(1.0 - (dist - 18.0) / 110.0);
    let keep2 = keep * keep;
    if (r3 > keep2 * 1.0 + 0.02) { continue; }
    let g = clipSample(p, 0);
    let nrm = terrainNormal(g);
    let roadD = abs(g.w);
    if (roadD < halfW + 0.4) { continue; }
    if (nrm.y < 0.72) { continue; }
    if (F.palette[9].w > 0.5 && g.x < 3.0 && F.terrain[3].x != 0.0) { continue; }
    // Patchiness.
    let patchN = fbm2(world * 0.05, 3);
    var dens = density * smoothstep(0.15, 0.55, patchN + 0.25);
    // Thin out on the gravel shoulder.
    dens *= smoothstep(halfW + 0.4, halfW + 2.5, roadD);
    var kind = 0.0;
    var height = hScale * (0.55 + 0.9 * rand01(pcg(h0 + 13u))) * (0.7 + 0.6 * patchN);
    var bend = 0.3 + 0.5 * rand01(pcg(h0 + 14u));
    var tint = rand01(pcg(h0 + 15u));
    // Farm fields.
    if (crops > 0.0 && roadD > halfW + 8.0) {
      let fi = fieldInfo(world);
      if (fi.x < 0.55 * crops && fi.y > 1.5) {
        let kindF = fi.x / (0.55 * crops);
        let row = abs(fract(dot(world, fi.zw) / 0.9) - 0.5);
        if (kindF < 0.33) {        // wheat
          kind = 2.0; height = 0.85 + 0.2 * rand01(pcg(h0 + 16u)); bend = 0.15; dens = 1.4;
        } else if (kindF < 0.6) {  // green crop in rows
          if (row > 0.22) { continue; }
          kind = 3.0; height = 0.45; dens = 1.2;
        } else if (kindF < 0.8) {  // plowed
          continue;
        } else {                   // hay
          kind = 4.0; height = 0.18; dens = 1.0;
        }
      }
    }
    // Wildflowers (forest roadside, coast meadows).
    if (flowers > 0.0 && kind == 0.0) {
      let band = 1.0 - smoothstep(halfW + 6.0, halfW + 16.0, roadD);
      let fl = smoothstep(0.55, 0.75, fbm2(world * 0.08 + 13.0, 3)) * flowers * max(band, 0.25);
      if (rand01(pcg(h0 + 17u)) < fl * 0.35) { kind = 1.0; height *= 1.2; }
    }
    if (rand01(pcg(h0 + 18u)) > dens) { continue; }
    let pos = vec3f(p.x, g.x, p.y);
    if (!visible(pos + vec3f(0.0, height * 0.5, 0.0), height + 0.5)) { continue; }
    var b: Blade;
    b.pos = pos;
    b.height = height;
    b.width = (0.012 + 0.012 * rand01(pcg(h0 + 19u))) * sqrt(spacing / 0.07) / max(keep, 0.3);
    b.rot = rand01(pcg(h0 + 20u)) * 6.2831;
    b.bend = bend;
    b.kindTint = kind * 10.0 + tint;
    if (dist < 22.0) {
      let slot = atomicAdd(&gargs[1], 1u);
      if (slot < GP.capNear) { bladesNear[slot] = b; }
    } else {
      let slot = atomicAdd(&gargs[5], 1u);
      if (slot < GP.capFar) { bladesFar[slot] = b; }
    }
  }
}

// ---- Draw ----
@group(1) @binding(0) var<storage, read> blades: array<Blade>;

struct GOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) t: f32,
  @location(3) @interpolate(flat) kindTint: f32,
  @location(4) side: f32,
};

fn bladeVertex(b: Blade, vi: u32, segments: u32) -> GOut {
  let tipIdx = segments * 2u;
  var t: f32;
  var side: f32;
  if (vi >= tipIdx) {
    t = 1.0;
    side = 0.0;
  } else {
    t = f32(vi / 2u) / f32(segments);
    side = select(-1.0, 1.0, (vi & 1u) == 1u);
  }
  let facing = vec3f(cos(b.rot), 0.0, sin(b.rot));
  let across = vec3f(-facing.z, 0.0, facing.x);
  let kind = floor(b.kindTint / 10.0);
  var w = b.width * (1.0 - t * 0.85);
  if (kind == 2.0) { w *= 0.7; }
  var p = b.pos + vec3f(0.0, t * b.height, 0.0) + facing * (b.bend * t * t * b.height) + across * side * w;
  let wind = windOffset(p, t * t * 1.6, fract(b.rot)) ;
  p += wind * b.height;
  var o: GOut;
  o.world = p;
  o.pos = F.viewProj * vec4f(p, 1.0);
  // Normal: blade facing, rounded across, blended toward up.
  let bn = normalize(facing + across * side * 0.6 - vec3f(0.0, b.bend * t, 0.0));
  o.normal = normalize(mix(bn, vec3f(0.0, 1.0, 0.0), 0.55));
  o.t = t;
  o.kindTint = b.kindTint;
  o.side = side;
  return o;
}

@vertex
fn vsNear(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  return bladeVertex(blades[ii], vi, 3u);
}

@vertex
fn vsFar(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  var o = bladeVertex(blades[ii], vi, 1u);
  // Far blades are single triangles: keep their bases from reading as dark
  // cones (the base darkening is mostly hidden in the coverage anyway).
  o.t = 0.45 + 0.55 * o.t;
  return o;
}

@fragment
fn fs(in: GOut, @builtin(front_facing) ff: bool) -> GBufferOut {
  let kind = floor(in.kindTint / 10.0);
  let tv = fract(in.kindTint);
  let world2 = in.world.xz + F.misc.xy;
  // Base color matches the terrain's grass.
  let macroN = fbm2(world2 * 0.0025, 4);
  let mid = fbm2(world2 * 0.03, 4);
  var col = mix(pal(0), pal(1), saturate(macroN * 1.8 - 0.4));
  col = mix(col, pal(2), saturate(mid * 2.2 - 1.1) * 0.6);
  col *= 0.75 + 0.5 * tv;
  // Lighter, drier tips.
  col = mix(col * 0.35, mix(col, pal(2), 0.2) * 1.1, smoothstep(0.0, 0.9, in.t));
  if (kind == 1.0 && in.t > 0.8) {
    // Flower head.
    let hue = tv;
    col = mix(pal(7), vec3f(0.9, 0.9, 0.95), step(0.6, hue));
    col = mix(col, vec3f(0.55, 0.2, 0.75), step(0.85, hue));
  } else if (kind == 2.0) {
    col = mix(vec3f(0.35, 0.28, 0.1), vec3f(0.78, 0.62, 0.3), in.t) * (0.85 + 0.3 * tv);
  } else if (kind == 3.0) {
    col = mix(vec3f(0.05, 0.12, 0.03), vec3f(0.14, 0.3, 0.06), in.t);
  } else if (kind == 4.0) {
    col = mix(vec3f(0.4, 0.35, 0.15), vec3f(0.7, 0.62, 0.35), in.t);
  }
  let snow = F.palette[7].w;
  if (snow > 0.0) { col = mix(col, vec3f(0.8, 0.82, 0.86), snow * 0.6 * in.t); }
  var n = normalize(in.normal);
  var s: Surface;
  s.albedo = col;
  s.n = n;
  s.rough = 0.55;
  s.metal = 0.0;
  s.ao = mix(0.35, 1.0, in.t);
  s.spec = 0.4;
  s.sss = 0.7;
  let sh = sunShadow(in.world, n) * cloudShadow(in.world);
  var c = shadeSurface(s, in.world, sh);
  c = finishColor(c, in.world);
  return gbuffer(c, in.world, in.world, n, 0.55);
}
