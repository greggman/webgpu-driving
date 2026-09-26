# WebGPU Driving — Implementation Plan

This plan covers how to build what [DESIGN.md](DESIGN.md) describes. It is ordered so that a
runnable, testable build exists from the first milestone, and each milestone adds visible quality.

---

## 1. Guiding architecture decision: everything is road-relative

The design's constraints (one road, generally one direction, no leaving the road, no crashes)
are the core of the architecture:

- **The road is the world's spine.** The road is a procedurally generated centerline curve `C(s)`,
  where `s` is the arc length in meters. Every other system is keyed off `s`:
  - the car position is `(s, laneOffset)`
  - traffic is a list of `(s, lane, speed)`
  - terrain, scatter, bridges and cliffs are placed relative to the nearest `s`
- **The streaming window is 1D.** Content only has to exist for `s ∈ [s_cam − 300m, s_cam + 6km]`.
  Because the road trends in one direction (for example +Z with bounded lateral meander), the
  visible world is a long forward wedge. We never need a general 2D open-world streaming system.
- **The road trend works as a PVS.** Chunks are indexed by `s`-segment. Visibility is the segment
  range plus a frustum test on each segment's bounding box. Behind-camera segments are dropped
  except when a camera shot looks backward, and the camera director can tell the renderer ahead of
  time when one is coming.
- **Physics is trivial by construction.** There are no collisions. Traffic uses a car-following
  model (IDM) plus lane-change rules that only change lanes when the gap is safe. Car–car overlap
  is impossible by design, so it is never tested for.
- **Floating origin.** `s` is stored as a float64 on the CPU. The GPU world origin is rebased every
  ~1 km so f32 precision stays sub-millimeter near the camera.
- **Determinism.** A seeded PRNG plus a `(seed, biome, s, timeOfDay, camera shot)` tuple fully
  determines a frame. URL parameters can set this tuple, which is required for screenshot testing.

---

## 2. Tooling and project skeleton (Milestone 0)

```
webgpu-driving/
  index.html
  src/
    main.ts                 # bootstrap, adapter/device, main loop
    gpu/                    # device, resource helpers, bind-group layouts, pipeline cache, uniforms
    math/                   # vec/mat (hand-written, no libs), noise, PRNG, splines
    world/
      road.ts               # centerline generation, frames, elevation profile
      biomes/               # one file per environment (config + scatter rules)
      terrain.ts            # height function(s), clipmap/CDLOD driver
      scatter.ts            # grass/bush/tree/rock placement (GPU compute)
      streaming.ts          # s-window chunk management, PVS
    sim/
      car.ts                # player car kinematics, suspension spring
      traffic.ts            # IDM + lane-change
      autopilot.ts          # default self-driving behavior
      input.ts
    camera/
      director.ts           # shot selection + cuts
      shots/                # helicopter, chase, rig, interior, roadside, drone, wheel...
    gen/
      carBody.ts            # procedural car mesh
      interior.ts           # procedural cabin
      trees.ts, rocks.ts, cactus.ts, fence.ts, bridge.ts, flowers.ts, buildings.ts
    render/
      frame.ts              # frame graph / pass ordering
      sky/                  # atmosphere LUTs, clouds, stars, moon
      terrain/, road/, vegetation/, water/, cars/, particles/
      shadows.ts            # cascaded shadow maps
      post/                 # TAA, bloom, motion blur, DoF, tonemap, grading, flare, grain
    shaders/**/*.wgsl       # imported as text via esbuild loader
    dev/                    # window.__dev hooks, debug overlays, stats
  test/
    server.js               # express static server for dist/
    shoot.js                # puppeteer screenshot harness
    shots.json              # canonical shot list (biome × time × camera × s)
  .github/workflows/pages.yml
  .claude/agents/aaa-judge.md
```

Tasks:
1. `npm init` and add these dev dependencies: `typescript`, `esbuild`, `gts`, `@webgpu/types`,
   `express`, `puppeteer`. There are no runtime dependencies.
