// Screen-space reflections for mirror-like wet surfaces (wet road coat,
// puddles, calm water). The G-buffer marks them with roughness < SSR_ROUGH;
// the lower it is, the more water (coverage). Rays march through the depth
// buffer from the surface along the reflected view direction with growing,
// per-pixel-jittered steps (TAA resolves the noise) and a short binary
// refinement; the hit's lit color, scaled by the water's Fresnel term and
// faded at the screen edges, is added to the HDR target by fsComposite.
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var colorTex: texture_2d<f32>;

const SSR_ROUGH = 0.09;
const STEPS = 40;

fn worldAt(px: vec2i, size: vec2f) -> vec3f {
  let d = textureLoad(depthTex, px, 0);
  let uv = (vec2f(px) + 0.5) / size;
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, max(d, 1e-7), 1.0);
  let w = F.invViewProj * ndc;
  return w.xyz / w.w;
}

// World -> pixel (+ ok flag).
fn toScreen(p: vec3f, size: vec2f) -> vec3f {
  let c = F.viewProjNJ * vec4f(p, 1.0);
  if (c.w <= 0.0) { return vec3f(-1.0, -1.0, 0.0); }
  let ndc = c.xy / c.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  return vec3f(uv * size, 1.0);
}

@fragment
fn fs(in: FsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(depthTex));
  let px = vec2i(in.pos.xy);
  let d = textureLoad(depthTex, px, 0);
  if (d <= 0.0) { return vec4f(0.0); }
  let nr = textureLoad(normalTex, px, 0);
  if (nr.a >= SSR_ROUGH) { return vec4f(0.0); }
  let coverage = saturate((SSR_ROUGH - nr.a) / (SSR_ROUGH - 0.02));
  let n = normalize(nr.xyz * 2.0 - 1.0);
  let P = worldAt(px, size);
  let v = normalize(F.cam.xyz - P);
  let r = reflect(-v, n);
  // Rays heading down into the surface, or straight up to the sky (the
  // environment map already covers the sky), don't need marching.
  if (dot(r, n) <= 0.0 || r.y > 0.6) { return vec4f(0.0); }
  let fres = 0.02 + 0.98 * pow(1.0 - saturate(dot(n, v)), 5.0);
  let jitter = fract(52.9829189 * fract(dot(in.pos.xy, vec2f(0.06711056, 0.00583715))) + F.misc2.z * 0.618);
  let camDist = distance(P, F.cam.xyz);
  var t = 0.05 + 0.1 * jitter;
  var prevT = 0.0;
  var hit = false;
  var hitPx = vec2f(0.0);
  for (var i = 0; i < STEPS; i++) {
    let X = P + r * t;
    let sp = toScreen(X, size);
    if (sp.z == 0.0 || any(sp.xy < vec2f(0.0)) || any(sp.xy >= size)) { break; }
    let S = worldAt(vec2i(sp.xy), size);
    let rayD = distance(X, F.cam.xyz);
    let sceneD = distance(S, F.cam.xyz);
    let thick = 0.25 + t * 0.06;
    if (rayD > sceneD && rayD - sceneD < thick) {
      // Refine between the last two samples.
      var a = prevT;
      var b = t;
      for (var k = 0; k < 5; k++) {
        let m = (a + b) * 0.5;
        let Xm = P + r * m;
        let spm = toScreen(Xm, size);
        let Sm = worldAt(vec2i(clamp(spm.xy, vec2f(0.0), size - 1.0)), size);
        if (distance(Xm, F.cam.xyz) > distance(Sm, F.cam.xyz)) { b = m; } else { a = m; }
      }
      hitPx = toScreen(P + r * b, size).xy;
      hit = true;
      break;
    }
    prevT = t;
    t = t * 1.13 + 0.06;
  }
  if (!hit) { return vec4f(0.0); }
  let c = textureLoad(colorTex, vec2i(clamp(hitPx, vec2f(0.0), size - 1.0)), 0).rgb;
  // Fade toward the screen edges and for very long rays.
  let e = min(min(hitPx.x, size.x - hitPx.x), min(hitPx.y, size.y - hitPx.y)) / (size.y * 0.1);
  let fade = saturate(e) * saturate(1.0 - t / 120.0) * saturate(1.0 - camDist / 250.0);
  return vec4f(c * fres * coverage * fade, 0.0);
}

// Add the reflections into the HDR target.
@group(0) @binding(4) var ssrTex: texture_2d<f32>;

@fragment
fn fsComposite(in: FsOut) -> @location(0) vec4f {
  return vec4f(textureLoad(ssrTex, vec2i(in.pos.xy), 0).rgb, 0.0);
}
