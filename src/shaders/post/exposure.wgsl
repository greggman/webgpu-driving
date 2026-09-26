// Auto exposure: log-luminance histogram of the HDR frame, then temporal
// adaptation toward a target exposure (center-weighted).
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> histo: array<atomic<u32>, 64>;
@group(0) @binding(3) var<storage, read_write> expo: array<f32, 4>; // exposure, avgLum, -, -
@group(0) @binding(4) var<uniform> ep: vec4f; // dt, reset, bias, -

const MIN_LOG = -8.0;
const MAX_LOG = 6.0;

@compute @workgroup_size(16, 16)
fn build(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(hdrTex);
  // Sample on a sparse grid (every 4th pixel).
  let p = id.xy * 4u;
  if (any(p >= dims)) { return; }
  let c = textureLoad(hdrTex, p, 0).rgb;
  let l = luminance(c);
  let uv = vec2f(p) / vec2f(dims);
  let w = 1.0 - saturate(length(uv - 0.5) * 1.2);
  if (l < 1e-5) {
    atomicAdd(&histo[0], u32(w * 4.0 + 1.0));
    return;
  }
  let t = saturate((log2(l) - MIN_LOG) / (MAX_LOG - MIN_LOG));
  let bin = u32(t * 62.0 + 1.0);
  atomicAdd(&histo[bin], u32(w * 4.0 + 1.0));
}

var<workgroup> counts: array<u32, 64>;

@compute @workgroup_size(64)
fn resolve(@builtin(local_invocation_index) li: u32) {
  counts[li] = atomicLoad(&histo[li]);
  atomicStore(&histo[li], 0u);
  workgroupBarrier();
  if (li == 0u) {
    var total = 0u;
    for (var i = 0u; i < 64u; i++) { total += counts[i]; }
    // Average of the 40%..90% percentile range.
    let lo = f32(total) * 0.4;
    let hi = f32(total) * 0.9;
    var acc = 0.0;
    var sum = 0.0;
    var wsum = 0.0;
    for (var i = 1u; i < 64u; i++) {
      let c = f32(counts[i]);
      let a0 = acc;
      acc += c;
      let take = max(0.0, min(acc, hi) - max(a0, lo));
      if (take > 0.0) {
        let logL = MIN_LOG + (f32(i) - 0.5) / 62.0 * (MAX_LOG - MIN_LOG);
        sum += logL * take;
        wsum += take;
      }
    }
    let avgLog = select(0.0, sum / max(wsum, 1.0), wsum > 0.0);
    let avgLum = exp2(avgLog);
    // Key value: mid-gray target, a little brighter in dark scenes.
    let key = 0.16 * ep.z;
    var tgt = key / max(avgLum, 1e-4);
    tgt = clamp(tgt, 0.02, 400.0);
    var cur = expo[0];
    if (ep.y > 0.5 || cur <= 0.0) {
      cur = tgt;
    } else {
      let speed = select(1.2, 2.5, tgt < cur);
      cur = cur + (tgt - cur) * (1.0 - exp(-ep.x * speed));
    }
    expo[0] = cur;
    expo[1] = avgLum;
  }
}