2. Set up `gts init`, and run `tsconfig` in strict mode with `@webgpu/types`.
3. Create `build.mjs` with esbuild. It uses the `.wgsl` loader `text`, a dev mode with
   `serve`/watch, and a prod mode that minifies to `dist/`.
4. Add these npm scripts: `build`, `dev`, `lint`, `fix`, `serve` (express), `shoot` (puppeteer),
   and `test` (lint + build + shoot + no-GPU-error assertion).
5. Add a GitHub Action (`pages.yml`). On push to `main` it runs `npm ci`, `npm run lint`, and
   `npm run build`, then `actions/upload-pages-artifact` and `actions/deploy-pages`.
6. Add a WebGPU bootstrap:
   - request `timestamp-query` and `float32-filterable` as optional features
   - set `device.lost` and `onuncapturederror` handlers that log in a form the harness can detect
   - use a resize observer and a DPR cap
7. Add a puppeteer harness that follows the pattern in `../webgpu-puppeteer/doom-shot.js`:
   - headless with no special arguments
   - wait for `window.__dev.ready`
   - pose through URL parameters
   - take an element screenshot, not `toDataURL`
   - fail on any `[gpu-error]` console line

**Exit criteria:** A cleared canvas deploys to GitHub Pages, and `npm test` produces a PNG locally.

---

## 3. WebGPU best practices to follow throughout

- Create pipelines asynchronously (`createRenderPipelineAsync`) behind a keyed cache. Use explicit
  bind-group layouts, grouped by update frequency: `@group(0)` frame, `@group(1)` pass/material,
  `@group(2)` object.
- Put all per-frame uniforms in one ring-buffered UBO written with a single `writeBuffer`. Store
  per-instance data in storage buffers.
- Do GPU-driven rendering for everything numerous (grass, trees, rocks, fence posts, traffic):
  compute culling writes compacted instance lists plus `drawIndexedIndirect` args. The CPU never
  iterates instances.
- Use reverse-Z with a `depth32float` depth buffer and an infinite far plane, which is essential
  for long vistas.
- Render into an HDR `rgba16float` target, with tonemapping as the final pass. Use MSAA only if
  TAA turns out insufficient. TAA is the default.
- Use `timestamp-query` per pass when available and surface it in the dev overlay.
- Avoid per-frame allocations: bind groups are created at stream-in time and recycled.

---

## 4. Milestone 1 — Road, car, and camera on flat ground

1. **Road generation** (`road.ts`)
   - Build the centerline as a chain of clothoid or Catmull-Rom segments. Heading is a
     low-frequency noise around a fixed global direction, clamped so the road never turns back
     more than ~70°.
   - The elevation profile is a smoothed version of terrain height with grade limits (≤8%).
   - Precompute rotation-minimizing frames (tangent, normal, binormal) and bank angle per meter.
   - Generate chunks lazily as `s` advances, and free them behind the camera.
2. **Road mesh:** extrude a road cross-section per chunk that includes lanes, shoulders, curbs,
   and ditches. The shader draws lane markings procedurally from `(s, d)` UVs:
   - dashed or solid lines
   - wear, cracks, tar snakes, and puddles
   - a dirt variant for the desert
3. **Player car sim:**
   - `speed` targets a cruise speed set by the autopilot or the player.
   - `laneOffset` eases toward the target lane with a critically damped spring.
   - Body pitch and roll come from a spring-damper driven by longitudinal and lateral
     acceleration (curvature × v²).
   - Wheel spin comes from speed, and steering angle from curvature.
4. **Input:** use arrow keys or WASD to change lanes and speed, `C` to cycle the camera, and
   `1–7` to switch biome. Autopilot resumes after idle.
5. **Camera director (first pass):**
   - chase cam
   - hood cam
   - a placeholder helicopter orbit
   - timed cuts with a minimum shot length

