// Ocean: camera-centered polar grid displaced by a sum of Gerstner waves
// (amplitudes fade with distance to avoid aliasing), extra high-frequency
// normal detail per pixel, depth-based absorption using the terrain
// clipmap (shallow turquoise over sand, deep blue offshore), Fresnel sky
// reflection, sun glitter, subsurface light in crests, and foam at the
// shoreline and on steep crests.

struct WVOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) crest: f32,
  @location(3) prevWorld: vec3f,
};

const RINGS = 110u;
const SEGS = 160u;
const NWAVES = 14;

fn waveParams(i: i32) -> vec4f {
  // dir angle, wavelength, amplitude, steepness
  let fi = f32(i);
  let L = 95.0 * pow(0.76, fi);
  let ang = (hash01(i * 7 + 1, 3) - 0.5) * 2.0 + (hash01(i, 11) - 0.5) * 0.8;
  let A = L * 0.0065 * (0.7 + 0.6 * hash01(i, 5));
  return vec4f(ang, L, A, 0.6);
}

struct WaveOut {
  disp: vec3f,
  normal: vec3f,
  crest: f32,
};

fn gerstner(p: vec2f, t: f32, fade: f32) -> WaveOut {
  var disp = vec3f(0.0);
  var dx = vec3f(1.0, 0.0, 0.0);
  var dz = vec3f(0.0, 0.0, 1.0);
  var crest = 0.0;
  let windA = atan2(F.weather.y, F.weather.x);
  for (var i = 0; i < NWAVES; i++) {
    let w = waveParams(i);
    let a = w.x + windA;
    let D = vec2f(cos(a), sin(a));
    let k = 6.2831853 / w.y;
    let c = sqrt(9.81 / k);
    let A = w.z * fade;
    let Q = w.w / (k * A * f32(NWAVES) + 1e-4);
    let th = k * dot(D, p) - c * k * t + f32(i) * 1.7;
    let cs = cos(th);
    let sn = sin(th);
    let qa = min(Q * A, 1.0 / (k * f32(NWAVES)));
    disp += vec3f(qa * D.x * cs, A * sn, qa * D.y * cs);
    let wa = k * A;
    dx += vec3f(-qa * D.x * D.x * k * sn, D.x * wa * cs, -qa * D.x * D.y * k * sn);
    dz += vec3f(-qa * D.x * D.y * k * sn, D.y * wa * cs, -qa * D.y * D.y * k * sn);
    crest += max(sn, 0.0) * wa;
  }
  var o: WaveOut;
  o.disp = disp;
  o.normal = normalize(cross(dz, dx));
  o.crest = crest;
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> WVOut {
  // Triangle list over (ring, seg) quads.
  let quad = vi / 6u;
  let corner = vi % 6u;
  let offs = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u));
  let r = quad / SEGS + offs[corner].x;
  let sgi = quad % SEGS + offs[corner].y;
  let radius = select(0.0, 0.6 * pow(1.1, f32(r)), r > 0u);
  let ang = f32(sgi) / f32(SEGS) * 6.2831853;
  let snap = 2.0;
  let center = floor(F.cam.xz / snap) * snap;
  var p = center + vec2f(cos(ang), sin(ang)) * radius;
  let dist = length(p - F.cam.xz);
  let fade = saturate(1.0 - dist / 1500.0);
  let wp = p + F.misc.xy;
  let w = gerstner(wp, F.cam.w, fade);
  let wprev = gerstner(wp, F.cam.w - 1.0 / 60.0, fade);
  var o: WVOut;
  let world = vec3f(p.x + w.disp.x, w.disp.y, p.y + w.disp.z);
  o.world = world;
  o.prevWorld = vec3f(p.x + wprev.disp.x, wprev.disp.y, p.y + wprev.disp.z);
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.normal = w.normal;
  o.crest = w.crest;
  return o;
}

