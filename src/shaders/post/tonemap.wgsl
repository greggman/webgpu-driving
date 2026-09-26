// Final composite: exposure, bloom, lens flare, AgX tonemapping, per-biome
// grade, vignette, film grain, letterbox, dither.
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> exposureBuf: array<f32>;
@group(0) @binding(5) var glassFxTex: texture_2d<f32>;

fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agx(v0: vec3f) -> vec3f {
  let m = mat3x3f(
    vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051),
    vec3f(0.0784335999999992, 0.878468636469772, 0.0784336),
    vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104));
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var v = m * v0;
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv));
  v = (v - minEv) / (maxEv - minEv);
  return agxContrast(v);
}

fn agxEotf(v: vec3f) -> vec3f {
  let mi = mat3x3f(
    vec3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438),
    vec3f(-0.0980208811401368, 1.15190312990417, -0.0980434501171241),
    vec3f(-0.0990297440797205, -0.0989611768448433, 1.15107367264116));
  return mi * v;
}

// Sun lens flare: ghosts along the line through the screen center.
fn lensFlare(uv: vec2f) -> vec3f {
  if (F.sun.w < 0.5) { return vec3f(0.0); }
  let sp = F.viewProjNJ * vec4f(F.sun.xyz, 0.0);
  if (sp.w <= 0.0) { return vec3f(0.0); }
  let suv = vec2f(sp.x / sp.w * 0.5 + 0.5, 0.5 - sp.y / sp.w * 0.5);
  let onScreen = saturate(1.0 - max(abs(suv.x - 0.5), abs(suv.y - 0.5)) * 1.6);
  if (onScreen <= 0.0) { return vec3f(0.0); }
  // Occlusion: the sky pixel at the sun must be bright.
  let sunHdr = textureSampleLevel(hdrTex, samp, clamp(suv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  let vis = saturate(luminance(sunHdr) / 30.0);
  let aspect = F.misc.z / F.misc.w;
  var col = vec3f(0.0);
  let axis = vec2f(0.5) - suv;
  let ghosts = array<vec4f, 5>(
    vec4f(0.4, 0.05, 1.0, 0.6),
    vec4f(0.7, 0.03, 0.6, 1.0),
    vec4f(1.2, 0.08, 0.9, 0.7),
    vec4f(1.5, 0.02, 1.0, 0.9),
    vec4f(1.9, 0.12, 0.5, 0.8));
  for (var i = 0; i < 5; i++) {
    let g = ghosts[i];
    let gp = suv + axis * g.x * 2.0;
    let d = length((uv - gp) * vec2f(aspect, 1.0));
    let ring = smoothstep(g.y, g.y * 0.7, d);
    col += vec3f(g.z, g.w, 1.0) * ring * 0.02;
  }
  // Soft halo + streak.
  let dv = (uv - suv) * vec2f(aspect, 1.0);
  col += vec3f(1.0, 0.8, 0.6) * exp(-length(dv) * 7.0) * 0.12;
  col += vec3f(0.9, 0.8, 1.0) * exp(-abs(dv.y) * 250.0) * exp(-abs(dv.x) * 3.0) * 0.08;
  return col * vis * onScreen * F.sunColor.rgb * 0.1;
}

fn hash12(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs(in: FsOut) -> @location(0) vec4f {
    var uv = in.uv;
  // Rain drops on the car's glass refract the view (see fsGlassFx).
  var fx = vec4f(0.0);
  if (F.glass.y > 0.5) {
    fx = textureSampleLevel(glassFxTex, samp, uv, 0.0);
    uv = clamp(uv + fx.xy, vec2f(0.0), vec2f(1.0));
  }
  // Letterbox for "commercial" framing.
  let lb = F.grade2.w;
  if (lb > 0.0 && (uv.y < lb || uv.y > 1.0 - lb)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  // Chromatic aberration toward the corners.
  let cc = uv - 0.5;
  let ca = dot(cc, cc) * 0.004;
  var hdr = vec3f(
    textureSampleLevel(hdrTex, samp, uv - cc * ca, 0.0).r,
    textureSampleLevel(hdrTex, samp, uv, 0.0).g,
    textureSampleLevel(hdrTex, samp, uv + cc * ca, 0.0).b);
    hdr *= 1.0 - fx.z;
  hdr += fx.w * textureSampleLevel(bloomTex, samp, clamp(uv - vec2f(0.0, 0.2), vec2f(0.0), vec2f(1.0)), 0.0).rgb * 1.5;
  let bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  hdr = mix(hdr, bloom, 0.05 * F.post.x);
  hdr += lensFlare(uv);
  let exposure = exposureBuf[0] * F.sunColor.w;
  var c = hdr * exposure;
  // White balance / grade in linear.
  c *= F.grade.rgb;
  c = agx(c);
  // AgX "look": saturation + contrast.
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = pow(max(c, vec3f(0.0)), vec3f(F.grade2.x));
  c = luma + F.grade.w * (c - luma);
  c = agxEotf(c);
  // Vignette.
  let vig = 1.0 - dot(cc, cc) * F.grade2.y;
  c *= vig;
  // Film grain + dither.
  let g = hash12(in.pos.xy + fract(F.cam.w * 7.3) * 100.0) - 0.5;
  c += g * F.grade2.z;
  c += (hash12(in.pos.xy * 1.37) - 0.5) / 255.0;
  return vec4f(saturate3(c), 1.0);
}