**Exit criteria:** A box car drives down an endless winding road, and camera cuts work.

---

## 5. Milestone 2 — Terrain with LOD

Use two techniques together:

1. **Near and mid terrain uses CDLOD, a quadtree with vertex morphing,** centered on the camera
   and biased forward along the road direction.
   - Height comes from a procedural height function evaluated in a compute shader and baked into
     tile height and normal textures (a texture array page cache). Vertex shaders sample those
     textures.
   - Morphing between LOD levels removes popping. Skirts hide T-junction cracks.
2. **Far terrain and mountains use a coarse geometry clipmap ring out to ~20 km** (desert vistas,
   coastal cliffs). It uses low-frequency height only, and blends into aerial perspective.

The **height function** is `H(x,z) = biomeHeight(x,z)` blended toward `roadElevation(s)` within a
corridor around the road, using `(s, d)` from a closest-point lookup:
- The lookup uses a baked 2D "road distance field" texture per streaming window. Compute generates
  it from the centerline, so terrain shaders never search the spline.
- The corridor falloff creates embankments. Where terrain is far above the road, the result is a
  cut with a rock wall material. Where terrain is far below, it becomes a fill or a **bridge**.

Other terrain work:
- **Material shading:** triplanar on steep slopes, and splatting by slope, height, and moisture
  noise, with per-biome palettes. Use a detail normal plus macro variation to break tiling.
  Textures are procedurally generated in compute at startup: grass, dirt, rock, sand, snow,
  and asphalt albedo/normal/roughness arrays with mips.
- **Structural features:**
  - Bridges are placed where `roadElevation − terrainHeight > threshold`, and use procedural
    girder, arch, or truss meshes.
  - Canyons come from the coast biome's height function carving along cross-road valleys.

---

## 6. Milestone 3 — Sky, atmosphere, and lighting (the "commercial look" foundation)

