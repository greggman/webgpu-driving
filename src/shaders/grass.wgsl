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
  // pack4x8unorm(bend, base-colour mix weights (see grassMix), 0)
  bendMix: u32,
  kindTint: f32, // kind * 10 + tint
};

struct GrassParams {
  planes: array<vec4f, 6>,
  tileCount: u32,
  capNear: u32,
  capFar: u32,
  densityScale: f32,
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
  let halfW = F.road.w;
  let density = F.palette[0].w;
  let hScale = F.palette[1].w;
  let crops = F.palette[10].x;
  let flowers = F.palette[11].x;
  // Nested grids: tiles use spacing 1/16, 1/8, 1/4 or 1/2 m (n = 128..16),
  // and every candidate is identified by its index on the finest grid, so a
  // coarse tile's candidates are exactly a subset of a fine tile's. Each
  // candidate belongs to the coarsest "class" grid it lies on; its jittered
  // position and existence depend only on that, never on the tile level, so
  // tiles changing LOD as the camera moves swap nothing.
  let step = 128u / n; // finest cells per candidate
  let origin = vec2i(floor((vec2f(tile.minX, tile.minZ) + F.misc.xy) * 16.0 + 0.5));
  for (var k = li; k < total; k += 64u) {
    let fi = origin + vec2i(i32(k % n), i32(k / n)) * i32(step);
    // Class = coarsest level (0..3) whose grid contains this point.
    let tz = min(countTrailingZeros(bitcast<u32>(fi.x) | 0x80000000u),
                 countTrailingZeros(bitcast<u32>(fi.y) | 0x80000000u));
    let cls = min(tz, 3u);
    let cellSize = f32(1u << cls) / 16.0;
    let h0 = pcg(bitcast<u32>(fi.x) * 3u + pcg(bitcast<u32>(fi.y) + 77u));
    let r1 = rand01(h0);
    let r2 = rand01(pcg(h0 + 11u));
    let r3 = rand01(pcg(h0 + 12u));
    let world = vec2f(fi) / 16.0 + (vec2f(r1, r2) - 0.5) * cellSize;
    let p = world - F.misc.xy;
    let dist = distance(p, F.cam.xz);
    // Continuous blade density (per m^2) filled coarse classes first:
    // class 3 holds 4/m^2, class 2 12, class 1 48, class 0 192.
    let D = 190.0 * GP.densityScale * min(1.0, pow(6.0 / max(dist, 0.1), 1.3)) * saturate((132.0 - dist) / 20.0);
    let below = array<f32, 4>(64.0, 16.0, 4.0, 0.0);
    let capOnly = array<f32, 4>(192.0, 48.0, 12.0, 4.0);
    let prob = saturate((D - below[cls]) / capOnly[cls]);
    if (r3 >= prob) { continue; }
    // Blades shrink to nothing just before they drop out (no popping).
    let grow = saturate((prob - r3) / 0.12);
    // Wider blades as density falls keep the coverage constant.
    let widen = min(sqrt(190.0 / max(D, 1.0)), 6.0);
    let g = clipSample(p, 0);
    let nrm = terrainNormal(g);
    let roadD = abs(g.w);
    if (roadD < halfW + 0.4) { continue; }
    if (nrm.y < 0.72) { continue; }
    // None in a tunnel's bore (where the hill rises back from the cut).
    if (boreDepth(vec3f(p.x, g.x, p.y), 1.0) >= 1.0) { continue; }
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
        // Flowering plants (~0.6-1.1 m, drawn as billboards): only on the
    // coarsest candidate grid, so they persist out to the grass limit, in
    // patches that are densest along the roadside.
    var plant = false;
    if (flowers > 0.0 && kind == 0.0 && cls == 3u) {
      let band = 1.0 - smoothstep(halfW + 5.0, halfW + 18.0, roadD);
            let patchF = smoothstep(0.3, 0.55, fbm2(world * 0.06 + 31.0, 3));
      let pf = flowers * patchF * max(band, 0.3) * smoothstep(halfW + 0.8, halfW + 1.8, roadD);
            if (rand01(pcg(h0 + 23u)) < pf * 0.9) {
        plant = true;
        kind = 5.0;
                height = 0.8 + 0.4 * rand01(pcg(h0 + 24u));
        bend = 0.0;
        dens = 1.0;
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
    b.height = height * grow;
        b.width = (0.012 + 0.012 * rand01(pcg(h0 + 19u))) * widen * grow;
    if (plant) { b.width = height * 0.28 * grow; } // billboard half width
    b.rot = rand01(pcg(h0 + 20u)) * 6.2831;
    b.bendMix = pack4x8unorm(vec4f(bend, grassMix(world), 0.0));
    b.kindTint = kind * 10.0 + tint;
    // Geometry LOD switches per blade somewhere in 26-36 m (spread out).
    if (dist < 26.0 + 10.0 * rand01(pcg(h0 + 21u))) {
      let slot = atomicAdd(&gargs[1], 1u);
      if (slot < GP.capNear) { bladesNear[slot] = b; }
    } else {
      let slot = atomicAdd(&gargs[5], 1u);
      if (slot < GP.capFar) { bladesFar[slot] = b; }
    }
  }
}

// Mix weights of the base colour (it matches the terrain's grass): computed
// once per blade here rather than per fragment (it varies over tens of m).
fn grassMix(world2: vec2f) -> vec2f {
  let macroN = fbm2(world2 * 0.0025, 4);
  let mid = fbm2(world2 * 0.03, 4);
  return vec2f(saturate(macroN * 1.8 - 0.4), saturate(mid * 2.2 - 1.1) * 0.6);
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
  @location(5) @interpolate(flat) colMix: vec2f,
};

// Flowering plant: a camera-facing billboard in rows (t = 0 .. 1), the
// plant itself drawn in the fragment shader (fsPlant) and cut out.
fn plantVertex(b: Blade, vi: u32, segments: u32) -> GOut {
  let rows = select(2u, 3u, segments >= 3u);
  var r = min(vi / 2u, rows - 1u);
  var side = select(-1.0, 1.0, (vi & 1u) == 1u);
  if (vi >= rows * 2u) { r = rows - 1u; side = 1.0; }
  let t = f32(r) / f32(rows - 1u);
  let toCam = F.cam.xyz - b.pos;
  let across = normalize(vec3f(toCam.z, 0.0, -toCam.x) + vec3f(1e-4, 0.0, 0.0));
  var p = b.pos + vec3f(0.0, t * b.height, 0.0) + across * side * b.width;
  p += windOffset(p, t * t * 1.2, fract(b.rot)) * b.height;
  var o: GOut;
  o.world = p;
  o.pos = F.viewProj * vec4f(p, 1.0);
  o.normal = normalize(vec3f(toCam.x, 0.0, toCam.z) * 0.35 / max(length(toCam.xz), 0.01) + vec3f(0.0, 1.0, 0.0));
  o.t = t;
  o.kindTint = b.kindTint;
  o.side = side;
  return o;
}

fn bladeVertex(b: Blade, vi: u32, segments: u32) -> GOut {
  if (floor(b.kindTint / 10.0) == 5.0) { return plantVertex(b, vi, segments); }
  let bm = unpack4x8unorm(b.bendMix);
  let bend = bm.x;
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
  var p = b.pos + vec3f(0.0, t * b.height, 0.0) + facing * (bend * t * t * b.height) + across * side * w;
  let wind = windOffset(p, t * t * 1.6, fract(b.rot)) ;
  p += wind * b.height;
  var o: GOut;
  o.world = p;
  o.pos = F.viewProj * vec4f(p, 1.0);
  // Normal: blade facing, rounded across, blended toward up.
  let bn = normalize(facing + across * side * 0.6 - vec3f(0.0, bend * t, 0.0));
  o.normal = normalize(mix(bn, vec3f(0.0, 1.0, 0.0), 0.55));
  o.t = t;
  o.kindTint = b.kindTint;
  o.side = side;
  o.colMix = bm.yz;
  return o;
}

@vertex
fn vsNear(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  return bladeVertex(blades[ii], vi, 3u);
}

@vertex
fn vsFar(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  // Two segments (5 verts): close enough in shape to the 3-segment near
  // blades that the switch is invisible.
  return bladeVertex(blades[ii], vi, 2u);
}

// The flowering plant on its billboard: X across (plant heights), Y up.
// Returns rgb and coverage (0 = cut out).
fn plantShape(X: f32, Y: f32, tv: f32) -> vec4f {
  let green = vec3f(0.09, 0.22, 0.05);
  var col = vec3f(0.0);
  var cov = 0.0;
  // Stem with a slight curve.
  let sx = 0.025 * sin(Y * 4.0 + tv * 20.0);
    if (abs(X - sx) < 0.008 && Y < 0.9) { col = green * 0.8; cov = 1.0; }
  // Short stalks from the stem to the side heads.
  if (Y > 0.78 && Y < 0.9 && abs(X - sx) < 0.2 * (Y - 0.78) / 0.12 && abs(abs(X - sx) - 1.4 * (Y - 0.78)) < 0.006) {
    col = green * 0.8;
    cov = 1.0;
  }
  // Leaves: lanceolate, from the stem outward and up.
  for (var i = 0; i < 3; i++) {
    let fi = f32(i);
    let s = select(-1.0, 1.0, ((i + i32(tv * 7.0)) & 1) == 1);
    let a = vec2f(sx, 0.12 + 0.2 * fi);
    let b = a + vec2f(s * (0.2 - 0.04 * fi), 0.16);
    let ab = b - a;
    let u = saturate(dot(vec2f(X, Y) - a, ab) / dot(ab, ab));
    let d = length(vec2f(X, Y) - (a + ab * u));
    if (d < 0.028 * sin(3.14159 * u) + 0.002) { col = green * (0.9 + 0.3 * u); cov = 1.0; }
  }
  // Blossoms near the top: 1-3 five-petal heads.
    let heads = 2 + i32(tv * 3.99);
  for (var k = 0; k < heads; k++) {
    let fk = f32(k);
        // Spread across the top in a loose dome.
    let off = fk - f32(heads - 1) * 0.5;
    let c = vec2f(sx + off * 0.085, 0.9 - 0.035 * off * off + 0.02 * fract(tv * 7.0 + fk * 0.53));
    let d = vec2f(X, Y) - c;
    let r = length(d);
        let R = 0.07 + 0.025 * fract(tv * 13.0 + fk * 0.37);
    let ang = atan2(d.y, d.x) + tv * 6.0 + fk;
    let petal = R * (0.55 + 0.45 * abs(cos(2.5 * ang)));
    if (r < petal) {
      // Petal colour: the biome's flower colour, white, violet or pink.
      let h = fract(tv * 3.7 + fk * 0.21);
      var pc = pal(7);
      if (h > 0.55) { pc = vec3f(0.92, 0.92, 0.95); }
      if (h > 0.75) { pc = vec3f(0.55, 0.25, 0.8); }
      if (h > 0.9) { pc = vec3f(0.95, 0.4, 0.6); }
      col = mix(pc * 0.8, pc, r / max(petal, 1e-4));
      if (r < R * 0.28) { col = vec3f(0.85, 0.65, 0.1); }
      cov = 1.0;
    }
  }
  return vec4f(col, cov);
}

@fragment
fn fs(in: GOut, @builtin(front_facing) ff: bool) -> GBufferOut {
  let kind = floor(in.kindTint / 10.0);
  let tv = fract(in.kindTint);
  if (kind == 5.0) {
    let ps = plantShape(in.side * 0.28, in.t, tv);
    if (ps.a < 0.5) { discard; }
    var s: Surface;
    s.albedo = ps.rgb;
    s.n = normalize(in.normal);
    s.rough = 0.6;
    s.metal = 0.0;
    s.ao = mix(0.5, 1.0, in.t);
    s.spec = 0.3;
    s.sss = 0.6;
    let sh = sunShadow(in.world, s.n) * cloudShadow(in.world);
    var c = shadeSurface(s, in.world, sh);
    c = finishColor(c, in.world);
    return gbuffer(c, in.world, in.world, s.n, 0.6);
  }
  // Base color matches the terrain's grass.
  var col = mix(pal(0), pal(1), in.colMix.x);
  col = mix(col, pal(2), in.colMix.y);
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
