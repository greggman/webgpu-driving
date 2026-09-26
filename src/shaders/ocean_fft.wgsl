// Tessendorf FFT ocean (compute). Per cascade and frame:
//  spectrum: h(k,t) = h0(k) e^{iωt} + conj(h0(-k)) e^{-iωt}, plus the
//            displacement / slope / Jacobian spectra, packed as 4 complex
//            fields (two real fields per complex signal) in two buffers;
//  fft:      256-point inverse FFTs along rows then columns (shared-memory
//            radix-2, bit-reversed load);
//  assemble: displacement (Dx, h, Dz) and slope (sx, sz, sx²+sz², Jacobian)
//            textures; mips are built afterwards (slope² mips give the
//            sub-pixel slope variance used as roughness).

const N = 256u;

struct OceanParams {
  size: f32,     // tile size (m)
  time: f32,
  choppy: f32,
  vertical: u32, // fft direction
};

@group(0) @binding(0) var<uniform> OP: OceanParams;
@group(0) @binding(1) var<storage, read> h0: array<vec4f>;      // h0(k).xy, conj(h0(-k)).xy
@group(0) @binding(2) var<storage, read_write> bufA: array<vec4f>; // (h + iDx, Dz + isx)
@group(0) @binding(3) var<storage, read_write> bufB: array<vec4f>; // (sz + iJxx, Jzz + iJxz)
@group(0) @binding(4) var dispOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var slopeOut: texture_storage_2d<rgba16float, write>;

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
fn ci(a: vec2f) -> vec2f { return vec2f(-a.y, a.x); } // i * a

@compute @workgroup_size(16, 16)
fn spectrum(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(N))) { return; }
  let idx = id.y * N + id.x;
  let n = vec2f(f32(id.x), f32(id.y)) - f32(N / 2u);
  let k = n * (6.2831853 / OP.size);
  let kl = max(length(k), 1e-5);
  let w = sqrt(9.81 * kl);
  let e = vec2f(cos(w * OP.time), sin(w * OP.time));
  let s = h0[idx];
  let h = cmul(s.xy, e) + cmul(s.zw, vec2f(e.x, -e.y));
  let dx = ci(h) * (-k.x / kl);
  let dz = ci(h) * (-k.y / kl);
  let sx = ci(h) * k.x;
  let sz = ci(h) * k.y;
  let jxx = h * (k.x * k.x / kl);
  let jzz = h * (k.y * k.y / kl);
  let jxz = h * (k.x * k.y / kl);
  bufA[idx] = vec4f(h + ci(dx), dz + ci(sx));
  bufB[idx] = vec4f(sz + ci(jxx), jzz + ci(jxz));
}

var<workgroup> sh: array<vec4f, 512>;

fn addr(line: u32, p: u32) -> u32 {
  return select(line * N + p, p * N + line, OP.vertical == 1u);
}

fn fftLine(t: u32, line: u32, useB: bool) {
  let rev = reverseBits(t) >> 24u;
  if (useB) { sh[t] = bufB[addr(line, rev)]; } else { sh[t] = bufA[addr(line, rev)]; }
  workgroupBarrier();
  var src = 0u;
  var dst = 256u;
  for (var s = 0u; s < 8u; s++) {
    let m = 2u << s;
    let half = m >> 1u;
    let pos = t % m;
    let blk = t - pos;
    let j = pos % half;
    let a = sh[src + blk + j];
    let b = sh[src + blk + j + half];
    let ang = 6.2831853 * f32(j) / f32(m);
    let w = vec2f(cos(ang), sin(ang));
    let wb = vec4f(cmul(w, b.xy), cmul(w, b.zw));
    sh[dst + t] = select(a + wb, a - wb, pos >= half);
    workgroupBarrier();
    let tmp = src;
    src = dst;
    dst = tmp;
  }
  if (useB) { bufB[addr(line, t)] = sh[src + t]; } else { bufA[addr(line, t)] = sh[src + t]; }
}

@compute @workgroup_size(256)
fn fftA(@builtin(local_invocation_index) t: u32, @builtin(workgroup_id) wg: vec3u) {
  fftLine(t, wg.x, false);
}

@compute @workgroup_size(256)
fn fftB(@builtin(local_invocation_index) t: u32, @builtin(workgroup_id) wg: vec3u) {
  fftLine(t, wg.x, true);
}

@compute @workgroup_size(16, 16)
fn assemble(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(N))) { return; }
  let idx = id.y * N + id.x;
  // Undo the centred-spectrum shift.
  let sgn = select(1.0, -1.0, ((id.x + id.y) & 1u) == 1u);
  let a = bufA[idx] * sgn;
  let b = bufB[idx] * sgn;
  let h = a.x;
  let dx = a.y;
  let dz = a.z;
  let sx = a.w;
  let sz = b.x;
  let jxx = b.y;
  let jzz = b.z;
  let jxz = b.w;
  let l = OP.choppy;
  let jac = (1.0 + l * jxx) * (1.0 + l * jzz) - l * l * jxz * jxz;
  textureStore(dispOut, id.xy, vec4f(dx * l, h, dz * l, 0.0));
  textureStore(slopeOut, id.xy, vec4f(sx, sz, sx * sx + sz * sz, jac));
}

// Mip generation (box filter) for the displacement / slope textures.
@group(0) @binding(6) var mipSrc: texture_2d<f32>;
@group(0) @binding(7) var mipDst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn mip(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(mipDst);
  if (any(id.xy >= dims)) { return; }
  let p = vec2i(id.xy) * 2;
  let s = textureLoad(mipSrc, p, 0) + textureLoad(mipSrc, p + vec2i(1, 0), 0)
        + textureLoad(mipSrc, p + vec2i(0, 1), 0) + textureLoad(mipSrc, p + vec2i(1, 1), 0);
  textureStore(mipDst, id.xy, s * 0.25);
}
