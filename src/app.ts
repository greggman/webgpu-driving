// Application: world + simulation + camera director + renderer, URL
// parameters for deterministic screenshots, input, HUD and dev hooks.
import {Gpu} from './gpu/gpu';
import {Renderer, WorldCar} from './render/renderer';
import {BIOMES, BIOME_ORDER, Biome, BiomeId} from './world/biome';
import {Road} from './world/road';
import {Traffic} from './sim/traffic';
import {vehiclePose, Pose} from './sim/pose';
import {CameraState, Director, SHOT_KINDS, ShotKind} from './camera/director';
import {computeSky} from './world/sky';
import {carSpec} from './gen/car';
import {Tumbleweeds} from './sim/tumbleweeds';
import {SettingsPanel, loadStoredSettings} from './ui/settings';
import {DEFAULT_GRAPHICS} from './render/renderer';

export interface Params {
  biome: BiomeId;
  seed: number;
  s: number | null;
  tod: number | null;
  cam: ShotKind | null;
  shotTime: number | null;
  freeze: boolean;
  hud: boolean;
  eye: [number, number, number] | null;
  look: [number, number, number] | null;
  fov: number | null;
  timeScale: number;
}

export function parseParams(): Params {
  const q = new URLSearchParams(location.search);
  const biome = (q.get('biome') ?? 'country') as BiomeId;
  const cam = q.get('cam') as ShotKind | null;
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : null);
  return {
    biome: BIOME_ORDER.includes(biome) ? biome : 'country',
    seed: num('seed') ?? 1,
    s: num('s'),
    tod: num('tod'),
    cam: cam && SHOT_KINDS.includes(cam) ? cam : null,
    shotTime: num('t'),
    freeze: q.get('freeze') === '1',
    hud: q.get('hud') !== '0',
    eye: vec3Param(q.get('eye')),
    look: vec3Param(q.get('look')),
    fov: num('fov'),
    timeScale: num('speed') ?? 1,
  };
}

function vec3Param(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const a = v.split(',').map(Number);
  return a.length === 3 && a.every(x => isFinite(x))
    ? [a[0], a[1], a[2]]
    : null;
}

export class App {
  renderer: Renderer;
  biome!: Biome;
  road!: Road;
  traffic!: Traffic;
  director!: Director;
  tumbleweeds: Tumbleweeds | null = null;
  time = 0;
  private last = 0;
  private prevCam: CameraState | null = null;
  private prevPoses = new Map<number, Pose>();
  private hudEl = document.getElementById('hud')!;
  private keys = new Set<string>();
  private idle = 0;
  frames = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  fps = 0;

  constructor(
    private gpu: Gpu,
    public params: Params,
  ) {
    this.renderer = new Renderer(gpu);
    this.installInput();
    if (!params.hud) this.hudEl.classList.add('hidden');
    document.getElementById('regen')!.addEventListener('click', () => {
      void this.regenerate();
    });
    const stored = loadStoredSettings();
    this.renderer.graphics = {...DEFAULT_GRAPHICS, ...stored.graphics};
    if (stored.hud === false) this.hudEl.classList.add('hidden');
    this.settings = new SettingsPanel(this);
  }

  // True while a world is being generated (the frame loop pauses).
  busy = false;
  private loadingEl = document.getElementById('loading')!;
  private loadingLabel = document.getElementById('loading-label')!;
  private loadingBar = document.getElementById('loading-bar')!;
  private showingProgress = false;

  private setProgress(label: string, frac: number) {
    this.loadingEl.classList.add('visible');
    this.showingProgress = true;
    this.loadingLabel.textContent = label;
    this.loadingBar.style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
  }

  // Let the browser paint the progress bar between generation stages.
  private yieldToPaint(): Promise<void> {
    return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  }

  settings!: SettingsPanel;

  private onWorldChanged(id: BiomeId) {
    const url = new URL(location.href);
    url.searchParams.set('biome', id);
    history.replaceState(null, '', url);
    this.settings?.sync();
  }

  get hudHidden(): boolean {
    return this.hudEl.classList.contains('hidden');
  }

  setHudVisible(v: boolean) {
    this.hudEl.classList.toggle('hidden', !v);
  }

  setCruise(v: number) {
    this.biome.road.cruise = v;
    this.traffic.player.desired = v;
  }

  setCamera(kind: ShotKind | null) {
    this.director.forced = kind;
    this.director.cut(this.traffic.player.s, kind ?? undefined);
  }

  switchTo(id: BiomeId) {
    if (this.busy || id === this.biome?.id) return;
    this.params.s = null;
    this.params.tod = null;
    void this.generate(id);
  }

