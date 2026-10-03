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
    // Rugged coasts (tp(28) > 0): coves and headlands along the shore.
    let o = tp(13) + 50.0 * noised(vec2f(p.y * 0.004, 3.1)).x
      + tp(28) * noised(vec2f(p.y * 0.013, 7.7)).x;
    let sd = d * tp(12) - o;
    let t = smoothstep(-tp(15), tp(15) * 0.3, sd);
    let beach = tp(14) + 6.0 * noised(p * 0.01).x;
    h = mix(h, beach, t);
    if (tp(28) > 0.0) {
      // Gullies and buttresses down the cliff face.
      let face = t * (1.0 - t) * 4.0;
      let g = 1.0 - abs(noised(p * 0.045).x) * 1.6;
      h += tp(28) * 0.45 * face * g;
    }
    if (tp(29) > 0.0) {
      // Sea stacks and rock shelves off the cliff foot.
      let off = sd - tp(15) * 0.3;
      if (off > 0.0 && off < tp(29)) {
                let n = noised(vec2f(p.x * 0.06 + 5.3, p.y * 0.06)).x;
        let k = smoothstep(0.42, 0.52, n) * (1.0 - off / tp(29));
        let top = 3.0 + 30.0 * smoothstep(-0.4, 0.8, noised(p * 0.05).x);
        h = mix(h, top, k);
      }
    }
  }
  return h;
}

fn sminf(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Tunnel bore (CPU twins in road.ts): walls TUNNEL_SIDE beyond the paved
// half width, TUNNEL_WALL high, under an elliptical vault with its crown
// TUNNEL_H above the road. Past a portal the hill rises back from the cut
// over TUNNEL_RAMP m (CPU twin in terrain.ts).
const TUNNEL_SIDE = 1.2;
const TUNNEL_WALL = 3.5;
const TUNNEL_H = 7.0;
const TUNNEL_RAMP = 8.0;

fn boreHalfWidth() -> f32 { return F.road.w + TUNNEL_SIDE; }

// Height of the bore's lining above the road at lateral offset d.
fn tunnelRoof(d: f32) -> f32 {
  let u = min(abs(d) / boreHalfWidth(), 1.0);
  return TUNNEL_WALL + (TUNNEL_H - TUNNEL_WALL) * sqrt(1.0 - u * u);
}

fn roadBlend(natural: f32, d: f32, roadY: f32, bridge: f32, tunnel: f32) -> f32 {
  let tgt = roadY - 0.12;
  let excess = max(abs(d) - tp(20), 0.0);
  let delta = natural - tgt;
  let cutLim = excess * tp(21);
  let fillLim = mix(excess * tp(22), 1e5, bridge);
  let k = clamp(excess * 0.5, 0.001, 2.0);
  let c = sminf(delta, cutLim, k);
  let h = tgt - sminf(-c, fillLim, k);
  return select(h, mix(h, natural, saturate((tunnel - 1.0) / TUNNEL_RAMP)), tunnel > 0.0);
}

// Road samples: texture row of (x_local, y, heading, bridge - tunnel) every
// F.road.y meters starting at local z = F.road.x. w > 0 on a bridge; w < 0
// in a tunnel, where -w = 1 + distance (m) from the nearer portal.
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
  tunnel: f32, // > 0 in a tunnel: 1 + distance (m) from the nearer portal
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
  o.bridge = max(r.w, 0.0);
  o.tunnel = max(-r.w, 0.0);
  o.heading = r.z;
  o.along = z1;
  return o;
}

// Whether p may be inside one of the tunnels near the camera (a cheap test
// before the road lookup).
fn nearTunnel(p: vec3f) -> bool {
  for (var i = 0; i < i32(F.tunnel.x); i++) {
    let t = F.tunnels[i];
    if (p.z > t.x - 4.0 && p.z < t.y + 4.0 && p.y < t.z) { return true; }
  }
  return false;
}

// Inside a tunnel's bore (or within `margin` outside its lining): the
// tunnel depth there (1 + m from the nearer portal), else 0. ri is the
// road info at p.
fn boreDepthAt(p: vec3f, ri: RoadInfo, margin: f32) -> f32 {
  if (ri.tunnel < 1.0) { return 0.0; }
  let h = p.y - ri.y;
  if (abs(ri.d) > boreHalfWidth() + margin || h > tunnelRoof(ri.d) + margin || h < -3.0) {
    return 0.0;
  }
  return ri.tunnel;
}

fn boreDepth(p: vec3f, margin: f32) -> f32 {
  if (!nearTunnel(p)) { return 0.0; }
  return boreDepthAt(p, roadInfo(p.xz), margin);
}

// Full terrain height at a local-space xz position.
fn terrainHeightLocal(p: vec2f) -> f32 {
  let ri = roadInfo(p);
  let wx = p.x + F.misc.x;
  let wz = p.y + F.misc.y;
  let n = naturalHeight(wx, wz, ri.d);
  return roadBlend(n, ri.d, ri.y, ri.bridge, ri.tunnel);
}
