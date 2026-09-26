// Terrain height function; twin of src/world/terrain.ts — keep in sync.
// Requires: noise.wgsl, F (Frame uniform) with F.terrain[8] and road data.

fn tp(i: i32) -> f32 {
  return F.terrain[i / 4][i % 4];
}

fn naturalHeight(x: f32, z: f32, d: f32) -> f32 {
  let p = vec2f(x + tp(23), z + tp(24));
  let ad = abs(d);
  var q = p * tp(1);
  var a = 0.0;
  var b = 1.0;
  var dd = vec2f(0.0);
  let oct = i32(tp(2));
  for (var i = 0; i < oct; i++) {
    let n = noised(q);
    dd += n.yz;
    a += b * n.x / (1.0 + dot(dd, dd));
    b *= 0.5;
    q = vec2f(1.6 * q.x - 1.2 * q.y, 1.2 * q.x + 1.6 * q.y);
  }
  var h = tp(3) + tp(0) * a;
  h += tp(10) * noised(p * tp(11)).x;

  if (tp(4) > 0.0) {
    let mf = smoothstep(tp(6), tp(7), ad);
    if (mf > 0.0) {
      var r2 = p * tp(5);
      var r = 0.0;
      var rb = 0.5;
      var prev = 1.0;
      for (var i = 0; i < 6; i++) {
        var n = 1.0 - abs(noised(r2).x) * 1.4;
        n *= n;
        r += n * rb * prev;
        prev = n;
        rb *= 0.5;
        r2 = vec2f(1.6 * r2.x - 1.2 * r2.y, 1.2 * r2.x + 1.6 * r2.y);
      }
      h += tp(4) * mf * r;
    }
  }

  h += tp(25) * smoothstep(0.0, tp(26), ad);

  if (tp(8) > 0.0) {
    let k = h / tp(9);
    let fk = k - floor(k);
    let t = (floor(k) + smoothstep(0.35, 0.65, fk)) * tp(9);
    h = mix(h, t, tp(8));
  }

  if (tp(27) > 0.0) {
    let n = noised(vec2f(p.x * 0.012 + p.y * 0.004, p.y * 0.01)).x;
    h += tp(27) * (1.0 - abs(n) * 1.4);
  }

  if (tp(16) > 0.0) {
    let n = noised(vec2f(p.y * tp(17), p.x * tp(17) * 0.35 + 17.3)).x;
    let c = 1.0 - smoothstep(0.0, tp(18), abs(n));
    h -= tp(16) * c * c;
  }

  if (tp(12) != 0.0) {
    let o = tp(13) + 50.0 * noised(vec2f(p.y * 0.004, 3.1)).x;
    let sd = d * tp(12) - o;
    let t = smoothstep(-tp(15), tp(15) * 0.3, sd);
    let beach = tp(14) + 6.0 * noised(p * 0.01).x;
    h = mix(h, beach, t);
  }
  return h;
}

fn sminf(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn roadBlend(natural: f32, d: f32, roadY: f32, bridge: f32) -> f32 {
  let tgt = roadY - 0.12;
  let excess = max(abs(d) - tp(20), 0.0);
  let delta = natural - tgt;
  let cutLim = excess * tp(21);
  let fillLim = mix(excess * tp(22), 1e5, bridge);
  let k = clamp(excess * 0.5, 0.001, 2.0);
  let c = sminf(delta, cutLim, k);
  return tgt - sminf(-c, fillLim, k);
}

// Road samples: texture row of (x_local, y, heading, bridge) every F.road.y
// meters starting at local z = F.road.x.
fn roadSample(zLocal: f32) -> vec4f {
  let fi = clamp((zLocal - F.road.x) / F.road.y, 0.0, F.road.z - 1.001);
  let i0 = i32(floor(fi));
  let t = fi - f32(i0);
  let a = textureLoad(roadTex, vec2i(i0, 0), 0);
  let b = textureLoad(roadTex, vec2i(i0 + 1, 0), 0);
  return mix(a, b, t);
}

struct RoadInfo {
  d: f32, // signed lateral distance (+ = +x side, i.e. left when driving toward +z)
  y: f32, // road surface height
  bridge: f32,
  heading: f32,
  along: f32, // local z of nearest centerline point
};

// Nearest road point via two Newton steps along the z-parameterized centerline.
fn roadInfo(p: vec2f) -> RoadInfo {
  var z1 = p.y;
  var r = roadSample(z1);
  for (var i = 0; i < 2; i++) {
    let s = sin(r.z);
    let c = cos(r.z);
    let along = (p.x - r.x) * s + (p.y - z1) * c;
    z1 += clamp(along * c, -60.0, 60.0);
    r = roadSample(z1);
  }
  let s = sin(r.z);
  let c = cos(r.z);
  var o: RoadInfo;
  // Lateral vector for heading h (direction (sin h, cos h)) is (cos h, -sin h).
  o.d = (p.x - r.x) * c - (p.y - z1) * s;
  o.y = r.y;
  o.bridge = r.w;
  o.heading = r.z;
  o.along = z1;
  return o;
}

// Full terrain height at a local-space xz position.
fn terrainHeightLocal(p: vec2f) -> f32 {
  let ri = roadInfo(p);
  let wx = p.x + F.misc.x;
  let wz = p.y + F.misc.y;
  let n = naturalHeight(wx, wz, ri.d);
  return roadBlend(n, ri.d, ri.y, ri.bridge);
}