1. **Atmosphere** (Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere"):
   - The transmittance LUT, multi-scattering LUT, sky-view LUT (per frame), and aerial-perspective
     froxel volume (32³, per frame) are all compute passes.
   - It models Rayleigh and Mie scattering plus ozone absorption.
   - The sun disk has limb darkening, and the sun color comes from the transmittance LUT.
   - Aerial perspective is applied to all opaque geometry, which is what makes vistas feel huge.
2. **Clouds:** a 2D ray-marched cloud layer (weather-map noise, powder and silver-lining terms)
   is enough for a first pass. Volumetric clouds are a stretch goal.
3. **Time of day:** a sun and moon ephemeris driven by a `timeOfDay` parameter, with golden hour as
   the default for most biomes.
4. **Night:**
   - a star field from a procedural catalog with twinkle and a Milky Way band
   - a moon with phase and a procedural albedo, plus moonlight as a dim cool directional light
5. **Lighting model:**
   - PBR metal-roughness with a GGX specular and Lambert diffuse
   - IBL from the sky: SH9 irradiance plus a small prefiltered specular cubemap, rebuilt from the
     sky-view LUT when the sun moves
6. **Shadows:** 4 stable cascaded shadow maps with texel snapping, PCF or PCSS-lite filtering, and
   cascades fitted to the forward-heavy frustum. Distant vegetation uses a far-shadow heightmap.
7. **Ambient occlusion:** GTAO at half resolution, plus baked per-instance AO for vegetation.

---

## 7. Milestone 4 — Vegetation and scatter systems

Everything is GPU-driven and deterministic from world position (hash-based jittered grid), so
chunks can regenerate identically.

1. **Grass (frustum-based):**
   - Each frame, a compute pass iterates the grass tiles overlapping the camera frustum within
     ~150 m. It spawns blades by density from the biome map and terrain slope, excluding the road
     corridor. Distance-based density thinning uses a stable per-blade hash so blades fade rather
     than pop.
   - Blades are procedural curved strips with wind sway (a global wind field plus gusts) and
     per-blade color variation.
   - Beyond the blade range, a grass "fuzz" color on the terrain takes over.
2. **Bushes, flowers, crops, and hedges:** the same pipeline with a mesh LOD chain.
   - Crops are rows aligned to field polygons.
   - Hedges follow field boundaries and the roadside.
   - Flowers form dense clustered bands along the road.
3. **Trees and cacti:**
   - The meshes are procedurally generated (space colonization or L-system trunks plus leaf-card
     clusters), with 4–8 variants per species per biome.
   - LOD goes from full mesh to reduced mesh to **octahedral impostor**. Impostors are baked at
     startup by rendering each variant from 8×8 directions into an atlas.
4. **Rocks, fence posts and wires, telephone poles, mailboxes, farm buildings, and tumbleweeds:**
   - Fences and poles follow the road at offset `d`, placed per `s`. This is La Honda–style.
   - Tumbleweeds are simple physics bodies rolling with the wind, spawned ahead of the car.
5. **Culling:** compute culling covers the frustum, distance and LOD selection, and Hi-Z occlusion
   against the previous frame's depth pyramid (which matters in forest and canyon scenes). Output
   is indirect draws.

---

## 8. Milestone 5 — Procedural cars and interior

1. **Car body:**
   - Build the body by lofting a parametric set of cross-sections along the length (hood, cabin,
     trunk profiles). There are ~6 archetypes (sedan, hatch, SUV, pickup, wagon, coupe) with
     randomized proportions.
   - Subdivide once and smooth the normals, then cut the wheel arches.
   - Add procedural wheels (rim spokes, tire with sidewall), glass, lights, mirrors, and grille.
2. **Car paint:**
   - clearcoat layer and metallic flake (a noise normal in the base layer)
   - Fresnel reflections of the sky IBL
   - planar or screen-space reflections of the environment on the body; SSR with IBL fallback
     is enough
3. **Interior:**
   - Procedural cabin: dashboard, gauge cluster, steering wheel that rotates with steering angle,
     seats, A-pillars, headliner, and door cards
   - The gauges are drawn in the shader with a live speedometer and tachometer
   - The rear-view and side mirrors are a low-resolution secondary render (a reduced pass: terrain,
     road, and cars only)
   - Interior shots show exterior light and shadow leaking through, and the windshield has subtle
     reflections, dirt, and a rain or snow layer
4. **Traffic:**
   - Other cars get randomized archetype, paint, and plates. They are instanced and GPU-culled.
   - Same-direction and oncoming lanes both run IDM.
   - Lane changes follow MOBIL-lite rules and only happen when gaps are safe, so overlap cannot
     occur. The player's lane changes are also refused (the car hesitates) until the gap is safe.

---

## 9. Milestone 6 — The seven environments

Each biome is a config object with these fields:

```
{
  heightFn, roadProfile, palette, materials,
  scatterRules[], skyParams, timeOfDay, weather,
  props[], cameraShotWeights, colorGrade
}
```

| Biome | Key specific work |
|---|---|
| **Country road** | Rolling-hills FBM, field-polygon generation (Voronoi-based) with crops and hedges, farm buildings, lush grass |
| **Desert dirt road** | Dirt road shader with dust, ridged-noise mountains on the horizon, mesas, cacti, rocks, tumbleweeds, heat shimmer post effect, dust plume behind the car (GPU particles) |
| **Ocean coastline** | Terrain function sided by `d` (cliffs on one side, ocean on the other), canyons crossing the road, bridges. **Ocean:** FFT (or summed Gerstner) waves in compute, shoreline foam from terrain depth, subsurface tint, sky reflection plus SSR, spray |
| **Forest flower road** | Dense tall trees, which stress Hi-Z occlusion; flower bands, dappled light, volumetric light shafts (froxel fog lit by shadow map), falling leaves |
| **PA snowstorm** | Snow accumulation shader (world-up normal mask), GPU snow particles (~200k, camera-relative wrap volume, motion-stretched), heavy height fog, reduced visibility (use it to shrink the streaming window), snowy barns and bare trees, wipers in interior view, snow on windshield |
| **La Honda fence road** | Narrow two-lane road, redwoods and oaks, split-rail and barbed-wire fences, rolling golden grass hills, fog rolling in |
| **Night** | Uses any biome's world. Headlights are shadowed spotlights with a light cookie. Clustered forward lighting handles traffic head and tail lights, reflective lane markers (cat's eyes), stars, moon, and bloom and flare |

