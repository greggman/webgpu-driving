// Tyre tracks on dirt roads: ribbons following each car's recent path,
// blended over the lit road as a darkening (compressed, damp-looking dirt)
// with a tread pattern.

struct TIn {
  @location(0) pos: vec3f,
  @location(1) uva: vec3f, // across (0..1), along (m), strength
};

struct TOut {
  @builtin(position) pos: vec4f,
  @location(0) uva: vec3f,
  @location(1) world: vec3f,
};

@vertex
fn vs(v: TIn) -> TOut {
  var o: TOut;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.uva = v.uva;
  o.world = v.pos;
  return o;
}

struct TrackOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
  @location(2) normal: vec4f,
};

@fragment
fn fs(in: TOut) -> TrackOut {
  let u = in.uva.x;
  // Soft edges, tread blocks across the width, ridges along it.
  let edge = smoothstep(0.0, 0.18, u) * smoothstep(1.0, 0.82, u);
  let tread = 0.65 + 0.35 * step(0.45, fract(in.uva.y * 7.0 + step(0.5, u) * 0.5));
  let n = 0.75 + 0.25 * vnoise(in.world.xz * 3.0);
  let a = saturate(in.uva.z * 1.5) * edge * tread * n * 0.75;
  var o: TrackOut;
  o.color = vec4f(0.0, 0.0, 0.0, a);
  o.velocity = vec2f(0.0);
  o.normal = vec4f(0.0);
  return o;
}
