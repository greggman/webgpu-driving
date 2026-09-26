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
fn leafAlpha(uv: vec2f, mat: u32, seed: f32, duv: vec2f) -> vec2f {
  let variant = vec2f(floor(fract(seed * 7.13) * 2.0), floor(fract(seed * 3.71) * 2.0));
  let tuv = (clamp(uv, vec2f(0.01), vec2f(0.99)) + variant) * 0.5;
  let layer = select(0, 1, mat == 2u);
  let lod = clamp(log2(max(max(duv.x, duv.y) * 256.0, 1e-4)), 0.0, 6.0);
  let t = textureSampleLevel(matTex, linSampler, tuv, layer, lod);
  // Lower the cutout threshold at coarse mips to preserve coverage.
  let thr = mix(0.5, 0.28, saturate(lod / 4.0));
  return vec2f(select(0.0, 1.0, t.r > thr), t.g);
}

struct VegMat {
  albedo: vec3f,
  rough: f32,
  sss: f32,
  spec: f32,
};

fn vegMaterial(mat: u32, uv: vec2f, tint: f32, localPos: vec3f) -> VegMat {
  var m: VegMat;
  m.rough = 0.8;
  m.sss = 0.0;
  m.spec = 0.5;
  let foliage = pal(6);
  let t = tint - 0.5;
  if (mat == 1u || mat == 2u) {
    var c = foliage * (0.85 + 0.5 * t);
    c = mix(c, c * vec3f(1.25, 1.15, 0.6), saturate(t * 1.5));   // yellowish variation
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
fn ditherHash(px: vec2f) -> f32 {
  let f = F.misc2.z;
  return fract(52.9829189 * fract(dot(px + f * vec2f(5.588, 3.219), vec2f(0.06711056, 0.00583715))));
}

fn fadeDiscard(fade: f32, px: vec2f) -> bool {
  let h = ditherHash(px);
  if (fade > 0.0) { return h > fade; }
  if (fade < 0.0) { return h < -fade; }
  return false;
}
