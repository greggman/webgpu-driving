// Shading helpers: cascaded shadows, cloud shadows, GGX/Lambert, sky ambient,
// aerial perspective. Requires frame.wgsl + bindings.wgsl.

fn cascadeIndex(worldPos: vec3f) -> i32 {
  let viewZ = -(F.view * vec4f(worldPos, 1.0)).z;
  for (var i = 0; i < 4; i++) {
    if (viewZ < F.cascade[i]) { return i; }
  }
  return 4;
}

fn sampleCascade(worldPos: vec3f, n: vec3f, ci: i32) -> f32 {
  let texel = F.cascade[ci] * 2.2 / 2048.0;
  let p = worldPos + n * texel * 1.5 + F.sun.xyz * texel * 0.5;
  let sp = F.shadow[ci] * vec4f(p, 1.0);
  let uv = vec2f(sp.x * 0.5 + 0.5, 0.5 - sp.y * 0.5);
  if (any(uv < vec2f(0.001)) || any(uv > vec2f(0.999))) { return 1.0; }
  // Reverse-Z ortho: larger depth = closer to the light.
  let z = sp.z + 0.0002;
  // 12-tap rotated Poisson PCF.
  let a = fract(sin(dot(worldPos.xz, vec2f(12.9898, 78.233))) * 43758.5453) * 6.2831;
  let rot = mat2x2f(cos(a), sin(a), -sin(a), cos(a));
  var sum = 0.0;
  let r = 1.6 / 2048.0;
  let taps = array<vec2f, 8>(
    vec2f(-0.326, -0.406), vec2f(-0.840, -0.074), vec2f(-0.696, 0.457), vec2f(-0.203, 0.621),
    vec2f(0.962, -0.195), vec2f(0.473, -0.480), vec2f(0.519, 0.767), vec2f(0.185, -0.893));
  for (var i = 0; i < 8; i++) {
    let o = rot * taps[i] * r;
    sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, ci, z);
  }
  return sum / 8.0;
}

fn sunShadow(worldPos: vec3f, n: vec3f) -> f32 {
  let ci = cascadeIndex(worldPos);
  if (ci >= 4) { return 1.0; }
  var s = sampleCascade(worldPos, n, ci);
  // Blend to the next cascade near the far edge.
  let viewZ = -(F.view * vec4f(worldPos, 1.0)).z;
  let far = F.cascade[ci];
  let t = saturate((viewZ - far * 0.85) / (far * 0.15));
  if (t > 0.0) {
    let s2 = select(1.0, sampleCascade(worldPos, n, ci + 1), ci < 3);
    s = mix(s, s2, t);
  }
  return s;
}

// Cloud shadows: cloud density along the sun ray at the cloud layer height.
fn cloudShadow(worldPos: vec3f) -> f32 {
  if (F.sky.x <= 0.01) { return 1.0; }
  let h = 2500.0 - worldPos.y;
  let sy = max(F.sun.y, 0.08);
  let p = worldPos.xz + F.sun.xz / sy * h + F.misc.xy;
  let d = cloudDensity(p);
  return mix(1.0, 0.25, saturate(d * 1.6));
}

// 2D cloud density (world xz), shared by sky and cloud shadows.
fn cloudDensity(p: vec2f) -> f32 {
  let wind = F.weather.xy * F.cam.w * 6.0;
  let uv = (p + wind) / (9000.0 * F.sky.y);
  let n = textureSampleLevel(cloudTex, repSampler, uv, 0.0);
  let detail = textureSampleLevel(cloudTex, repSampler, uv * 4.3 + vec2f(0.31, 0.17), 0.0).g;
  let base = n.r * 0.75 + detail * 0.25;
  let cov = F.sky.x;
  return saturate((base - (1.0 - cov)) / max(0.35, 1e-3) );
}

// 2D cloud layer as seen along a view ray (shared by the sky pass and the
// environment map).
struct CloudResult {
  color: vec3f,
  alpha: f32,
};

