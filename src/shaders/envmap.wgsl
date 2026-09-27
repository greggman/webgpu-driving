// Environment map: sky (sky-view LUT) + clouds + moon above the horizon, a
// soft distant-hills band at the horizon, and lit ground below, written into
// an octahedral full-sphere map each frame, then box-filtered into mips so
// rough surfaces read blurrier reflections.

@group(1) @binding(0) var envOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(1) var envSrc: texture_2d<f32>;

fn envMoon(dir: vec3f) -> vec3f {
  let c = dot(dir, F.moon.xyz);
  return vec3f(1.0, 0.97, 0.9) * smoothstep(0.99985, 0.99992, c) * 1.6 * F.moon.w;
}

@compute @workgroup_size(8, 8)
fn build(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(envOut);
  if (any(id.xy >= dims)) { return; }
  let dir = octDecode((vec2f(id.xy) + 0.5) / vec2f(dims));
  let amb = shIrradiance(vec3f(0.0, 1.0, 0.0));
  let sunLit = F.sunColor.rgb * max(F.sun.y, 0.0) / PI;
    var col: vec3f;
  // Distance for the fog: the sky is far, the treeline ~1.5 km, the ground
  // where the ray meets it (else glossy paint mirrors a flat grey haze).
  var dist = 5000.0;
  if (dir.y >= 0.0) {
    col = skyRadiance(normalize(vec3f(dir.x, max(dir.y, 0.005), dir.z)));
    let cl = cloudLayer(dir, col);
    col = mix(col, cl.color, cl.alpha);
    col += envMoon(dir);
    // Distant hills / treeline in the lowest few degrees (hazed).
    let az = atan2(dir.x, dir.z);
        let ridge = 0.025 + 0.045 * (0.5 + 0.5 * sin(az * 5.0 + 1.3) * sin(az * 2.3));
        // A crisp treeline edge: glossy paint mirrors it as a horizon line.
    let band = smoothstep(ridge, ridge * 0.8, dir.y);
        let h0 = pal(6);
    let hills = mix(mix(vec3f(dot(h0, vec3f(0.3, 0.55, 0.15))), h0, 0.4) * (amb + sunLit) * 0.7, skyRadiance(normalize(vec3f(dir.x, 0.01, dir.z))), 0.35);
        col = mix(col, hills, band);
        dist = mix(5000.0, 700.0, band);
  } else {
        dist = min(1.3 / max(-dir.y, 1e-3), 400.0);
    let horizon = skyRadiance(normalize(vec3f(dir.x, 0.01, dir.z)));
        // Far ground is the biome's ground; steeply down (within a few metres,
    // under whatever is being reflected) it is road surface.
        // (Mostly desaturated: seen in reflections, a saturated ground tints
    // chrome and silver.)
    let g0 = pal(0);
    let far = mix(mix(vec3f(dot(g0, vec3f(0.3, 0.55, 0.15))), g0, 0.3), vec3f(0.12), 0.35);
    let ground = mix(far, vec3f(0.07, 0.07, 0.075), smoothstep(0.08, 0.35, -dir.y)) * (amb + sunLit);
    col = mix(horizon * 0.6, ground, saturate(-dir.y * 25.0));
  }
  if (F.fog.x > 0.0) {
    col = mix(fogColor(dir), col, fogTransmittance(F.cam.xyz + dir * dist));
  }
  textureStore(envOut, id.xy, vec4f(col, 1.0));
}

@compute @workgroup_size(8, 8)
fn downsample(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(envOut);
  if (any(id.xy >= dims)) { return; }
  let p = vec2i(id.xy) * 2;
  let s = textureLoad(envSrc, p, 0) + textureLoad(envSrc, p + vec2i(1, 0), 0)
        + textureLoad(envSrc, p + vec2i(0, 1), 0) + textureLoad(envSrc, p + vec2i(1, 1), 0);
  textureStore(envOut, id.xy, s * 0.25);
}
