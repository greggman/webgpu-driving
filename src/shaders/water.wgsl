// Ocean. A camera-centred polar grid displaced by Gerstner waves, shaded
// with per-pixel normals from the same wave spectrum.
//
// Anti-aliasing is the key to making it read as water rather than
// flickering noise:
//  * vertices only take waves that are long relative to the local mesh
//    spacing (band-limited geometry, so far rings don't pop as the grid
//    recentres);
//  * the pixel shader drops waves shorter than a few pixels and turns their
//    slope variance into extra roughness (the distant sea becomes a smooth,
//    soft-sheened surface instead of sparkling noise);
//  * the sun glint is energy-clamped.

struct WVOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) flat_: vec2f,     // undisplaced local xz
  @location(2) prevWorld: vec3f,
};

const RINGS = 110u;
const SEGS = 160u;
const NWAVES = 26;

struct Wave {
  dir: vec2f,
  k: f32,      // wavenumber
  amp: f32,
  speed: f32,  // angular frequency
  phase: f32,
  len: f32,
};

fn wave(i: i32) -> Wave {
  let fi = f32(i);
  let windA = atan2(F.weather.y, F.weather.x);
  let L = 90.0 * pow(0.78, fi) * (0.8 + 0.4 * hash01(i, 41));
  // Longer waves roughly follow the wind; short chop spreads everywhere.
  let spread = mix(1.4, 3.0, saturate(fi / f32(NWAVES)));
  let a = windA + (hash01(i * 7 + 1, 3) - 0.5) * spread;
  var w: Wave;
  w.dir = vec2f(cos(a), sin(a));
  w.k = 6.2831853 / L;
  w.amp = L * 0.006 * (0.45 + 1.1 * hash01(i, 5));
  w.speed = sqrt(9.81 * w.k);
  w.phase = hash01(i, 19) * 6.2831853;
  w.len = L;
  return w;
}

fn displace(p: vec2f, t: f32, spacing: f32) -> vec3f {
  var d = vec3f(0.0);
  for (var i = 0; i < 12; i++) {
    let w = wave(i);
    // Only waves resolvable by the local vertex spacing.
    let band = smoothstep(4.0 * spacing, 8.0 * spacing, w.len);
    if (band <= 0.0) { break; }
    let th = w.k * dot(w.dir, p) - w.speed * t + w.phase;
    let q = 0.5 / (w.k * w.amp * 12.0 + 1e-4);
    let a = w.amp * band;
    d += vec3f(w.dir.x * q * a * cos(th), a * sin(th), w.dir.y * q * a * cos(th));
  }
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
  // Snap the centre to the innermost ring spacing so near vertices are stable.
  let snap = 1.0;
  let center = floor(F.cam.xz / snap) * snap;
  let p = center + vec2f(cos(ang), sin(ang)) * radius;
  let spacing = max(radius * 0.1, 0.06);
  let wp = p + F.misc.xy;
  let d = displace(wp, F.cam.w, spacing);
  let dPrev = displace(wp, F.cam.w - 1.0 / 60.0, spacing);
  var o: WVOut;
  let world = vec3f(p.x + d.x, d.y, p.y + d.z);
  o.world = world;
  o.flat_ = p;
  o.prevWorld = vec3f(p.x + dPrev.x, dPrev.y, p.y + dPrev.z);
  o.pos = F.viewProj * vec4f(world, 1.0);
  return o;
}