The renderer needs **clustered forward lighting** (froxel light lists) for night scenes. It lands in
this milestone.

---

## 10. Milestone 7 — Camera direction and post-processing (the "car commercial" layer)

1. **Camera director:**
   - Shots:
     - helicopter (high, sweeping, slow orbit)
     - drone flyover (passes the car)
     - chase rig (spring arm)
     - side tracking dolly
     - low bumper or wheel cam
     - roadside static (the car sweeps past, with a pan)
     - interior driver POV
     - passenger view looking out the side window
     - top-down
   - Shot choice is weighted by biome and upcoming road features: a vista ahead triggers the
     helicopter, a bridge triggers a roadside static, and tight curves trigger the chase.
   - Look-ahead along `s` lets the director pre-place roadside cameras and warn streaming about
     backward views.
   - Cuts have a minimum and maximum duration, and occasional slow crossfades.
   - Camera motion uses critically damped springs and handheld noise. Terrain and foliage
     collision is handled by raising the camera above `H(x,z)`.
2. **Post chain (all HDR):**
   - TAA with jittered projection and velocity buffer, which is also needed for grass stability
   - motion blur (per-object, from velocity)
   - bokeh DoF focused on the car for external shots
   - bloom (dual-filter downsample and upsample)
   - lens flare and ghosts from the sun or headlights
   - auto exposure (histogram in compute)
   - tonemap (AgX or ACES fit)
   - per-biome color-grade LUT (procedurally built 3D LUT)
   - vignette, chromatic aberration, and film grain, all subtle
   - optional letterbox for "commercial mode"

---

## 11. Testing and the AAA judge

1. **Deterministic screenshot harness** (`test/shoot.js`):
   - Starts the express server on `dist/` and launches puppeteer with no special arguments.
   - For each entry in `shots.json` it loads a URL like
     `?seed=1&biome=coast&s=4200&tod=18.5&cam=helicopter&freeze=1`, waits for
     `__dev.settled` (streaming idle plus N TAA frames), and element-screenshots to
     `screenshots/<name>.png`.
   - It also records GPU pass timings and errors to `screenshots/report.json`.
   - It fails if there are GPU validation errors, `device.lost` events, or all-black or all-one-color
     frames (a cheap histogram check).
2. **The AAA judge agent** is `.claude/agents/aaa-judge.md` and has read-only tools plus image
   reading. Its sole duty is to judge whether frames look like a AAA game or car commercial.
   - Input: the screenshot set, and optionally reference descriptions such as Slow Roads, Forza
     Horizon, and car-ad cinematography.
   - Output: a per-image score (0–10) on this rubric:
     - lighting and atmosphere
     - material quality
     - vegetation density and realism
     - LOD artifacts and popping
     - aliasing and shimmer
     - composition and cinematography
     - color grading
     - believability of scale
   - It also returns a ranked list of the **most impactful concrete fixes**.
   - It must not write code, only judge.
3. **Development loop:** after each milestone and each significant visual change, the flow is:
   1. build
   2. shoot
   3. aaa-judge
   4. implement the top fixes
   5. re-shoot

   Track judge scores over time in `screenshots/scores.json` so regressions are visible.
4. **Unit tests** (fast, Node, no GPU) cover the math and noise, road generation invariants (no
   backtracking, grade limits, smooth curvature), IDM and lane-change safety (no overlaps across
   long simulated runs), and determinism.

