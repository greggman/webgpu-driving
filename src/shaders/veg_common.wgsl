// Shared vegetation definitions.

struct Inst {
  pos: vec3f,
  scale: f32,
  rot: f32,
  tint: f32,
  fade: f32,  // > 0: fading in (keep if hash < fade), < 0: fading out
  mesh: u32,
};

struct MeshInfo {
  radius: f32,
  centerY: f32,
  height: f32,
  kind: f32,
  baseR: f32, // trunk radius at the ground (trees only, else 0)
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

struct DrawInfo {
  base: u32,
  mesh: u32,
  lod: u32,
  pad: u32,
};

const OCT_N = 8.0;

fn hemiOctEncode(d0: vec3f) -> vec2f {
  let d = vec3f(d0.x, max(d0.y, 0.0), d0.z);
  let l1 = abs(d.x) + abs(d.y) + abs(d.z);
  let dd = d / max(l1, 1e-5);
  let e = vec2f(dd.x + dd.z, dd.x - dd.z);
  return e * 0.5 + 0.5;
}

fn hemiOctDecode(uv: vec2f) -> vec3f {
  let e = uv * 2.0 - 1.0;
  let p = vec2f(e.x + e.y, e.x - e.y) * 0.5;
  return normalize(vec3f(p.x, 1.0 - abs(p.x) - abs(p.y), p.y));
}

fn rotY(v: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

// Wind sway: global gusts + per-instance phase; displacement grows with the
// vertex wind weight.
fn windOffset(worldPos: vec3f, weight: f32, phase: f32) -> vec3f {
  let t = F.cam.w;
  let wdir = normalize(F.weather.xy + vec2f(1e-4, 0.0));
  let strength = length(F.weather.xy);
  let wp = worldPos.xz + F.misc.xy;
  let gust = 0.5 + 0.5 * sin(dot(wp, wdir) * 0.02 - t * 1.3) * sin(t * 0.37 + wp.x * 0.004);
  let sway = sin(t * 1.7 + phase * 6.28) * 0.35 + gust;
  let flutter = sin(t * 7.0 + phase * 40.0 + worldPos.y * 3.0) * 0.08;
  let d = (sway * strength * 0.5 + flutter * strength) * weight;
  return vec3f(wdir.x * d, -abs(d) * 0.15, wdir.y * d);
}

// Leaf cluster lookup in card UV space from the baked leaf-card texture
// (group-0 binding 11, see leafgen.wgsl): returns (alpha, per-leaf shade).
// Alpha is sharpened by its screen-space derivative so the cutout stays crisp
// and keeps its coverage at distance.
// duv = fwidth(uv) computed by the caller in uniform control flow.
fn leafAlpha(uv: vec2f, mat: u32, seed: f32, duv: vec2f, erode: f32) -> vec2f {
  let variant = vec2f(floor(fract(seed * 7.13) * 2.0), floor(fract(seed * 3.71) * 2.0));
  let tuv = (clamp(uv, vec2f(0.01), vec2f(0.99)) + variant) * 0.5;
  let layer = select(0, 1, mat == 2u);
  let lod = clamp(log2(max(max(duv.x, duv.y) * 256.0, 1e-4)), 0.0, 6.0);
  let t = textureSampleLevel(matTex, linSampler, tuv, layer, lod);
  // Lower the cutout threshold at coarse mips to preserve coverage.
  let thr = mix(mix(0.5, 0.28, saturate(lod / 4.0)), 1.01, erode);
  return vec2f(select(0.0, 1.0, t.r > thr), t.g);
}

struct VegMat {
  albedo: vec3f,
  rough: f32,
  sss: f32,
  spec: f32,
};

// Autumn (F.palette[6].w): broadleaf foliage turns red / orange / gold /
// yellow per tree (a few stay green), keeping the baked shading.
fn autumnColor(h: f32) -> vec3f {
  let k = u32(h * 7.0);
  switch k {
    case 0u: { return vec3f(0.45, 0.05, 0.03); }
    case 1u: { return vec3f(0.62, 0.15, 0.03); }
    case 2u: { return vec3f(0.72, 0.3, 0.04); }
    case 3u: { return vec3f(0.72, 0.46, 0.06); }
    case 4u: { return vec3f(0.66, 0.56, 0.1); }
    case 5u: { return vec3f(0.55, 0.1, 0.05); }
    default: { return vec3f(0.22, 0.3, 0.07); }
  }
}

fn autumnize(c: vec3f, tint: f32) -> vec3f {
  let a = F.palette[6].w;
  if (a <= 0.0 || tint < 0.0) { return c; }
  let lum = dot(c, vec3f(0.3, 0.59, 0.11));
  let base = max(dot(pal(6), vec3f(0.3, 0.59, 0.11)), 0.01);
  let col = autumnColor(fract(tint * 7.31)) * (lum / base) * 0.85;
  return mix(c, col, a);
}

// tint < 0: neutral (impostor bake; the autumn recolour is applied when the
// impostor is drawn).
fn vegMaterial(mat: u32, uv: vec2f, tintIn: f32, localPos: vec3f) -> VegMat {
  let tint = select(tintIn, 0.5, tintIn < 0.0);
  var m: VegMat;
  m.rough = 0.8;
  m.sss = 0.0;
  m.spec = 0.5;
  let foliage = pal(6);
  let t = tint - 0.5;
  if (mat == 1u || mat == 2u) {
    var c = foliage * (0.85 + 0.5 * t);
        c = mix(c, c * vec3f(1.25, 1.15, 0.6), saturate(t * 1.5));   // yellowish variation
    if (mat == 1u) { c = autumnize(c, tintIn); }
    m.albedo = c;
    m.rough = 0.82;
    m.spec = 0.35;
    m.sss = 0.6;
    if (mat == 2u) {
      m.albedo = c * vec3f(0.62, 0.78, 0.72);
      m.sss = 0.3;
    }
  } else if (mat == 7u) {
    m.albedo = vec3f(0.35, 0.22, 0.1);
    m.sss = 0.3;
  } else if (mat == 3u) {
    let n = fbm2(localPos.xz * 3.0 + localPos.y * 2.0, 3);
    m.albedo = pal(4) * (0.7 + 0.5 * n) * (0.9 + 0.2 * t);
    m.rough = 0.85;
  } else if (mat == 4u) {
    // Saguaro ribs: stripes around the circumference.
    let rib = 0.75 + 0.25 * abs(sin(uv.x * 3.14159 * 12.0));
    m.albedo = vec3f(0.2, 0.3, 0.12) * rib * (0.9 + 0.3 * t);
    m.rough = 0.6;
  } else if (mat == 5u) {
    // Birch: white with dark lenticels.
    let marks = step(0.82, vnoise(vec2f(uv.x * 6.0, uv.y * 3.0) + localPos.y));
    m.albedo = mix(vec3f(0.78, 0.76, 0.7), vec3f(0.08), marks);
    m.rough = 0.7;
  } else if (mat == 6u) {
    let g = 0.75 + 0.25 * abs(sin(uv.x * 40.0 + vnoise(uv * vec2f(4.0, 20.0)) * 3.0));
    m.albedo = vec3f(0.35, 0.16, 0.09) * g;
  } else {
    let g = 0.7 + 0.3 * abs(sin(uv.x * 30.0 + vnoise(uv * vec2f(4.0, 12.0)) * 4.0));
    m.albedo = vec3f(0.16, 0.12, 0.09) * g;
  }
  // Snow on top surfaces.
  return m;
}

// Stable per-pixel dither for LOD cross-fades (changes per frame for TAA).
// Interleaved gradient noise, advanced by the golden ratio every frame: over
// consecutive frames each pixel's threshold sweeps [0,1) evenly, so TAA's
// temporal average of a dithered cross-fade equals the fade amount (this is
// how Unreal/Unity-style dithered LOD transitions coexist with TAA).
fn ditherHash(px: vec2f) -> f32 {
  let ign = fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715))));
  return fract(ign + F.misc2.z * 0.61803399);
}

