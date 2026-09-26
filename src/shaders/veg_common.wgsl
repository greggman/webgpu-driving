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

// Procedural leaf cluster in card UV space: returns (alpha, per-leaf shade).
fn leafAlpha(uv: vec2f, mat: u32, seed: f32) -> vec2f {
  let p = uv * 2.0 - 1.0;
  let sd = i32(seed * 997.0);
  if (mat == 2u) {
    // Needle spray: thin strokes along the card, clumped into tufts.
    let g = uv * vec2f(7.0, 3.0);
    let ci = floor(g);
    var a = 0.0;
    var shade = 1.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let c = ci + vec2f(f32(x), f32(y));
        let h = hash01(i32(c.x) + sd, i32(c.y) * 7 + 1);
        let h2 = hash01(i32(c.x) * 5 + 3, i32(c.y) + sd);
        let q = g - c - vec2f(h, h2);
        let ang = (h - 0.5) * 0.9;
        let rq = vec2f(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
        let e = abs(rq.x) * 14.0 + max(abs(rq.y) - 0.45, 0.0) * 6.0;
        if (1.0 - e > a) { a = 1.0 - e; shade = 0.8 + 0.4 * h2; }
      }
    }
    // Elongated spray with a ragged fringe (not a disc).
    let fringe = 0.25 * vnoise(uv * vec2f(9.0, 5.0) + seed * 7.0);
    let body = 1.0 - smoothstep(0.55, 0.95, length(p * vec2f(1.7, 1.0)) + fringe);
    return vec2f(step(0.0, a) * step(0.35, body), shade);
  }
  // Broadleaf: cellular scatter of small rotated leaves.
  let g = uv * 5.0;
  let ci = floor(g);
  var a = 0.0;
  var shade = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = ci + vec2f(f32(x), f32(y));
      let h = hash01(i32(c.x) + sd, i32(c.y) + 17);
      let h2 = hash01(i32(c.x) + 31, i32(c.y) + sd);
      let center = c + vec2f(0.2 + 0.6 * h, 0.2 + 0.6 * h2);
      // Keep leaves inside a rounded cluster.
      let cuv = center / 5.0 * 2.0 - 1.0;
      if (length(cuv) > 0.95) { continue; }
      let q = g - center;
      let ang = h * 6.2831 + h2 * 2.0;
      let rq = vec2f(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
      // Pointed leaf shape.
      let w = 0.36 * (1.0 - abs(rq.y) / 0.62);
      let e = abs(rq.x) / max(w, 1e-3);
      if (abs(rq.y) < 0.62 && e < 1.0) {
        a = 1.0;
        shade = 0.72 + 0.5 * fract(h * 13.7 + h2 * 5.3) - 0.12 * e;
      }
    }
  }
  return vec2f(a, shade);
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
    if (mat == 2u) { c *= vec3f(0.7, 0.85, 0.8); }
    m.albedo = c;
    m.rough = 0.65;
    m.sss = 0.6;
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