---

## 12. Performance budget

The target is 60 fps at 1080p on a mid-range laptop GPU (M-series or RTX 3060-class). Auto-scale
render resolution plus TAA upscaling if a frame exceeds 16.6 ms.

| Pass | Budget (ms) |
|---|---|
| Atmosphere LUTs, sky, clouds | 0.8 |
| Terrain (CDLOD, clipmap) | 1.5 |
| Grass and vegetation (cull and draw) | 4.0 |
| Cars, road, props | 1.5 |
| Shadows (4 cascades) | 3.0 |
| GTAO, fog, volumetrics | 1.5 |
| Water (coast only) | 1.0 |
| Post (TAA, DoF, bloom, tonemap) | 2.0 |

---

## 13. Milestone order and dependencies

```
M0 tooling ─► M1 road/car/camera ─► M2 terrain LOD ─► M3 sky/lighting ─► M4 vegetation
                                                           │                 │
                                                           └──► M5 cars/interior/traffic
                                                                             │
                              M6 biomes (one at a time: country → desert → coast → forest
                                         → La Honda → snow → night) ◄────────┘
                                                           │
                                                           ▼
                                              M7 director polish + post
```

The AAA-judge loop runs from M3 onward. Before M3 the judge has nothing meaningful to evaluate.

## 14. Main risks and mitigations

- **Grass and vegetation cost.** Use aggressive distance thinning, impostors, Hi-Z culling, and
  resolution scaling. Budget-test in the forest biome early.
- **Popping and LOD seams.** Use CDLOD morphing, dithered LOD cross-fades for meshes, and a
  hash-stable density fade. The judge rubric explicitly checks for this.
- **Precision over long drives.** Floating origin rebasing, plus an automated test that simulates
  a 100 km drive.
- **Headless WebGPU differences** (SwiftShader or Dawn in headless Chrome may be slow or lack
  features). Keep all features optional-with-fallback, and give the harness a
  `quality=low|high` switch.
- **Scope.** Every biome reuses the same systems and is data-driven. No biome-specific rendering
  paths except ocean, snow particles, and night lighting.

---

## Implementation status

All milestones (M0–M7) are implemented. Deviations from the plan:

- **Terrain materials:** detail and bump come from analytic gradient noise in the shaders
  rather than baked texture arrays. Leaf and needle cards *are* baked: a mipmapped texture
  array generated by compute at startup.
- **Terrain LOD:** the far "ring" is part of the same CDLOD quadtree, which samples an
  8-level height clipmap out to ±16 km. The coarse clipmap levels serve as the far terrain.
- **IBL:** diffuse is SH9 projected from the sky-view LUT. Specular samples the sky-view LUT
  directly; there is no prefiltered cubemap.
- **Car reflections:** a stylised "car commercial" environment (sky, treeline band, ground)
  instead of a runtime reflection probe or SSR.
- **Rear-view and side mirrors:** these reflect the environment term; there is no secondary
  render.
- **Additions not in the plan:**
  - froxel volumetric fog with shadowed sun shafts and headlight beams;
  - clustered light culling;
  - Hi-Z occlusion culling;
  - windshield snow and wipers;
  - heat shimmer;
  - a dust trail derived from the road path;
  - GPU timestamp profiling;
  - soak, perf and probe tools.

Quality loop: the `aaa-judge` agent reviewed the 10-shot gallery (`test/shots-gallery.json`)
three times. After each review, the top-ranked fixes were implemented. Overall scores moved
from 1.5–5.6 (round 1) to 4.6–7.0 (round 3). The verdict is still "Indie-quality": the
remaining gap is mostly car and cabin modelling detail and the lack of true screen-space or
probe reflections.

Performance (Apple GPU, 1280×720, headless Chrome): all seven environments run at 60 fps
with 7–11 ms of GPU time per frame.