fn cloudLayer(dir: vec3f, skyCol: vec3f) -> CloudResult {
  var r: CloudResult;
  r.color = vec3f(0.0);
  r.alpha = 0.0;
  if (dir.y <= 0.0 || F.sky.x <= 0.01) { return r; }
  let hgt = 2600.0 - F.cam.y;
  let t = hgt / max(dir.y, 0.015);
  let p = F.cam.xz + dir.xz * t + F.misc.xy;
  let dens = cloudDensity(p);
  if (dens <= 0.001) { return r; }
  // Light march toward the sun through the layer.
  var od = 0.0;
  let sdir = normalize(F.sun.xz + vec2f(1e-4));
  for (var i = 1; i <= 4; i++) {
    od += cloudDensity(p + sdir * f32(i) * 160.0);
  }
  let thickness = dens * 2.2;
  let sunT = exp(-od * 0.9);
  let powder = 1.0 - exp(-dens * 3.0);
  let cph = dot(dir, F.sun.xyz);
  let hg = mix(0.9 * (1.0 + 2.2 * pow(saturate(cph), 12.0)), 1.0, 0.3);
  let amb = shIrradiance(vec3f(0.0, 1.0, 0.0)) * PI * 0.42;
  let sunLit = F.sunColor.rgb * sunT * powder * hg * 0.25;
    var col = sunLit + amb * (0.7 + 0.3 * (1.0 - dens));
  // Lightning lights the cloud deck, brightest toward the strike.
  if (F.weather2.y > 0.0) {
    let toward = saturate(dot(normalize(dir.xz + vec2f(1e-4)), F.weather2.zw));
    col += LIGHTNING_COLOR * F.weather2.y * (0.6 + 6.0 * pow(toward, 6.0)) * (0.5 + dens);
  }
  // Overcast: darker undersides.
  col *= mix(1.0, 0.65, saturate(F.sky.x * 1.3 - 0.4) * saturate(thickness));
  let alpha = saturate(1.0 - exp(-dens * 4.0));
  // Distance fade into the atmosphere.
  let fade = exp(-t / 45000.0);
  r.color = mix(skyCol, col, fade);
  r.alpha = alpha * saturate(dir.y * 25.0);
  return r;
}

fn D_GGX(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn V_SmithGGX(nv: f32, nl: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  let gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

fn F_Schlick(f0: vec3f, vh: f32) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - vh, 5.0);
}

// Sky radiance in a direction (from the sky-view LUT).
fn skyRadiance(dir: vec3f) -> vec3f {
  let el = asin(clamp(dir.y, -1.0, 1.0));
  let az = atan2(dir.x, dir.z);
  return skyLUTLookup(az, el);
}

fn skyLUTLookup(az: f32, el: f32) -> vec3f {
  // Non-linear latitude mapping concentrates texels at the horizon.
  let hEl = select(-sqrt(-el / (PI * 0.5)), sqrt(el / (PI * 0.5)), el >= 0.0);
  let v = 0.5 - 0.5 * hEl;
  let u = fract(az / (2.0 * PI) + 1.0);
  return textureSampleLevel(skyLUT, linSampler, vec2f(u, v), 0.0).rgb;
}

// Specular environment: sky in reflection direction (horizon clamped to
// avoid reflecting the dark lower hemisphere), roughness blends to diffuse.
// Environment radiance from the prefiltered octahedral environment map
// (sky + clouds + horizon/ground, see envmap.wgsl); rougher = blurrier mip.
fn octEncode(d: vec3f) -> vec2f {
  let n = d / (abs(d.x) + abs(d.y) + abs(d.z));
  var o = n.xz;
  if (n.y < 0.0) {
    o = (1.0 - abs(n.zx)) * select(vec2f(-1.0), vec2f(1.0), n.xz >= vec2f(0.0));
  }
  return o * 0.5 + 0.5;
}

fn octDecode(uv: vec2f) -> vec3f {
  let f = uv * 2.0 - 1.0;
  var n = vec3f(f.x, 1.0 - abs(f.x) - abs(f.y), f.y);
  let t = saturate(-n.y);
  n.x += select(t, -t, n.x >= 0.0);
  n.z += select(t, -t, n.z >= 0.0);
  return normalize(n);
}

fn envRadiance(dir: vec3f, rough: f32) -> vec3f {
  let lod = clamp(sqrt(rough) * 7.0, 0.0, 7.0);
  return textureSampleLevel(envTex, linSampler, octEncode(normalize(dir)), lod).rgb;
}

fn envSpecular(r: vec3f, rough: f32, n: vec3f) -> vec3f {
  return mix(envRadiance(r, rough), shIrradiance(n), saturate(rough * rough * 1.2));
}

struct Surface {
  albedo: vec3f,
  n: vec3f,
  rough: f32,
  metal: f32,
  ao: f32,
  spec: f32,     // specular intensity scale (0..1)
  sss: f32,      // thin-foliage transmission
};