  // New world with a fresh random seed in the current environment.
  async regenerate() {
    if (this.busy) return;
    this.params.seed = Math.floor(Math.random() * 1e6) + 1;
    this.params.s = null;
    // Keep the user's scene tweaks across a new seed.
    const sky = {...this.biome.sky};
    const cruise = this.biome.road.cruise;
    const autopilot = this.traffic.autopilot;
    const forced = this.director.forced;
    await this.generate(this.biome.id);
    this.biome.sky.timeOfDay = sky.timeOfDay;
    this.biome.sky.clouds = sky.clouds;
    this.setCruise(cruise);
    this.traffic.autopilot = autopilot;
    if (forced) this.setCamera(forced);
    this.settings.sync();
  }

  async generate(id: BiomeId) {
    if (this.busy) return;
    this.busy = true;
    const name = BIOMES[id].name;
    this.setProgress(`${name}: shaping the land`, 0.05);
    await this.yieldToPaint();
    this.biome = structuredClone(BIOMES[id]);
    this.onWorldChanged(id);
    if (this.params.tod !== null) this.biome.sky.timeOfDay = this.params.tod;
    this.road = new Road(this.biome, this.params.seed);
    this.setProgress(`${name}: populating traffic`, 0.2);
    await this.yieldToPaint();
    const s0 = this.params.s ?? 800;
    this.traffic = new Traffic(this.biome, this.params.seed, s0);
    const ps = carSpec(this.traffic.player.kind);
    const roof = Math.max(...ps.top.map(p => p[1]));
    const eyeZ = (ps.roofFront + ps.roofBack) / 2 - 0.15;
    this.director = new Director(
      this.road,
      this.params.seed,
      this.biome.shotWeights,
    );
    // Aerial shots must clear the canopy (vegetation is GPU-scattered, so we
    // use a conservative per-biome height).
    this.director.driverEye = [
      eyeZ,
      0.37,
      Math.min(ps.belt + 0.27, roof - 0.14),
    ];
    const kinds = this.biome.scatter.treeKinds;
    this.director.canopy = kinds.includes('redwood')
      ? 55
      : kinds.includes('pine')
        ? 40
        : kinds.includes('cactus')
          ? 14
          : 25;
    if (this.params.eye) this.director.customEye = this.params.eye;
    if (this.params.look) this.director.customTarget = this.params.look;
    if (this.params.fov) this.director.customFov = this.params.fov;
    if (this.params.cam) {
      this.director.forced = this.params.cam;
      this.director.cut(s0, this.params.cam);
      if (this.params.shotTime !== null)
        this.director.setShotTime(this.params.shotTime);
    }
    // Let traffic settle into a natural arrangement before we start.
    for (let i = 0; i < 120; ++i) this.traffic.update(1 / 30);
    if (this.params.s !== null) this.traffic.player.s = this.params.s;
    this.setProgress(`${name}: growing trees and baking impostors`, 0.35);
    await this.yieldToPaint();
    this.renderer.setWorld(this.road, this.biome);
    this.tumbleweeds =
      this.biome.scatter.tumbleweeds > 0
        ? new Tumbleweeds(this.road, this.params.seed, 7)
        : null;
    this.prevCam = null;
    this.prevPoses.clear();
    this.setProgress(`${name}: streaming terrain`, 0.6);
    this.busy = false;
  }

  private installInput() {
    window.addEventListener('keydown', e => {
      // Don't steer the car while typing into the settings controls.
      const t0 = e.target as HTMLElement | null;
      if (t0 && t0.closest('input, select, textarea, #settings')) return;
      this.keys.add(e.key);
      this.idle = 0;
      const t = this.traffic;
      switch (e.key) {
        case 'ArrowLeft':
        case 'a':
          t.requestLane(1);
          break;
        case 'ArrowRight':
        case 'd':
          t.requestLane(-1);
          break;
        case 'ArrowUp':
        case 'w':
          t.adjustSpeed(2);
          break;
        case 'ArrowDown':
        case 's':
          t.adjustSpeed(-2);
          break;
        case 'c':
          this.director.forced = null;
          this.director.cut(t.player.s);
          break;
        case 'p':
          t.autopilot = !t.autopilot;
          this.settings.sync();
          break;
        case 'h':
          this.hudEl.classList.toggle('hidden');
          document.body.classList.toggle('ui-hidden');
          this.settings.close();
          break;
        case 'r':
          void this.regenerate();
          break;
        default: {
          const n = Number(e.key);
          if (n >= 1 && n <= BIOME_ORDER.length) {
            this.switchTo(BIOME_ORDER[n - 1]);
          }
        }
      }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.key));
  }

