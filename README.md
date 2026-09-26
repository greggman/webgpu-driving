# WebGPU Driving

A relaxing, endless, procedurally generated drive rendered with WebGPU and no libraries.
The world, the cars and the car interior are all procedural. The car drives itself and a
"car commercial" camera director cuts between helicopter, drone, chase, roadside, dolly,
wheel, hood and interior shots.

Seven environments: **country road**, **desert dirt road**, **ocean coastline**,
**forest flower road**, **Pennsylvania snowstorm**, **La Honda Road** and **night drive**.

## Controls

| Key | Action |
|---|---|
| ← / → (A / D) | change lanes (only when it's safe; you can't crash) |
| ↑ / ↓ (W / S) | speed up / slow down |
| C | next camera shot |
| R (or the ↻ button, top right) | generate a new world (new seed) |
| P | toggle autopilot |
| ⚙ (top left) | settings: environment, time of day, clouds, speed, camera, graphics toggles |
| 1 – 7 | switch environment |
| H | hide the HUD |

## URL parameters

Useful for sharing a view and for deterministic screenshots:

- `biome=country|desert|coast|forest|snow|lahonda|night`
- `seed=N`: world seed
- `s=N`: start distance along the road (m)
- `tod=H`: time of day (hours)
- `cam=chase|helicopter|drone|roadside|dolly|wheel|interior|passenger|topdown|hood|front|custom`
- `eye=f,l,u&look=f,l,u&fov=deg`: car-relative custom camera (with `cam=custom`)
- `t=N`: time into the camera shot
- `freeze=1`: stop the simulation clock (the renderer keeps running so TAA converges)
- `hud=0`: hide the HUD
- `speed=N`: simulation time scale (e.g. `speed=8` for soak testing)
- `debug=noterrain,nodof,nomb,nobody,novegshadow,nograss,nolod0,probe`: debugging toggles

## Development

```sh
npm install
npm run dev        # esbuild watch -> dist/
npm run serve      # express static server on http://localhost:8080
npm test           # wgsl check, typecheck, gts lint, build, unit tests, screenshots
```

Other tools:

- `npm run shoot [filter] -- --shots test/shots-gallery.json`: render deterministic
  screenshots (headless Chrome through puppeteer, no special flags) into `screenshots/`.
  The run fails on any `[gpu-error]` (every uncaptured WebGPU error is printed with that
  prefix), on page errors, and on blank frames.
- `node test/contact.js [filter]`: contact sheet of the screenshots.
- `node test/perf.js [biome...] [--debug flags]`: live frame rate and GPU pass timings
  (timestamp queries).
- `node test/probe.js "<query>" "<js expression>"`: evaluate an expression in a running
  page.
- `npm run soak`: drives several environments at 8× for about 8 km each (origin rebasing,
  streaming, clipmap recentering, camera cuts) and fails on any GPU or page error.
- `.claude/agents/aaa-judge.md`: an agent whose only job is to judge screenshots against
  AAA and car-commercial quality and rank fixes.

Deployment: `.github/workflows/pages.yml` builds and publishes `dist/` to GitHub Pages on
every push to `main`.

## Architecture

**The road is the world's spine.** Every system uses the road's arc length `s`.

- The road only trends forward (|heading| < max), so world z increases monotonically along
  it. The centerline is stored as `x(z), y(z), heading(z)`, every 2 m (`src/world/road.ts`).
- "Nearest road point" becomes two Newton steps on a 1D texture, on both the CPU and the
  GPU.
- The elevation is a grade-limited, twice box-filtered copy of the terrain along the
  centerline.
- Bridges appear where the ground falls well below the deck.

**Streaming along the road.** Content only exists in a 1D window along the road:
- road chunks: 400 m behind, 4.2 km ahead;
- props: 300 m behind, 1.6 km ahead;
- the GPU road texture: 4 km behind, 12 km ahead.

The world origin is rebased every 1 km, so f32 precision stays sub-millimetre near the
camera.

**Terrain LOD** (`src/render/terrain.ts`):
- **Height clipmaps:** 8 levels of 512², from 0.5 m to 64 m texels. They are computed by
  compute shaders from the same height function the CPU uses (`terrain.ts` ↔
  `terrain.wgsl`), and recentred as the camera moves.
- **Mesh:** a **CDLOD** quadtree of instanced 32×32 patches with vertex morphing.
- Level texel centres line up with patch vertices, so neighbouring LODs agree exactly.
- Far terrain is shadowed by ray-marching the heightfield.

**Atmosphere** (`src/shaders/atmo_*.wgsl`) follows Hillaire 2020:
- transmittance, multiple-scattering, sky-view and aerial-perspective LUTs;
- SH9 sky irradiance;
- a 2D cloud layer with cloud shadows;
- a sun disk, a moon and a star field.

**Vegetation**:
- **Scatter:** every frame a GPU compute pass visits world-aligned cells around the camera,
  picks a species from masked probabilities, frustum-culls it, and appends it to the
  instance list for LOD0 mesh, LOD1 mesh or **octahedral impostor**. The impostors are
  baked on the GPU from 64 hemi-octahedral views. The lists feed indirect draws.
- **Meshes:** trees, bushes, cacti and rocks are generated procedurally.
- **Grass:** frustum-based. The CPU picks visible 8 m tiles, densest near the camera, and a
  compute pass spawns hash-stable blades. Blades thin with distance and widen to keep
  coverage, including wheat, crops and wildflowers.

**Cars** (`src/gen/car.ts`, `src/gen/interior.ts`):
- **Bodies:** lofted from parametric cross-sections along six archetypes, with clear-coated
  metallic flake paint.
- **Details:** headlights, tail lights, grilles, wheel arches, door seams and procedural
  wheels come from shader logic.
- **Cabin:** a procedural dashboard with live gauges and a navigation screen, and a steering
  wheel that turns with the road.
- **Glass:** from inside, the glass becomes a windshield overlay with snow and wipers.

**Traffic** (`src/sim/traffic.ts`) cannot crash, by construction:
- IDM car-following, including head-on closing speeds;
- lane changes only into safe gaps;
- a final hard constraint that clamps any pair closer than the minimum gap.

The unit tests drive minutes of random input and assert that no two cars ever overlap.

**Post-processing:**
- SSAO → TAA (Catmull-Rom history with variance clipping) → per-pixel motion blur → bokeh
  depth of field focused on the car → histogram auto-exposure → bloom → lens flare → AgX
  tonemapping with a per-environment grade, vignette and grain.

**WebGPU practices:**
- every resource is labelled;
- the per-frame uniform is uploaded once;
- a shared bind group layout;
- reverse-Z with an infinite far plane;
- GPU-driven indirect draws for everything numerous;
- `timestamp-query` profiling when available.
