// Water / snow atlas for the player's windows (see src/sim/glassWater.ts):
//   R = drop height (dome; / HMAX), G = snow cover, B = wet trail film
//   (persists, decays). Layout: windshield in the top half, left side
//   windows in the next quarter, right side windows in the last quarter.

struct Panes {
  pane: array<vec4f, 3>, // uMin, uMax, vMax, -
  misc: vec4f,           // trail decay factor, -, -, -
};

@group(0) @binding(0) var<uniform> W: Panes;
@group(0) @binding(1) var prevTex: texture_2d<f32>;

const HMAX = 0.0025; // m (drop height at R = 1)

fn paneRect(p: u32) -> vec4f {
  if (p == 0u) { return vec4f(0.0, 0.0, 1.0, 0.5); }
  if (p == 1u) { return vec4f(0.0, 0.5, 1.0, 0.25); }
  return vec4f(0.0, 0.75, 1.0, 0.25);
}

fn toAtlas(p: u32, uv: vec2f) -> vec2f {
  let pn = W.pane[p];
  let rc = paneRect(p);
  return rc.xy + vec2f((uv.x - pn.x) / (pn.y - pn.x), 1.0 - uv.y / pn.z) * rc.zw;
}

struct FOut {
  @builtin(position) pos: vec4f,
};

@vertex
fn vsDecay(@builtin(vertex_index) vi: u32) -> FOut {
  var o: FOut;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment
fn fsDecay(in: FOut) -> @location(0) vec4f {
  let prev = textureLoad(prevTex, vec2i(in.pos.xy), 0);
  return vec4f(0.0, 0.0, prev.b * W.misc.x, 0.0);
}

// One splat: a drop (dome, stretched along its motion), a snow flake, or a
// trail segment.
struct SIn {
  @location(0) a: vec4f, // pane, kind (0 drop, 1 snow, 2 trail), u0, v0
  @location(1) b: vec4f, // u1, v1 (drop: motion m/s; trail: end), radius / width, seed
};

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) @interpolate(flat) kind: u32,
  @location(2) @interpolate(flat) rs: vec2f, // radius, seed
};

@vertex
fn vsSplat(v: SIn, @builtin(vertex_index) vi: u32) -> SOut {
  let pane = u32(v.a.x + 0.5);
  let kind = u32(v.a.y + 0.5);
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let r = v.b.z;
  var p: vec2f;
  if (kind == 2u) {
    // Segment from (u0, v0) to (u1, v1), width r.
    let a = v.a.zw;
    let b = v.b.xy;
    var dir = b - a;
    let len = length(dir);
    dir = select(vec2f(1.0, 0.0), dir / max(len, 1e-6), len > 1e-6);
    let n = vec2f(-dir.y, dir.x);
    p = mix(a, b, corner.x * 0.5 + 0.5) + n * corner.y * r;
  } else {
    // Drop / flake: stretched along its motion.
    let m = v.b.xy;
    let sp = length(m);
    let dir = select(vec2f(1.0, 0.0), m / max(sp, 1e-6), sp > 1e-5);
    let n = vec2f(-dir.y, dir.x);
    let e = 1.0 + min(sp * 8.0, 1.2);
    p = v.a.zw + dir * corner.x * r * e * 1.15 + n * corner.y * r * 1.15;
  }
  let t = toAtlas(pane, p);
  var o: SOut;
  o.pos = vec4f(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
  o.q = corner * 1.15;
  o.kind = kind;
  o.rs = vec2f(r, v.b.w);
  return o;
}

@fragment
fn fsSplat(in: SOut) -> @location(0) vec4f {
  if (in.kind == 2u) {
    // Wet trail film, thin at the edges.
    return vec4f(0.0, 0.0, 0.45 * (1.0 - in.q.y * in.q.y / 1.3), 0.0);
  }
  let d2 = dot(in.q, in.q);
  if (in.kind == 1u) {
    // Snow flake / clump: irregular soft edge.
    let a = atan2(in.q.y, in.q.x);
    let edge = 0.75 + 0.25 * sin(a * 5.0 + in.rs.y * 20.0) * sin(a * 3.0 + in.rs.y * 7.0);
    let c = 1.0 - smoothstep(edge * 0.7, edge, sqrt(d2));
    if (c <= 0.0) { discard; }
    return vec4f(0.0, c, 0.0, 0.0);
  }
  if (d2 >= 1.0) { discard; }
  // Flattened dome (drops on glass have a low contact angle).
  let h = sqrt(1.0 - d2) * in.rs.x * 0.55 / HMAX;
  return vec4f(min(h, 1.0), 0.0, 0.2, 0.0);
}
