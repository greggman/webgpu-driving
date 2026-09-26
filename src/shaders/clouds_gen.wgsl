// Generates a tileable 512x512 cloud noise texture once at startup.
// r = billowy base (fbm - worley), g = detail fbm, b = worley.
@group(0) @binding(1) var outTex: texture_storage_2d<rgba8unorm, write>;

fn hashp(p: vec2i, period: i32) -> f32 {
  let q = ((p % period) + period) % period;
  return rand01(pcg(bitcast<u32>(q.x) + pcg(bitcast<u32>(q.y) + 911u)));
}

fn pnoise(p: vec2f, period: i32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hashp(i, period);
  let b = hashp(i + vec2i(1, 0), period);
  let c = hashp(i + vec2i(0, 1), period);
  let d = hashp(i + vec2i(1, 1), period);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn pworley(p: vec2f, period: i32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  var md = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2i(x, y);
      let h = vec2f(hashp(i + o, period), hashp(i + o + vec2i(57, 113), period));
      let d = vec2f(o) + h - f;
      md = min(md, dot(d, d));
    }
  }
  return sqrt(md);
}

fn pfbm(p: vec2f, base: i32, oct: i32) -> f32 {
  var a = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  var period = base;
  for (var i = 0; i < oct; i++) {
    a += amp * pnoise(p * freq, period);
    amp *= 0.5;
    freq *= 2.0;
    period *= 2;
  }
  return a;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(512u))) { return; }
  let uv = (vec2f(id.xy) + 0.5) / 512.0;
  let base = pfbm(uv * 6.0, 6, 6);
  let w = pworley(uv * 8.0, 8) * 0.6 + pworley(uv * 16.0, 16) * 0.4;
  let billow = saturate(base * 1.3 - w * 0.45 + 0.1);
  let detail = pfbm(uv * 24.0, 24, 4);
  textureStore(outTex, id.xy, vec4f(billow, detail, w, 1.0));
}