@fragment
fn fs(in: WVOut) -> GBufferOut {
  // Pixel footprint in metres (uniform control flow).
  let fpx = max(length(dpdx(in.flat_)), length(dpdy(in.flat_)));
  let wp = in.world;
  let p2 = in.flat_ + F.misc.xy;
  let t = F.cam.w;
  // Filtered slopes + lost variance.
  var slope = vec2f(0.0);
  var variance = 0.0;
  var crest = 0.0;
  for (var i = 0; i < NWAVES; i++) {
    let w = wave(i);
    let ka = w.k * w.amp;
    let px = w.len / max(fpx, 1e-4); // pixels per wavelength
    let keep = saturate((px - 3.0) / 4.0);
    let th = w.k * dot(w.dir, p2) - w.speed * t + w.phase;
    slope += w.dir * ka * cos(th) * keep;
    variance += ka * ka * 0.5 * (1.0 - keep);
    crest += max(sin(th), 0.0) * ka * keep;
  }
  let n = normalize(vec3f(-slope.x, 1.0, -slope.y));
  let dist = distance(wp, F.cam.xyz);
  let v = normalize(F.cam.xyz - wp);
  var nv = dot(n, v);
  var nn = n;
  if (nv < 0.02) { nn = normalize(n + v * (0.02 - nv)); nv = 0.02; }
  let rough = clamp(sqrt(0.03 * 0.03 + variance * 2.0), 0.03, 0.5);

  // Depth under the surface from the terrain clipmap.
  let lvl = clamp(i32(log2(max(dist * 0.004, 0.5) / 0.5)), 0, CLIP_LEVELS - 1);
  let ground = clipSample(wp.xz, lvl).x;
  let depth = max(wp.y - ground, 0.0);

  // Reflection: rougher surface reflects a blurrier (more ambient) sky.
  let fres = 0.02 + 0.98 * pow(1.0 - saturate(nv), 5.0);
  let r = reflect(-v, nn);
  let rr = normalize(vec3f(r.x, abs(r.y), r.z));
  let amb = shIrradiance(vec3f(0.0, 1.0, 0.0));
  var refl = mix(skyRadiance(rr), amb * 1.2, saturate(rough * 2.0));
  // Sun glint, energy clamped (no fireflies).
  let l = F.sun.xyz;
  let h = normalize(v + l);
  let a = rough * rough;
  let spec = min(D_GGX(saturate(dot(nn, h)), a) * 0.25, 60.0) * F.sun.w;
  let sunC = F.sunColor.rgb * cloudShadow(wp);
  refl += sunC * spec * fres * 4.0;

  // Body: absorption over the seabed near shore, deep blue offshore, with
  // light scattered up from within (brighter where waves face the sun).
  let sunLit = sunC * saturate(l.y) / PI;
  let deepCol = vec3f(0.004, 0.028, 0.045) * (amb * 3.0 + sunLit * 0.6);
  let absorb = exp(-depth * vec3f(0.45, 0.1, 0.07));
  let seabed = pal(5) * (amb + sunLit) * 0.75;
  var body = mix(deepCol, seabed, absorb);
  body = mix(body, vec3f(0.03, 0.2, 0.19) * (amb + sunLit), saturate(1.0 - depth / 10.0) * 0.35);
  let sss = pow(saturate(dot(-v, l) * 0.6 + 0.4), 4.0) * saturate(crest * 3.0);
  body += vec3f(0.04, 0.22, 0.18) * sunC * sss * 0.06;
  var col = mix(body, refl, fres);

  // Foam: a stable shoreline band and filtered crest caps.
  let fn1 = vnoise(p2 * 0.35 + vec2f(t * 0.2, 0.0)) * 0.6 + vnoise(p2 * 1.3 - vec2f(0.0, t * 0.3)) * 0.4;
  let shore = saturate(1.0 - depth / 1.4) * smoothstep(0.3, 0.7, fn1 + 0.25 * sin(depth * 4.0 - t * 1.5));
  let caps = smoothstep(0.35, 0.7, crest * 2.2 + fn1 * 0.25) * saturate(1.0 - dist / 600.0);
  let foam = saturate(shore + caps * 0.5);
  let foamCol = vec3f(0.85) * (amb + sunLit * saturate(dot(nn, l)) * PI);
  col = mix(col, foamCol, foam);
  col = finishColor(col, wp);
  return gbuffer(col, wp, in.prevWorld, nn, rough);
}
