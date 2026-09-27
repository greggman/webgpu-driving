// Road surface: asphalt (or dirt) with procedural lane markings, wear,
// cracks, patches, wetness and snow. uv = (lateral d in m, s mod 1024).

@group(2) @binding(0) var<uniform> shadowVP: mat4x4f;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) mat: f32,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) mat: f32,
};

@vertex
fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.world = v.pos;
  o.normal = v.normal;
  o.uv = v.uv;
  o.mat = v.mat;
  return o;
}

@vertex
fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  return shadowVP * vec4f(v.pos, 1.0);
}

fn box1(x: f32, a: f32, b: f32, aa: f32) -> f32 {
  return smoothstep(a - aa, a + aa, x) * (1.0 - smoothstep(b - aa, b + aa, x));
}

// Paint mask for a line centered at c with half width w (anti-aliased).
fn lineMask(d: f32, c: f32, w: f32, aa: f32) -> f32 {
  return 1.0 - smoothstep(w - aa, w + aa, abs(d - c));
}

fn dashMask(s: f32, period: f32, on: f32, aa: f32) -> f32 {
  let f = fract(s / period) * period;
  return box1(f, 0.0, on, aa);
}

@fragment
fn fs(in: VOut) -> GBufferOut {
  let d = in.uv.x;
  let s = in.uv.y;
  let wp = in.world;
  let dist = distance(wp, F.cam.xyz);
  var n = normalize(in.normal);
  let aa = max(fwidth(d), 0.004) * 0.75;
  let aaS = max(fwidth(s), 0.004) * 0.75;
  let halfW = F.road.w;
  let laneW = F.lights.z;
  let lanes = F.lights.w;
  let dirt = F.palette[8].w > 0.5;
  let snow = F.palette[7].w;
  let wet = F.weather.w;
  let p2 = vec2f(d, s);
  let world2 = wp.xz + F.misc.xy;

  var albedo: vec3f;
  var rough: f32;
  var spec = 0.5;
  let fine = vnoise(world2 * 14.0) * 0.5 + vnoise(world2 * 37.0) * 0.5;
  let mid = fbm2(world2 * 0.35, 3);
  let big = fbm2(world2 * 0.03, 3);

  if (in.mat > 0.5 && in.mat < 1.5) {
    // Concrete barrier / deck.
    albedo = vec3f(0.55, 0.54, 0.5) * (0.8 + 0.3 * mid) * (0.9 + 0.2 * fine);
    rough = 0.8;
    } else if (in.mat > 1.5) {
    // Gravel shoulder skirt (dirt roads blend straight into the terrain).
    if (dirt) { discard; }
    albedo = pal(3) * (0.75 + 0.5 * fine);
    rough = 0.95;
  } else if (dirt) {
    // Dirt road with two tire ruts and loose gravel.
    let rutC = laneW * 0.5;
    let rut = lineMask(abs(d), rutC - 0.8, 0.28, 0.2) + lineMask(abs(d), rutC + 0.8, 0.28, 0.2);
    albedo = pal(3) * (0.85 + 0.25 * mid) * (0.85 + 0.3 * fine);
    albedo *= 1.0 - 0.18 * saturate(rut);
        // Ragged edge: the road dissolves into the dirt shoulder along an
    // irregular line (tyres wander, gravel spreads), with tufts and
    // pebbles near it.
    let wob = fbm2(world2 * 0.45, 3) * 1.4 + vnoise(world2 * 2.3) * 0.5 + fine * 0.35;
    let edgeLine = halfW - 0.2 - wob;
    if (abs(d) > edgeLine) { discard; }
    let nearEdge = smoothstep(edgeLine - 1.2, edgeLine, abs(d));
    let tuft = step(0.72, vnoise(world2 * 3.1)) * nearEdge;
    albedo = mix(albedo, pal(0) * 0.8, tuft * 0.6);
    albedo *= 1.0 - 0.25 * nearEdge * step(0.8, vnoise(world2 * 9.0));
    rough = 0.95;
    // Bumpy normal.
    let gs = noised(world2 * 5.0).yz * 5.0 * 0.03 + noised(world2 * 17.0 + 3.3).yz * 17.0 * 0.006;
    n = normalize(n + vec3f(-gs.x, 0.0, -gs.y) * saturate(1.0 - dist / 60.0));
  } else {
    // Asphalt.
    let agg = fine;
    albedo = vec3f(0.075, 0.075, 0.08) * (0.75 + 0.5 * agg);
    albedo *= 0.85 + 0.35 * big;
    rough = 0.72 + 0.12 * agg;
    // Patches (older/newer asphalt rectangles).
    let pc = floor(vec2f(d / 3.0, s / 17.0));
    let ph = hash01(i32(pc.x) + 7, i32(pc.y) + 1234);
    if (ph > 0.88) {
      let q = fract(vec2f(d / 3.0, s / 17.0));
      let inner = box1(q.x, 0.08, 0.92, 0.02) * box1(q.y, 0.1, 0.9, 0.01);
      albedo *= mix(1.0, select(0.6, 1.35, ph > 0.94), inner);
    }
    // Wheel-track polish and oil drip line per lane.
    let laneC = fract((d + halfW) / laneW) * laneW;
    let track = lineMask(laneC, laneW * 0.25, 0.35, 0.3) + lineMask(laneC, laneW * 0.75, 0.35, 0.3);
    albedo *= 1.0 - 0.12 * saturate(track);
    rough -= 0.12 * saturate(track);
    let oil = lineMask(laneC, laneW * 0.5, 0.3, 0.25) * (0.5 + 0.5 * mid);
    albedo *= 1.0 - 0.25 * oil;
    // Cracks.
    let cr = abs(fbm2(p2 * vec2f(0.8, 0.25), 4) - 0.5);
    let crack = (1.0 - smoothstep(0.004, 0.015, cr)) * smoothstep(0.55, 0.75, big) * saturate(1.0 - dist / 80.0);
    albedo *= 1.0 - 0.5 * crack;
    // Tar snakes.
    let tar = (1.0 - smoothstep(0.003, 0.009, abs(fbm2(p2 * vec2f(0.5, 0.12) + 31.0, 3) - 0.5))) * saturate(1.0 - dist / 60.0);
    albedo = mix(albedo, vec3f(0.025), tar * 0.7);
    rough = mix(rough, 0.55, tar);

    // ---- Markings ----
    var paint = 0.0;
    var yellow = 0.0;
    let wear = 0.75 + 0.25 * smoothstep(0.2, 0.6, fine + mid * 0.5);
    let cl = i32(F.palette[8].z);
    if (cl == 1) { // double yellow
      yellow = max(lineMask(d, 0.18, 0.06, aa), lineMask(d, -0.18, 0.06, aa));
    } else if (cl == 2) { // dashed yellow
      yellow = lineMask(d, 0.0, 0.07, aa) * dashMask(s, 12.8, 3.2, aaS);
    } else if (cl == 3) { // dashed white
      paint = lineMask(d, 0.0, 0.07, aa) * dashMask(s, 12.8, 3.2, aaS);
    }
    if (lanes > 1.5) {
      paint = max(paint, lineMask(abs(d), laneW, 0.07, aa) * dashMask(s, 12.8, 3.2, aaS));
    }
    if (F.palette[8].y > 0.5) {
      let ew = lanes * laneW + 0.15;
      paint = max(paint, lineMask(abs(d), ew, 0.08, aa));
    }
    paint *= wear;
    yellow *= wear;
    albedo = mix(albedo, vec3f(0.78, 0.78, 0.75), paint);
    albedo = mix(albedo, vec3f(0.8, 0.55, 0.08), yellow);
    rough = mix(rough, 0.55, max(paint, yellow));
    // Retroreflection: paint glows in the headlights at night.
    spec = 0.5 + 2.5 * max(paint, yellow) * F.moon.w;
  }

    // Wet road: water fills the pores (the surface goes much darker) and a
  // thin water coat lies on top: a sharp, mirror-like layer that reflects
  // the sky, the lights and (via SSR) the scene. Thicker in the wheel ruts
  // and low spots (puddles), rippled by the rain.
  var coat = 0.0;
  var nCoat = normalize(in.normal);
  if (wet > 0.0 && in.mat < 1.5) {
    let laneC = fract((d + halfW) / laneW) * laneW;
    let ruts = saturate(lineMask(laneC, laneW * 0.28, 0.35, 0.3) + lineMask(laneC, laneW * 0.72, 0.35, 0.3));
    let puddle = smoothstep(0.52, 0.66, big + mid * 0.25);
        // Water-saturated asphalt is much darker, and at the grazing angles
    // of headlights most of their light reflects forward off the water
    // instead of reaching it: a wet road barely shows a beam pool.
    albedo *= mix(1.0, 0.28, wet);
        coat = wet * saturate(0.55 + 0.25 * ruts + 0.5 * puddle);
    albedo *= 1.0 - 0.7 * coat;
    n = normalize(mix(n, nCoat, coat * 0.7));
    // Rain ripples: expanding rings from drops landing in the water.
    let rain = F.weather2.x;
    if (rain > 0.0) {
      let cellSz = 0.22;
      let cp = world2 / cellSz;
      let ci = floor(cp);
      var rip = vec2f(0.0);
      for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
          let cc = ci + vec2f(f32(x), f32(y));
          let hh = pcg(bitcast<u32>(i32(cc.x)) + pcg(bitcast<u32>(i32(cc.y))));
          let ph = fract(F.cam.w * (0.9 + rand01(hh) * 0.6) + rand01(pcg(hh + 1u)));
          let c = cc + vec2f(rand01(pcg(hh + 2u)), rand01(pcg(hh + 3u)));
          let q = cp - c;
          let dq = length(q);
          let ringR = ph * 0.9;
          let ring = exp(-pow((dq - ringR) * 14.0, 2.0)) * (1.0 - ph) * step(ph, 0.95);
          rip += q / max(dq, 1e-3) * ring;
        }
      }
      nCoat = normalize(nCoat + vec3f(rip.x, 0.0, rip.y) * 0.35 * rain * saturate(1.0 - dist / 40.0));
    }
  }
  // Snow: packed snow at the edges and between wheel tracks.
  if (snow > 0.0 && in.mat < 0.5) {
    let laneC = fract((d + halfW) / laneW) * laneW;
    let tracks = lineMask(laneC, laneW * 0.25, 0.4, 0.25) + lineMask(laneC, laneW * 0.75, 0.4, 0.25);
    let edge = smoothstep(halfW - 1.5, halfW - 0.2, abs(d));
    let cover = saturate(max(edge, (1.0 - saturate(tracks)) * 0.7) * snow + (mid - 0.5) * 0.4);
    albedo = mix(albedo, vec3f(0.82, 0.84, 0.88), cover);
    rough = mix(rough, 0.55, cover);
  }

  var sf: Surface;
  sf.albedo = albedo;
  sf.n = n;
  sf.rough = clamp(rough, 0.03, 1.0);
  sf.metal = 0.0;
  sf.ao = 1.0;
  sf.spec = spec;
  sf.sss = 0.0;
    let sh = sunShadow(wp, n) * cloudShadow(wp);
  var col = shadeSurface(sf, wp, sh);
  var gbRough = sf.rough;
  var gbN = n;
  if (coat > 0.0) {
    // Water coat: Fresnel-weighted mirror of the environment plus sharp
    // highlights from the sun / moon and every nearby light (oncoming
    // headlights, tail lights), over the darkened base.
    let v = normalize(F.cam.xyz - wp);
    let nv = saturate(dot(nCoat, v));
    let fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    let r = reflect(-v, nCoat);
    var w: Surface;
    w.albedo = vec3f(0.0);
    w.n = nCoat;
        // Slightly rough water (ripples, spray): light sources smear into the
    // long vertical streaks of a wet night road.
    w.rough = 0.12;
    w.metal = 0.0;
    w.ao = 1.0;
    w.spec = 0.5;
    w.sss = 0.0;
    let l = F.sun.xyz;
    let h = normalize(v + l);
        let glint = D_GGX(saturate(dot(nCoat, h)), 0.01) * V_SmithGGX(max(nv, 1e-3), saturate(dot(nCoat, l)), 0.01) * fres;
        // (+ the lightning bolt mirrored in the water, smeared by ripples)
    let refl = envRadiance(r, 0.03) * fres + F.sunColor.rgb * min(glint, 400.0) * sh * saturate(dot(nCoat, l)) + localLights(w, wp, v)
      + lightningBolt(r, 10.0) * fres;
    col = col * (1.0 - fres * coat) + refl * coat;
    // Mark the coat for screen-space reflections (roughness < 0.09).
    gbRough = mix(0.09, 0.02, coat);
    gbN = nCoat;
  }
  col = finishColor(col, wp);
  return gbuffer(col, wp, wp, gbN, gbRough);
}
