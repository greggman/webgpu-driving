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

`debug=` flags (comma separated): `noterrain`, `nograss`, `nolod0`/`1`/`2` (tree LODs;
2 = impostors), `novegshadow` (all) or `novegshadow0`..`3` (per cascade),
`fastleafshadow`, `noprepass`, `nodof`, `nomb`, `novol`, `nodetail`, `norock`,
`nomirror`, `probe`.

## Performance findings so far

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
  forest). Far cascades already draw cards without the alpha test (`fastleafshadow`,
  `OPAQUE_SHADOW_CASCADE`).
- Terrain fragments `discard` inside tunnel bores (`terrain_draw.wgsl`); costless on the
  M1 but it can disable early depth on other GPUs. If terrain looks expensive
  elsewhere, check this first (it could become a separate pipeline used only while a
  tunnel is near).
- Forest remains the heaviest scene; at ~9 ms on the M1 most of its cost is outside the
  vegetation (post-processing, terrain, main pass).
