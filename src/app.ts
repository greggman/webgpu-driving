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
    this.setBiome(params.biome);
    this.installInput();
    if (!params.hud) this.hudEl.classList.add('hidden');
  }

  setBiome(id: BiomeId) {
    const base = BIOMES[id];
    this.biome = structuredClone(base);
    if (this.params.tod !== null) this.biome.sky.timeOfDay = this.params.tod;
    this.road = new Road(this.biome, this.params.seed);
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
    this.renderer.setWorld(this.road, this.biome);
    this.prevCam = null;
    this.prevPoses.clear();
    // Let traffic settle into a natural arrangement before we start.
    for (let i = 0; i < 120; ++i) this.traffic.update(1 / 30);
    if (this.params.s !== null) this.traffic.player.s = this.params.s;
  }

  private installInput() {
    window.addEventListener('keydown', e => {
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
          break;
        case 'h':
          this.hudEl.classList.toggle('hidden');
          break;
        default: {
          const n = Number(e.key);
          if (n >= 1 && n <= BIOME_ORDER.length) {
            this.params.s = null;
            this.params.tod = null;
            this.setBiome(BIOME_ORDER[n - 1]);
          }
        }
      }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.key));
  }

  frame(now: number) {
    const dtReal = this.last ? Math.min((now - this.last) / 1000, 0.1) : 1 / 60;
    this.last = now;
    this.fpsAcc += dtReal;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    const dt = this.params.freeze ? 0 : dtReal;
    this.time += dt;
    this.idle += dtReal;
    if (dt > 0) this.traffic.update(dt);

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
      player: pp,
      headlights: lights,
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
      `←/→ lanes  ↑/↓ speed  C camera  P autopilot (${t.autopilot ? 'on' : 'off'})  1-7 environments  H hide\n` +
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
    return this.renderer.settled;
  }
}
