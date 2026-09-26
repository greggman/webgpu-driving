// Bakes leaf-card textures once: layer 0 = broadleaf clusters, layer 1 =
// needle sprays; 2x2 variants per layer. r = alpha, g = per-leaf shade.
// Also downsamples mip levels.

@group(0) @binding(0) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> gen: vec4u; // layer, size, -, -
@group(0) @binding(2) var srcTex: texture_2d<f32>;

fn hashl(ix: i32, iy: i32) -> f32 {
  return f32(pcg(bitcast<u32>(ix) + pcg(bitcast<u32>(iy)))) * (1.0 / 4294967296.0);
}

fn broadleaf(uv: vec2f, sd: i32) -> vec2f {
  let g = uv * 5.0;
  let ci = floor(g);
  var a = 0.0;
  var shade = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = ci + vec2f(f32(x), f32(y));
      let h = hashl(i32(c.x) + sd, i32(c.y) + 17);
      let h2 = hashl(i32(c.x) + 31, i32(c.y) + sd);
      let center = c + vec2f(0.2 + 0.6 * h, 0.2 + 0.6 * h2);
      let cuv = center / 5.0 * 2.0 - 1.0;
      if (length(cuv) > 0.95) { continue; }
      let q = g - center;
      let ang = h * 6.2831 + h2 * 2.0;
      let rq = vec2f(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
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

fn needles(uv: vec2f, sd: i32) -> vec2f {
  let p = uv * 2.0 - 1.0;
  let g = uv * vec2f(7.0, 3.0);
  let ci = floor(g);
  var a = 0.0;
  var shade = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = ci + vec2f(f32(x), f32(y));
      let h = hashl(i32(c.x) + sd, i32(c.y) * 7 + 1);
      let h2 = hashl(i32(c.x) * 5 + 3, i32(c.y) + sd);
      let q = g - c - vec2f(h, h2);
      let ang = (h - 0.5) * 0.9;
      let rq = vec2f(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
      let e = abs(rq.x) * 14.0 + max(abs(rq.y) - 0.45, 0.0) * 6.0;
      if (1.0 - e > a) { a = 1.0 - e; shade = 0.8 + 0.4 * h2; }
    }
  }
  let fringe = 0.25 * hashl(i32(uv.x * 9.0) + sd, i32(uv.y * 5.0));
  let body = 1.0 - smoothstep(0.55, 0.95, length(p * vec2f(1.7, 1.0)) + fringe);
  return vec2f(step(0.0, a) * step(0.35, body), shade);
}

@compute @workgroup_size(8, 8)
fn bake(@builtin(global_invocation_id) id: vec3u) {
  let size = gen.y;
  if (any(id.xy >= vec2u(size))) { return; }
  let half = size / 2u;
  let variant = vec2u(id.xy / half);
  let local = (vec2f(id.xy % vec2u(half)) + 0.5) / f32(half);
  let sd = i32(variant.x + variant.y * 2u) * 97 + 11;
  // Supersample 4x for smooth edges.
  var acc = vec2f(0.0);
  for (var sy = 0; sy < 2; sy++) {
    for (var sx = 0; sx < 2; sx++) {
      let o = (vec2f(f32(sx), f32(sy)) - 0.5) * 0.5 / f32(half);
      let v = select(broadleaf(local + o, sd), needles(local + o, sd), gen.x == 1u);
      acc += vec2f(v.x, v.y * v.x);
    }
  }
  let a = acc.x / 4.0;
  let shade = select(1.0, acc.y / max(acc.x, 1e-3), acc.x > 0.0);
  textureStore(outTex, id.xy, vec4f(a, shade, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn downsample(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(outTex);
  if (any(id.xy >= dims)) { return; }
  let p = vec2i(id.xy) * 2;
  let s = textureLoad(srcTex, p, 0) + textureLoad(srcTex, p + vec2i(1, 0), 0)
        + textureLoad(srcTex, p + vec2i(0, 1), 0) + textureLoad(srcTex, p + vec2i(1, 1), 0);
  textureStore(outTex, id.xy, s * 0.25);
}
