# CLAUDE.md

Notes for Claude Code sessions on this repo (any machine). README.md covers what the
project is and its architecture; this file covers how to work on it.

## Build and test

- `npm run build`: bundles to `dist/` (minified, WGSL comments stripped) and prints the
  gzipped size of what a visitor downloads. `npm run dev` rebuilds on change, unminified.
- `npm test`: WGSL reserved-word check, typecheck, lint, build, unit tests, screenshots
  (`test/shoot.js`) and key tests. It fails on any `[gpu-error]` console line, page
  error or blank frame.
- `node test/shoot.js [filter] [--out dir] [--shots file.json] [--params 'k=v&...']`
  screenshots entries of `test/shots.json` in headless Chrome (frozen, deterministic to
  ~0.1% of pixels). Use it to look at a change: write a small shots file in a scratch
  directory with the `biome`, `seed`, `s` (road position), `cam` you need.
- Useful URL params: `biome`, `seed`, `s`, `cam` (chase, helicopter, roadside, interior,
  front, custom with `eye`/`look`, ...), `freeze=1`, `hud=0`, `debug=...`.
- Comparing two renders: decode both PNGs in the page (puppeteer) and count pixels that
  differ by more than ~16; run-to-run noise is ~0.1-0.3%.

## WebGPU conventions

- Label every resource (buffers, textures, pipelines, bind groups, passes, modules).
- `uncapturederror` and shader compile errors print with a `[gpu-error]` prefix (the
  test harnesses fail on it). Pages without WebGPU show a "requires WebGPU" message.
- Shaders are fixed source files concatenated at startup (`src/render/shaders.ts`
  preludes); the WGSL is identical every run.

## Measuring performance

GPU timing drifts by a millisecond or more between runs of the same frame (clocks,
heat), so single runs mislead. Pin the world and A/B within one page:

- `npm run perf -- forest --params 'seed=1&s=600&freeze=1' --all`: frame rate, GPU
  span and per-pass timestamps. On Apple (tile-based) GPUs passes overlap, so only
  `span` is meaningful there; on discrete GPUs the per-pass numbers may be usable.
- `npm run ab -- 'biome=forest&seed=1&s=600&freeze=1' base noprepass nograss ...`
  switches the `debug` param in one page every 1.5 s and reports each variant's median
  GPU span (`base` = no flags). Build first. Prefer this for any < 2 ms question.
- Make sure the browser is on the intended GPU (`chrome://gpu`; laptops with switchable
  graphics may use the integrated one, headless Chrome may differ from the desktop one).
- Loading takes ~7 s (Windows/NVIDIA), so `perf` needs `--secs 12` or more, or it
  measures the warm-up. Both tools take `--size WxH` (default 1280x720); try 2560x1440
  too, since full-screen passes scale with it.
- A pass that doesn't run every frame keeps its last timing: `clipmap` shows 5-25 ms
  left over from start-up, but one level update costs ~0.1 ms.

`debug=` flags (comma separated): `noterrain`, `nograss`, `nolod0`/`1`/`2` (tree LODs;
2 = impostors), `novegshadow` (all) or `novegshadow0`..`3` (per cascade),
`fastleafshadow`, `noprepass`, `nodof`, `nomb`, `novol`, `nodetail`, `norock`,
`nomirror`, `probe`, `allbore` (all terrain with the tunnel-bore discard), `fullao` (SSAO at full resolution).

## Performance findings so far

### NVIDIA RTX 2070 Super (Windows 11, D3D12)

On this GPU a `discard` anywhere in a fragment shader makes the whole draw late-Z: every
layer is shaded, and early depth tests don't help (sorting tree triangles top-down
for the shadow pass gained nothing). So per-fragment cost in alpha-tested passes
counts in full.

- Vegetation shadows were 6.2 ms of a 10.6 ms forest frame (720p); cascades 0 and 1
  cost ~3 ms each, all fragment work (a 1x1 scissor left ~0.25 ms). Most of that was
  one `insts[]` storage load per fragment. Per-instance values now reach the fragment
  stage as flat varyings (`veg_mesh.wgsl`, `veg_impostor.wgsl`): forest 10.6 -> 8.6 ms.
  Opaque cards in cascades 0/1 would save ~2 ms more but lose the dappled shadows.
- Tree depth pre-pass: worth ~1.6 ms here (`noprepass` 11.0 vs 9.4), unlike on the M1.
- Grass computed two 4-octave fbm per fragment for a base colour that changes over tens
  of metres; now once per blade in the spawn pass (`grassMix`): forest grass
  1.15 -> 0.67 ms.
- Terrain: nodes away from tunnels draw with a `TERRAIN_BORE = false` pipeline (no
  discard), sorted near to far; at 1440p terrain 1.2-1.6 ms -> 0.4-0.7 ms.
- Impostors (`nolod2`) cost only ~0.1 ms in forest, so an impostor pre-pass isn't
  worth it here either.
- SSAO runs at half resolution (`fsHalf`, rg16float AO + distance) with a depth-aware
  upsample (`fsUp`): 1.1-1.3 ms saved at 1440p, screenshots within noise of `fullao`.
- Still open: SSR
  2.4 ms in snow at 1440p; forest cascades 0/1 (~2.5 ms each).

### Apple M1 (Metal)

All measured on an M1 Mac (Apple tile-based GPU, Metal). A tile-based GPU hides
overdraw and handles `discard` differently from a discrete immediate-mode GPU (e.g.
NVIDIA on Windows, D3D12), so treat the "no benefit" results as Mac-only and re-measure
them on other hardware rather than ruling them out.

- Leaf cards used to be two back-to-back quads; the second never won the depth test but
  was still shaded. Now one quad (`MeshBuilder.card`): forest roughly 13-15 ms -> 9-10 ms.
- Tree meshes (LOD0/1) draw a depth pre-pass (alpha test only, color writes masked),
  then shade with depth test `equal`, depth writes off and no `discard`
  (`fsPrepass`/`fsShade` in `veg_mesh.wgsl`; positions are `@invariant`). On the M1
  this gained only ~0.1-0.3 ms. Likely worth more on a discrete GPU.
- An equivalent pre-pass for the impostors (LOD2) gained nothing on the M1 and was
  reverted (not in git). On a discrete GPU, try it again: an `impostorAlpha` that sums
  the four atlas views' alpha for the pre-pass, and a no-discard shading entry point.
- Vegetation shadows: turning all of them off saved only ~0.3 ms on the M1 (frozen
  forest). With "Detailed leaf shadows" off, cascades from `OPAQUE_SHADOW_CASCADE` on
  draw cards without the alpha test (`fastleafshadow`).
- Terrain fragments `discard` inside tunnel bores (`terrain_draw.wgsl`); costless on the
  M1. (Now only for terrain near a tunnel; see the NVIDIA notes.)
- Forest remains the heaviest scene; at ~9 ms on the M1 most of its cost is outside the
  vegetation (post-processing, terrain, main pass).
