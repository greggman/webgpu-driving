// Fullscreen sky: sky-view LUT, sun disk, 2D clouds, moon, stars.

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: VOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

fn starField(dir: vec3f) -> vec3f {
  // Stars on a spherical grid (octahedral-ish cells).
  var col = vec3f(0.0);
  let d = dir;
  for (var layer = 0; layer < 2; layer++) {
    let scale = select(180.0, 420.0, layer == 1);
    let u = atan2(d.z, d.x) / (2.0 * PI) + 0.5;
    let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    let cells = vec2f(scale * 2.0, scale);
    let g = vec2f(u, v) * cells;
    let ci = floor(g);
    let h = hash01(i32(ci.x) + layer * 7919, i32(ci.y));
    if (h > 0.985) {
      let off = vec2f(hash01(i32(ci.x) + 17, i32(ci.y) + 3), hash01(i32(ci.x) + 5, i32(ci.y) + 29));
      let fp = (g - ci - off * 0.8 - 0.1);
      // Correct horizontal cell stretching near the poles.
      let sx = sin(v * PI);
      let dist = length(vec2f(fp.x * max(sx, 0.05), fp.y));
      let mag = pow((h - 0.985) / 0.015, 3.0);
      let tw = 0.75 + 0.25 * sin(F.cam.w * (2.0 + h * 9.0) + h * 100.0);
      let temp = hash01(i32(ci.x) + 91, i32(ci.y) + 7);
      let tint = mix(vec3f(0.7, 0.8, 1.0), vec3f(1.0, 0.85, 0.65), temp);
      let px = 6.0 / scale; // keep stars ~1-2 pixels wide
      col += tint * mag * tw * exp(-dist * dist / (px * px * 0.02)) * 1.5;
    }
  }
  // Milky Way band along a tilted great circle.
  let axis = normalize(vec3f(0.3, 0.55, 0.78));
  let band = 1.0 - abs(dot(d, axis));
  let mw = pow(band, 10.0) * (0.35 + 0.65 * fbm2(d.xz * 8.0 + d.y * 5.0, 5));
  col += vec3f(0.5, 0.55, 0.7) * mw * 0.35;
  return col;
}

fn moonDisk(dir: vec3f) -> vec3f {
  let md = F.moon.xyz;
  let c = dot(dir, md);
  let radius = 0.0105;
  let cr = cos(radius);
  if (c < cr) {
    // Glow.
    let g = pow(saturate(c), 900.0);
    return vec3f(0.6, 0.65, 0.8) * g * 0.08;
  }
  // Local disk coordinates.
  var right = normalize(cross(md, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, md);
  let q = vec2f(dot(dir - md, right), dot(dir - md, up)) / sin(radius);
  let z = sqrt(saturate(1.0 - dot(q, q)));
  let n = normalize(right * q.x + up * q.y + md * z);
  // Phase: lit from a direction rotated around.
  let lightDir = normalize(right * 0.8 + md * -0.2 + up * 0.25);
  let lit = saturate(dot(n, -lightDir) * 1.2 + 0.1);
  let maria = 0.65 + 0.35 * fbm2(q * 3.0 + 7.0, 4);
  return vec3f(1.0, 0.97, 0.9) * lit * maria * 1.6;
}

fn sunDisk(dir: vec3f) -> vec3f {
  if (F.sun.w < 0.5) { return vec3f(0.0); }
  let c = dot(dir, F.sun.xyz);
  let radius = 0.0075; // a bit larger than real for drama
  let cr = cos(radius);
  if (c < cr) { return vec3f(0.0); }
  let t = saturate((1.0 - c) / (1.0 - cr));
  let limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - t * t));
  let trans = transmittanceAt(EARTH_R + max(F.cam.y, 0.0) * 1e-6, dir.y);
  return trans * 20.0 * 800.0 * limb;
}

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
  // Overcast: darker undersides.
  col *= mix(1.0, 0.65, saturate(F.sky.x * 1.3 - 0.4) * saturate(thickness));
  let alpha = saturate(1.0 - exp(-dens * 4.0));
  // Distance fade into the atmosphere.
  let fade = exp(-t / 45000.0);
  r.color = mix(skyCol, col, fade);
  r.alpha = alpha * saturate(dir.y * 25.0);
  return r;
}

@fragment
fn fs(in: VOut) -> GBufferOut {
  let wp = F.invViewProj * vec4f(in.ndc, 0.5, 1.0);
  let dir = normalize(wp.xyz / wp.w - F.cam.xyz);
  var col = skyRadiance(dir);
  let night = F.moon.w;
  if (night > 0.0) {
    let horizon = saturate(dir.y * 8.0 + 0.2);
    col += (starField(dir) * F.sky.w + moonDisk(dir)) * night * horizon * (1.0 - F.sky.x * 0.8);
  }
  col += sunDisk(dir);
  let cl = cloudLayer(dir, col);
  col = mix(col, cl.color, cl.alpha);
  // Snow / fog: blend to fog color toward the horizon.
  if (F.fog.x > 0.0) {
    let far = F.cam.xyz + dir * 20000.0;
    let ft = fogTransmittance(far);
    col = mix(fogColor(dir), col, ft);
  }
  var o: GBufferOut;
  o.color = vec4f(col, 1.0);
  let c = F.viewProjNJ * vec4f(dir, 0.0);
  let p = F.prevViewProj * vec4f(dir, 0.0);
  o.velocity = (c.xy / c.w - p.xy / p.w) * vec2f(0.5, -0.5);
  o.normal = vec4f(0.5, 1.0, 0.5, 1.0);
  return o;
}