fn detailNormal(p: vec2f, t: f32, dist: f32) -> vec2f {
  // Sum of short capillary/chop waves (slopes only).
  var s = vec2f(0.0);
  let fade = saturate(1.0 - dist / 400.0);
  for (var i = 0; i < 12; i++) {
    let fi = f32(i);
    let a = fi * 2.4 + 0.3 + hash01(i, 77) * 2.0;
    let D = vec2f(cos(a), sin(a));
    let L = 7.0 * pow(0.74, fi);
    let k = 6.2831853 / L;
    let c = sqrt(9.81 / k);
    let th = k * dot(D, p) - c * k * t + fi * 3.1;
    s += D * cos(th) * k * L * 0.011;
  }
  return s * fade;
}

@fragment
fn fs(in: WVOut) -> GBufferOut {
  let wp = in.world;
  let wp2 = wp.xz + F.misc.xy;
  let dist = distance(wp, F.cam.xyz);
  let dn = detailNormal(wp2, F.cam.w, dist);
  var n = normalize(in.normal + vec3f(-dn.x, 0.0, -dn.y));
  // Flatten toward the horizon (sub-pixel waves average out).
  n = normalize(mix(n, vec3f(0.0, 1.0, 0.0), saturate(dist / 6000.0) * 0.8));
  let v = normalize(F.cam.xyz - wp);
  if (dot(n, v) < 0.02) { n = normalize(n + v * (0.02 - dot(n, v))); }
  // Water depth from the terrain clipmap.
  let lvl = clamp(i32(log2(max(dist * 0.004, 0.5) / 0.5)), 0, CLIP_LEVELS - 1);
  let ground = clipSample(wp.xz, lvl).x;
  let depth = max(wp.y - ground, 0.0);
  // Fresnel.
  let nv = saturate(dot(n, v));
  let fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  let r = reflect(-v, n);
  let rr = normalize(vec3f(r.x, abs(r.y), r.z));
  var refl = skyRadiance(rr);
  // Sun glitter.
  let l = F.sun.xyz;
  let h = normalize(v + l);
  let rough = 0.06 + saturate(dist / 3000.0) * 0.12;
  let spec = D_GGX(saturate(dot(n, h)), rough * rough) * 0.25 * F.sun.w;
  let sunC = F.sunColor.rgb * cloudShadow(wp);
  refl += sunC * spec;
  // Body color: absorption through the water column over the seabed.
  let deep = vec3f(0.005, 0.03, 0.05);
  let shallow = vec3f(0.03, 0.2, 0.2);
  let absorb = exp(-depth * vec3f(0.45, 0.09, 0.06));
  let amb = shIrradiance(vec3f(0.0, 1.0, 0.0));
  let sunLit = sunC * saturate(l.y) / PI;
  let seabed = pal(5) * (amb + sunLit) * 0.8;
  var body = mix(deep * (amb * 3.0 + sunLit), seabed, absorb);
  body = mix(body, shallow * (amb + sunLit), saturate(1.0 - depth / 12.0) * 0.4);
  // Subsurface light through thin crests (back-lit by the sun).
  let sss = pow(saturate(dot(-v, l) * 0.6 + 0.4), 4.0) * saturate(in.crest * 2.5);
  body += vec3f(0.05, 0.25, 0.2) * sunC * sss * 0.08;
  var col = mix(body, refl, fres);
  // Foam: shoreline band + crests.
  let fn1 = vnoise(wp2 * 0.6 + F.cam.w * 0.3) * 0.6 + vnoise(wp2 * 2.3 - F.cam.w * 0.5) * 0.4;
  let shore = saturate(1.0 - depth / 1.6) * smoothstep(0.35, 0.75, fn1 + 0.35 * sin(depth * 5.0 - F.cam.w * 2.0));
  let crestFoam = smoothstep(0.55, 0.9, in.crest * 1.8 + fn1 * 0.3) * saturate(1.0 - dist / 800.0);
  let foam = saturate(shore + crestFoam * 0.7);
  let foamCol = vec3f(0.85) * (amb + sunLit * max(dot(n, l), 0.0) * PI) ;
  col = mix(col, foamCol, foam);
  col = finishColor(col, wp);
  return gbuffer(col, wp, in.prevWorld, n, 0.05);
}
