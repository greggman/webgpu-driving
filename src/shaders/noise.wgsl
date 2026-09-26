// Twin of src/math/noise.ts — keep in sync.

fn pcg(x: u32) -> u32 {
  let v = x * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}

fn hash2i(ix: i32, iy: i32) -> u32 {
  return pcg(bitcast<u32>(ix) + pcg(bitcast<u32>(iy)));
}

fn hash01(ix: i32, iy: i32) -> f32 {
  return f32(hash2i(ix, iy)) * (1.0 / 4294967296.0);
}

fn hash3u(a: u32, b: u32, c: u32) -> u32 {
  return pcg(a + pcg(b + pcg(c)));
}

fn rand01(h: u32) -> f32 {
  return f32(h) * (1.0 / 4294967296.0);
}

fn grad2(ix: i32, iy: i32) -> vec2f {
  let a = hash01(ix, iy) * 6.283185307;
  return vec2f(cos(a), sin(a));
}

// Gradient noise with analytic derivatives: returns (value, d/dx, d/dy).
fn noised(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = p - i;
  let ix = i32(i.x);
  let iy = i32(i.y);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let ga = grad2(ix, iy);
  let gb = grad2(ix + 1, iy);
  let gc = grad2(ix, iy + 1);
  let gd = grad2(ix + 1, iy + 1);
  let va = dot(ga, f);
  let vb = dot(gb, f - vec2f(1.0, 0.0));
  let vc = dot(gc, f - vec2f(0.0, 1.0));
  let vd = dot(gd, f - vec2f(1.0, 1.0));
  let k = va - vb - vc + vd;
  let v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  let d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
    + du * (u.yx * k + vec2f(vb - va, vc - va));
  return vec3f(v, d);
}

fn noise2(p: vec2f) -> f32 {
  return noised(p).x;
}

// Cheap value noise (not CPU-mirrored) for shading detail.
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let ix = i32(i.x);
  let iy = i32(i.y);
  let a = hash01(ix, iy);
  let b = hash01(ix + 1, iy);
  let c = hash01(ix, iy + 1);
  let d = hash01(ix + 1, iy + 1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm2(p0: vec2f, octaves: i32) -> f32 {
  var p = p0;
  var a = 0.0;
  var b = 0.5;
  for (var i = 0; i < octaves; i++) {
    a += b * vnoise(p);
    b *= 0.5;
    p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p;
  }
  return a;
}

fn vnoise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let ix = bitcast<u32>(i32(i.x));
  let iy = bitcast<u32>(i32(i.y));
  let iz = bitcast<u32>(i32(i.z));
  let n000 = rand01(hash3u(ix, iy, iz));
  let n100 = rand01(hash3u(ix + 1u, iy, iz));
  let n010 = rand01(hash3u(ix, iy + 1u, iz));
  let n110 = rand01(hash3u(ix + 1u, iy + 1u, iz));
  let n001 = rand01(hash3u(ix, iy, iz + 1u));
  let n101 = rand01(hash3u(ix + 1u, iy, iz + 1u));
  let n011 = rand01(hash3u(ix, iy + 1u, iz + 1u));
  let n111 = rand01(hash3u(ix + 1u, iy + 1u, iz + 1u));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}