// Wind weight / per-card random decoded from the vertex wind slot (see
// MeshBuilder.card: cards store 2 + level + rand).
fn windWeight(w: f32) -> f32 {
  return select(w, floor(w - 2.0) / 15.0, w >= 2.0);
}
fn cardRand(w: f32) -> f32 {
  return select(-1.0, fract(w - 2.0), w >= 2.0);
}

// Instance mesh index (low 8 bits) and LOD0 morph amount (high bits).
fn instMesh(m: u32) -> u32 { return m & 0xffu; }
fn instMorph(m: u32) -> f32 { return f32((m >> 8u) & 0xffu) / 255.0; }

// Canopy lean (see veg_scatter): bits 16-23 of Inst.mesh are the lean at the
// top of the tree in 1/20 m, bits 24-31 its direction. Returns the
// horizontal offset of a point at height y on a tree of height h (the trunk
// stays put at the base and curves over).
fn instLeaning(m: u32) -> bool { return (m >> 16u) != 0u; }
fn instLean(m: u32, y: f32, h: f32) -> vec3f {
  let amt = f32((m >> 16u) & 0xffu) / 20.0;
  let a = f32(m >> 24u) / 256.0 * 6.2831853;
  let t = saturate(y / max(h, 0.01));
  return vec3f(cos(a), 0.0, sin(a)) * amt * t * t;
}

// Alpha erosion for LOD morphing: cards beyond the simpler LOD's card count
// dissolve as the tree approaches its switch distance.
fn cardErode(rand: f32, morph: f32) -> f32 {
  if (rand < 0.0 || morph <= 0.0) { return 0.0; }
  let keep = 1.0 - 0.5 * morph;
  return saturate((rand - keep) / 0.12);
}

fn fadeDiscard(fade: f32, px: vec2f) -> bool {
  let h = ditherHash(px);
  if (fade > 0.0) { return h > fade; }
  if (fade < 0.0) { return h < -fade; }
  return false;
}