fn shadeSurface(s: Surface, worldPos: vec3f, shadowIn: f32) -> vec3f {
  let v = normalize(F.cam.xyz - worldPos);
  let n = s.n;
  let l = F.sun.xyz;
  let h = normalize(v + l);
  let nl = saturate(dot(n, l));
  let nv = max(dot(n, v), 1e-3);
  let nh = saturate(dot(n, h));
  let vh = saturate(dot(v, h));
  let a = max(s.rough * s.rough, 0.002);
  let f0 = mix(vec3f(0.04 * s.spec), s.albedo, s.metal);
  let diffCol = s.albedo * (1.0 - s.metal);
  let fr = F_Schlick(f0, vh);
  let spec = D_GGX(nh, a) * V_SmithGGX(nv, nl, a) * fr;
  let sunCol = F.sunColor.rgb * shadowIn;
  var col = (diffCol / PI * (vec3f(1.0) - fr) + spec) * sunCol * nl;
  // Thin translucency for foliage/grass.
  if (s.sss > 0.0) {
    let back = pow(saturate(dot(-v, l)), 4.0) * 0.8 + 0.2;
    col += diffCol * sunCol * s.sss * back * saturate(dot(-n, l) * 0.5 + 0.5) / PI;
  }
  // Ambient: SH sky irradiance + sky specular.
  let fAmb = f0 + (max(vec3f(1.0 - s.rough), f0) - f0) * pow(1.0 - nv, 5.0);
  col += diffCol * shIrradiance(n) * s.ao;
  let r = reflect(-v, n);
  col += envSpecular(r, s.rough, n) * fAmb * s.ao * (1.0 - s.rough * 0.7);
  col += localLights(s, worldPos, v);
  return col;
}

// Local lights (headlights, tail lights): clustered forward shading. The
// fragment finds its froxel cluster (see clusters.wgsl) and loops only over
// the lights binned there.
fn clusterIndex(worldPos: vec3f) -> u32 {
  let clip = F.viewProjNJ * vec4f(worldPos, 1.0);
  let ndc = clip.xy / clip.w;
  let uv = clamp(vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5), vec2f(0.0), vec2f(0.9999));
  let viewZ = max(-(F.view * vec4f(worldPos, 1.0)).z, 0.3);
  let k = u32(clamp(log(viewZ / 0.3) / log(600.0 / 0.3) * 24.0, 0.0, 23.0));
  let ij = vec2u(uv * vec2f(16.0, 9.0));
  return ((k * 9u + ij.y) * 16u + ij.x) * 32u;
}

fn localLights(s: Surface, worldPos: vec3f, v: vec3f) -> vec3f {
  if (F.lights.x < 0.5) { return vec3f(0.0); }
  let base = clusterIndex(worldPos);
  let count = clusterLights[base];
  var col = vec3f(0.0);
  for (var j = 0u; j < count; j++) {
    let i = clusterLights[base + 1u + j];
    let L = lightsBuf[i];
    let d = L.pos.xyz - worldPos;
    let dist2 = dot(d, d);
    let range = L.pos.w;
    if (dist2 > range * range) { continue; }
    let dist = sqrt(dist2);
    let l = d / dist;
    var att = 1.0 / max(dist2, 0.25);
    let win = saturate(1.0 - pow(dist / range, 4.0));
    att *= win * win;
    if (L.dir.w > -1.5) {
      let cd = dot(-l, L.dir.xyz);
      att *= smoothstep(L.dir.w, L.color.w, cd);
    }
    let nl = saturate(dot(s.n, l));
    if (nl <= 0.0 || att <= 0.0) { continue; }
    let h = normalize(v + l);
    let a = max(s.rough * s.rough, 0.02);
    let f0 = mix(vec3f(0.04 * s.spec), s.albedo, s.metal);
    let fr = F_Schlick(f0, saturate(dot(v, h)));
    let spec = D_GGX(saturate(dot(s.n, h)), a) * V_SmithGGX(max(dot(s.n, v), 1e-3), nl, a) * fr;
    col += (s.albedo * (1.0 - s.metal) / PI + spec) * L.color.rgb * att * nl;
  }
  return col;
}

// Final composition of a lit surface: aerial perspective + height fog.
fn finishColor(col: vec3f, worldPos: vec3f) -> vec3f {
  let ap = aerialPerspective(worldPos);
  let c = col * ap.a + ap.rgb;
  return applyVolumetric(worldPos, applyFog(worldPos, c));
}

// Motion vector (current - previous, in UV units) for a world position.
fn velocityFor(worldPos: vec3f, prevWorldPos: vec3f) -> vec2f {
  let c = F.viewProjNJ * vec4f(worldPos, 1.0);
  let p = F.prevViewProj * vec4f(prevWorldPos, 1.0);
  let cu = c.xy / c.w;
  let pu = p.xy / p.w;
  return (cu - pu) * vec2f(0.5, -0.5);
}

struct GBufferOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
  @location(2) normal: vec4f,
};

fn gbuffer(col: vec3f, worldPos: vec3f, prevWorldPos: vec3f, n: vec3f, rough: f32) -> GBufferOut {
  var o: GBufferOut;
  o.color = vec4f(col, 1.0);
  o.velocity = velocityFor(worldPos, prevWorldPos);
  o.normal = vec4f(n * 0.5 + 0.5, rough);
  return o;
}
