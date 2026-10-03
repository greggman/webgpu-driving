// Tunnel lining and portal headwalls (see tunnelMesh.ts). uv: for the
// lining (height above the road, world z mod 6144), for the headwalls the
// face's (d, height). Lit by shadeSurface, which fades out the sky and adds
// the lamps inside the bore; the lamp fixtures glow.

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
  @location(3) @interpolate(flat) mat: u32,
};

@vertex
fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.world = v.pos;
  o.normal = v.normal;
  o.uv = v.uv;
  o.mat = u32(v.mat + 0.5);
  return o;
}

@vertex
fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  return shadowVP * vec4f(v.pos, 1.0);
}

// Grout lines of a w x h grid (1 on a line), anti-aliased over aa
// (= fwidth(p), taken in uniform control flow).
fn grout(p: vec2f, cell: vec2f, width: f32, aa0: vec2f) -> f32 {
  let q = abs(fract(p / cell + 0.5) - 0.5) * cell;
  let aa = max(aa0, vec2f(1e-4));
  let g = 1.0 - smoothstep(vec2f(width) - aa, vec2f(width) + aa, q);
  return max(g.x, g.y);
}

@fragment
fn fs(in: VOut, @builtin(front_facing) ff: bool) -> GBufferOut {
  let wp = in.world;
  var n = normalize(in.normal);
  // Seen from behind (outside the lining, e.g. past a portal's edge).
  if (!ff && dot(n, F.cam.xyz - wp) < 0.0) { n = -n; }
  let world2 = wp.xz + F.misc.xy;
  let fine = vnoise(world2 * 13.0 + wp.y * 7.0);
  let mid = fbm2(world2 * 0.4 + vec2f(wp.y * 0.3), 3);
  let h = in.uv.x;
  let z = in.uv.y;
  let aaUV = fwidth(in.uv);

  var albedo: vec3f;
  var rough = 0.85;
  var spec = 0.5;
  var emit = vec3f(0.0);
  switch in.mat {
    case 0u: {
      // Walkway and curb: worn concrete.
      albedo = vec3f(0.42, 0.41, 0.39) * (0.8 + 0.3 * mid) * (0.9 + 0.2 * fine);
    }
    case 1u: {
      // Lower walls: glazed cream tiles, dirtied by traffic toward the
      // bottom (spray, soot).
      let g = grout(vec2f(z, h), vec2f(0.3, 0.15), 0.006, aaUV.yx);
      let grime = (1.0 - smoothstep(0.2, 1.8, h)) * 0.55 + 0.25 * mid;
      albedo = mix(vec3f(0.72, 0.68, 0.58), vec3f(0.22, 0.2, 0.18), saturate(grime));
      albedo = mix(albedo, vec3f(0.3, 0.29, 0.27), g * 0.8);
      rough = mix(0.22, 0.6, saturate(grime + g));
      spec = 0.8;
    }
    case 3u: {
      // Lamp strip: a housing with a fixture every TUNNEL_LAMP_SPACING m
      // (where tunnelLamps puts their light).
      albedo = vec3f(0.12);
      rough = 0.5;
      let f = abs(fract(z / TUNNEL_LAMP_SPACING + 0.5) - 0.5) * TUNNEL_LAMP_SPACING;
      let on = 1.0 - smoothstep(0.55, 0.6, f);
      emit = TUNNEL_LAMP_COLOR * F.tunnel.z * 1.6 * on;
    }
    case 4u: {
      // Portal headwall: cast concrete in panels, streaked by run-off.
      let g = grout(in.uv, vec2f(2.4, 1.2), 0.012, aaUV);
      let streak = vnoise(vec2f(in.uv.x * 3.0, 0.0)) * smoothstep(0.0, 6.0, TUNNEL_H + 2.0 - in.uv.y);
      albedo = vec3f(0.56, 0.54, 0.5) * (0.8 + 0.3 * mid) * (0.9 + 0.2 * fine);
      albedo *= 1.0 - 0.3 * g - 0.25 * streak;
    }
    default: {
      // Vault: sprayed concrete, sooty.
      albedo = vec3f(0.2, 0.19, 0.18) * (0.75 + 0.4 * mid) * (0.9 + 0.2 * fine);
    }
  }

  var sf: Surface;
  sf.albedo = albedo;
  sf.n = n;
  sf.rough = rough;
  sf.metal = 0.0;
  sf.ao = 1.0;
  sf.spec = spec;
  sf.sss = 0.0;
  let sh = sunShadow(wp, n) * cloudShadow(wp);
  var col = shadeSurface(sf, wp, sh) + emit;
  col = finishColor(col, wp);
  return gbuffer(col, wp, wp, n, rough);
}
