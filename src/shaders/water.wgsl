// Ocean surface from the FFT cascades (see ocean_fft.wgsl): a camera-centred
// polar grid displaced by the (band-limited, mip-selected) displacement maps;
// per-pixel normals from the slope maps, with the slope variance stored in
// their mips (E[s²] - E[s]²) turned into roughness so distant water is a
// correctly blurred reflection instead of sparkling noise.
//
// Shading: Fresnel reflection of the prefiltered environment map (sky +
// clouds), energy-clamped sun glint, a subsurface-scattering term (light
// through thin, back-lit crests and the upward-facing body — what reads as
// "water" from high angles), depth absorption over the seabed near shore,
// and foam from the displacement Jacobian (breaking crests) and shoreline.

@group(1) @binding(0) var disp0: texture_2d<f32>;
@group(1) @binding(1) var slope0: texture_2d<f32>;
@group(1) @binding(2) var disp1: texture_2d<f32>;
@group(1) @binding(3) var slope1: texture_2d<f32>;
@group(1) @binding(4) var<uniform> OC: vec4f; // size0, size1, N, -

struct WVOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) flat_: vec2f,
  @location(2) prevWorld: vec3f,
  @location(3) height: f32,
};

const RINGS = 110u;
const SEGS = 160u;

fn sampleDisp(p: vec2f, spacing: f32) -> vec3f {
  // Mip whose texel covers about half the local vertex spacing.
  let l0 = clamp(log2(max(spacing * 2.0 / (OC.x / OC.z), 1.0)), 0.0, 8.0);
  let l1 = clamp(log2(max(spacing * 2.0 / (OC.y / OC.z), 1.0)), 0.0, 8.0);
  var d = textureSampleLevel(disp0, repSampler, p / OC.x, l0).xyz;
  d += textureSampleLevel(disp1, repSampler, p / OC.y, l1).xyz * saturate(2.0 - spacing);
  return d;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> WVOut {
  let quad = vi / 6u;
  let corner = vi % 6u;
  let offs = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u));
  let r = quad / SEGS + offs[corner].x;
  let sgi = quad % SEGS + offs[corner].y;
  let radius = select(0.0, 0.6 * pow(1.1, f32(r)), r > 0u);
  let ang = f32(sgi) / f32(SEGS) * 6.2831853;
  let center = floor(F.cam.xz);
  let p = center + vec2f(cos(ang), sin(ang)) * radius;
  let spacing = max(radius * 0.1, 0.06);
  let wp = p + F.misc.xy;
  // Fade the waves out toward the far horizon (they're sub-pixel there).
  let fade = saturate(1.0 - radius / 6000.0);
  let d = sampleDisp(wp, spacing) * fade;
  var o: WVOut;
  let world = vec3f(p.x + d.x, d.y, p.y + d.z);
  o.world = world;
  o.flat_ = p;
  // The wave field changes slowly; treat the surface as static for motion
  // vectors (camera motion still produces correct velocities).
  o.prevWorld = world;
  o.height = d.y;
  o.pos = F.viewProj * vec4f(world, 1.0);
  return o;
}

@fragment
fn fs(in: WVOut) -> GBufferOut {
  let wp2 = in.flat_ + F.misc.xy;
  // Implicit-derivative sampling (uniform control flow): the hardware picks
  // the mip for this pixel's footprint.
  let s0 = textureSample(slope0, repSampler, wp2 / OC.x);
  let s1 = textureSample(slope1, repSampler, wp2 / OC.y);
  let wp = in.world;
  let dist = distance(wp, F.cam.xyz);
  let slope = s0.xy + s1.xy;
  let variance = max(s0.z - dot(s0.xy, s0.xy), 0.0) + max(s1.z - dot(s1.xy, s1.xy), 0.0);
  let n0 = normalize(vec3f(-slope.x, 1.0, -slope.y));
  // Very far away the surface is effectively flat and rough.
  let n = normalize(mix(n0, vec3f(0.0, 1.0, 0.0), saturate(dist / 8000.0)));
  let rough = clamp(sqrt(0.02 * 0.02 + variance * 0.5 + dist * 1e-5), 0.02, 0.6);
  let v = normalize(F.cam.xyz - wp);
  var nv = dot(n, v);
  var nn = n;
  if (nv < 0.01) { nn = normalize(n + v * (0.01 - nv)); nv = 0.01; }

  // Depth to the seabed (terrain clipmap).
  let lvl = clamp(i32(log2(max(dist * 0.004, 0.5) / 0.5)), 0, CLIP_LEVELS - 1);
  let ground = clipSample(wp.xz, lvl).x;
  let depth = max(wp.y - ground, 0.0);

  let l = F.sun.xyz;
  let sunC = F.sunColor.rgb * cloudShadow(wp);
  let amb = shIrradiance(vec3f(0.0, 1.0, 0.0));

  // Reflection.
  let fres = 0.02 + 0.98 * pow(1.0 - saturate(nv), 5.0);
  var r = reflect(-v, nn);
  r.y = abs(r.y);
  var refl = envRadiance(r, rough);
  let h = normalize(v + l);
  let spec = min(D_GGX(saturate(dot(nn, h)), rough * rough) * V_SmithGGX(nv, saturate(dot(nn, l)), rough * rough) * 4.0, 80.0);
  refl += sunC * spec * F.sun.w * saturate(dot(nn, l) * 4.0);

  // Subsurface scattering / body colour.
  let sssCol = vec3f(0.05, 0.3, 0.32);
  let deep = vec3f(0.006, 0.035, 0.06);
  let crest = saturate(in.height * 0.6 + 0.35);
  let back = pow(saturate(dot(l, -v)), 4.0) * pow(saturate(0.5 - 0.5 * dot(l, nn)), 3.0);
  var body = deep * (amb * 2.5 + sunC * saturate(l.y) * 0.08);
  body += sssCol * sunC * (crest * back * 1.5 + 0.02 * saturate(dot(nn, l)));
  body += sssCol * amb * pow(saturate(nv), 2.0) * 0.12;
  // Shallow water over sand near the shore.
  let absorb = exp(-depth * vec3f(0.45, 0.1, 0.07));
  let seabed = pal(5) * (amb + sunC * saturate(l.y) / PI) * 0.7;
  body = mix(body, seabed, absorb * 0.85);

  var col = mix(body, refl, fres);

  // Foam: breaking crests (Jacobian < ~0.5) and the shoreline.
  let jac = min(s0.w, s1.w * 0.5 + 0.5);
  let fn1 = vnoise(wp2 * 0.4 + vec2f(F.cam.w * 0.15, 0.0)) * 0.6 + vnoise(wp2 * 1.7) * 0.4;
  let caps = smoothstep(0.55, 0.15, jac + fn1 * 0.25) * saturate(1.0 - dist / 1500.0);
  let shore = saturate(1.0 - depth / 1.3) * smoothstep(0.3, 0.7, fn1 + 0.25 * sin(depth * 4.0 - F.cam.w * 1.5));
  let foam = saturate(caps * 0.8 + shore);
  let foamCol = vec3f(0.85) * (amb + sunC * saturate(dot(nn, l)) / PI * 1.2);
  col = mix(col, foamCol, foam);
  col = finishColor(col, wp);
  return gbuffer(col, wp, in.prevWorld, nn, rough);
}