  frame(now: number) {
    if (this.busy || !this.traffic) return;
    if (this.showingProgress) {
      // Terrain clipmaps, road chunks and TAA/exposure warm up over the
      // first frames of a new world.
      const p = this.renderer.worldProgress;
      this.setProgress(this.loadingLabel.textContent ?? '', 0.6 + 0.4 * p);
      if (p >= 1) {
        this.showingProgress = false;
        this.loadingEl.classList.remove('visible');
      }
    }
    const dtReal = this.last ? Math.min((now - this.last) / 1000, 0.1) : 1 / 60;
    this.last = now;
    this.fpsAcc += dtReal;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    const dt = this.params.freeze ? 0 : dtReal * this.params.timeScale;
    this.time += dt;
    this.idle += dtReal;
    if (dt > 0) this.traffic.update(dt);
    if (this.tumbleweeds) {
      this.tumbleweeds.update(dt, this.traffic.player.s, this.time);
      this.renderer.props.dynamic = this.tumbleweeds.instances(this.time);
    } else {
      this.renderer.props.dynamic = [];
    }

    // Poses.
    const cars: WorldCar[] = [];
    const player = this.traffic.player;
    let playerPose: Pose | null = null;
    const lights =
      this.biome.headlights ||
      this.biome.sky.timeOfDay > 19.5 ||
      this.biome.sky.timeOfDay < 5.5;
    for (const v of this.traffic.vehicles) {
      const spec = carSpec(v.kind);
      const pose = vehiclePose(
        this.road,
        v,
        Math.max(dt, 1 / 120),
        spec.wheelbase,
      );
      if (dt > 0) v.spin += (v.speed * dt) / spec.wheelR;
      const prev = this.prevPoses.get(v.id) ?? null;
      this.prevPoses.set(v.id, pose);
      if (v === player) playerPose = pose;
      cars.push({
        draw: {
          kind: v.kind,
          color: v.color,
          spin: v.spin,
          steer: pose.steer,
          brake: v.brake,
          lights: lights ? 1 : 0,
          dirt:
            this.biome.id === 'desert' || this.biome.id === 'snow' ? 0.8 : 0.25,
        },
        pose,
        prevPose: prev,
        player: v === player,
      });
    }
    const pp = playerPose!;
    const camera0 = this.director.update(
      this.params.freeze && this.params.shotTime === null ? 0 : dt,
      pp,
      player.s,
      carSpec(player.kind).length,
    );
    const camera = camera0;
    this.renderer.exposureBias = camera.interior ? 0.45 : 1;
    for (const c of cars) if (c.player) c.draw.interior = camera.interior;
    const sky = computeSky(this.biome.sky, camera.eye[1]);
    this.renderer.render({
      camera,
      prevCamera: this.prevCam,
      sky,
      time: this.time,
      dt: dtReal,
      cars,
      playerS: player.s,
      playerD: player.d,
      player: pp,
      headlights: lights,
      frozen: this.params.freeze,
    });
    this.prevCam = camera;
    this.lastCamera = camera;
    this.frames++;
    if (this.frames % 10 === 0) this.updateHud(camera);
  }

  private updateHud(cam: CameraState) {
    const t = this.traffic;
    const kmh = Math.round(t.player.speed * 3.6);
    const st = this.renderer.stats;
    this.hudEl.textContent =
      `${this.biome.name}  ·  ${kmh} km/h  ·  ${cam.shot} cam  ·  ${this.fps.toFixed(0)} fps\n` +
      `←/→ lanes  ↑/↓ speed  C camera  R new world  P autopilot (${t.autopilot ? 'on' : 'off'})  1-7 environments  H hide\n` +
      `terrain nodes ${st.terrainNodes}  road chunks ${st.roadChunks}  cars ${st.cars}`;
  }

  lastCamera: CameraState | null = null;

  debugInfo(): object {
    const c = this.lastCamera;
    if (!c) return {};
    const g = this.road.groundHeight(c.eye[0], c.eye[2]);
    return {
      eye: c.eye.map(v => Math.round(v * 10) / 10),
      ground: Math.round(g * 10) / 10,
      carS: Math.round(this.traffic.player.s),
      cpuRoad: (() => {
        const i = this.road.info(c.eye[0], c.eye[2]);
        return [i.d, i.y].map(v => Math.round(v * 10) / 10);
      })(),
      gpuProbe: this.renderer.terrain.probeResult.map(
        v => Math.round(v * 10) / 10,
      ),
    };
  }

  get settled(): boolean {
    return !this.busy && !!this.traffic && this.renderer.settled;
  }
}
