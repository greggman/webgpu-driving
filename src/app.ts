// Application: world + simulation + camera director + renderer, URL
// parameters for deterministic screenshots, input, HUD and dev hooks.
import {Gpu} from './gpu/gpu';
import {Renderer, WorldCar} from './render/renderer';
import {BIOMES, BIOME_ORDER, Biome, BiomeId} from './world/biome';
import {Road} from './world/road';
import {Traffic, Vehicle} from './sim/traffic';
import {vehiclePose, Pose} from './sim/pose';
import {CameraState, Director, SHOT_KINDS, ShotKind} from './camera/director';
import {computeSky} from './world/sky';
import {CAR_KINDS, CarKind, carSpec, driverZ, semiLayout} from './gen/car';
import {Tumbleweeds} from './sim/tumbleweeds';
import {
  SHOT_NAMES as SHOT_LABELS,
  SettingsPanel,
  loadStoredSettings,
} from './ui/settings';
import {
  DEFAULT_GRAPHICS,
  LOW_POWER_GRAPHICS,
  isMobileDevice,
} from './render/renderer';

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
  // Showroom: one parked car, no traffic, a fixed view (for judging cars).
  showroom: boolean;
  car: string | null;
  paint: string | null;
  view: string | null;
}

// Showroom camera views: car-local eye / target (forward, left, up), fov.
const SHOWROOM_VIEWS: Record<string, [number[], number[], number]> = {
  front34: [[5.2, 3.3, 1.25], [0, 0, 0.62], 34],
  rear34: [[-5.2, 3.1, 1.3], [0, 0, 0.62], 34],
  side: [[0.2, 7.0, 0.95], [0.2, 0, 0.7], 36],
  wheel: [[2.5, 1.95, 0.5], [1.35, 0.8, 0.38], 40],
  top34: [[4.2, -4.2, 3.6], [0, 0, 0.45], 36],
  front: [[7.5, 0.0, 1.0], [0, 0, 0.7], 30],
  // Near-orthographic "blueprint" views (long lens from far away).
  'bp-side': [[0, 40, 0.75], [0, 0, 0.75], 4.2],
  'bp-front': [[40, 0, 0.75], [0, 0, 0.75], 4.2],
  'bp-rear': [[-40, 0, 0.75], [0, 0, 0.75], 4.2],
  'bp-top': [[-0.6, 0, 40], [0, 0, 0], 7.6],
};

const PAINTS: Record<string, [number, number, number, number]> = {
  red: [0.42, 0.01, 0.008, 0.15], // solid red: barely metallic
  blue: [0.02, 0.09, 0.25, 0.75],
  silver: [0.62, 0.62, 0.6, 0.85],
  white: [0.75, 0.74, 0.7, 0.45],
  black: [0.01, 0.01, 0.012, 0.6],
  orange: [0.55, 0.22, 0.03, 0.8],
  green: [0.03, 0.18, 0.08, 0.7],
};

export function parseParams(): Params {
  const q = new URLSearchParams(location.search);
  // With no ?biome= (e.g. a shared link) start somewhere random.
  const requested = q.get('biome') as BiomeId | null;
  const known = requested !== null && BIOME_ORDER.includes(requested);
  const biome: BiomeId = known
    ? requested
    : BIOME_ORDER[Math.floor(Math.random() * BIOME_ORDER.length)];
  const cam = q.get('cam') as ShotKind | null;
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : null);
  return {
    biome,
    // Explicit environments (tests, deliberate links) default to seed 1;
    // random starts also get a random world.
    seed: num('seed') ?? (known ? 1 : Math.floor(Math.random() * 1e6) + 1),
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
    showroom: q.get('showroom') === '1',
    car: q.get('car'),
    paint: q.get('paint'),
    view: q.get('view'),
  };
}

function vec3Param(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const a = v.split(',').map(Number);
  return a.length === 3 && a.every(x => isFinite(x))
    ? [a[0], a[1], a[2]]
    : null;
}

const ORBIT_FOCUS_MAX = 10; // m the orbit focus may move from the car

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
  private playerKind: CarKind | null = null;
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
    this.installOrbit();
    if (!params.hud) {
      // hud=0 (screenshots): hide all on-screen UI.
      this.hudEl.classList.add('hidden');
      document.body.classList.add('ui-hidden');
    }
    document
      .getElementById('next-camera')!
      .addEventListener('click', () => this.traffic && this.nextCamera());
    document
      .getElementById('next-car')!
      .addEventListener('click', () => this.traffic && this.nextCar());
    document
      .getElementById('next-world')!
      .addEventListener('click', () => this.traffic && this.nextBiome());
    document.getElementById('regen')!.addEventListener('click', () => {
      void this.regenerate();
    });
    const stored = loadStoredSettings();
    // First visit on a phone: start in low-power mode.
    const base =
      !stored.graphics && isMobileDevice()
        ? LOW_POWER_GRAPHICS
        : DEFAULT_GRAPHICS;
    this.renderer.graphics = {...base, ...stored.graphics};
    if (stored.hud === false) this.hudEl.classList.add('hidden');
    this.settings = new SettingsPanel(this);
  }

  // True while a world is being generated (the frame loop pauses).
  busy = false;
  private loadingEl = document.getElementById('loading')!;
  private loadingLabel = document.getElementById('loading-label')!;
  private loadingBar = document.getElementById('loading-bar')!;
  showingProgress = false;
  private loadingNote = document.getElementById('loading-note')!;

  // Fraction of the bar already used before world generation (start-up
  // shader compilation); generation fills the rest.
  progressStart = 0;

  setProgress(label: string, frac0: number, note = '') {
    const frac = this.progressStart + frac0 * (1 - this.progressStart);
    this.loadingNote.textContent = note;
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
    void id;
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

  // Driver eye in car-local (forward, left, up) from the car's proportions.
  private updateDriverEye() {
    const ps = carSpec(this.traffic.player.kind);
    this.director.driverEye = [
      driverZ(ps),
      0.37,
      ps.kind === 'bus'
        ? ps.belt + 0.7
        : Math.min(ps.belt + 0.27, ps.roofY - 0.14),
    ];
  }

  // Player car: index into CAR_KINDS (kept across environments).
  setPlayerCar(kind: CarKind) {
    this.playerKind = kind;
    this.traffic.setPlayerKind(kind);
    this.updateDriverEye();
    this.settings.sync();
  }

  get playerCar(): CarKind {
    return this.traffic.player.kind;
  }

  // Cycle: auto director, then each shot in turn (C / camera button).
  nextCamera() {
    const order: Array<ShotKind | null> = [
      null,
      ...SHOT_KINDS.filter(k => k !== 'custom'),
    ];
    const i = order.indexOf(this.director.forced);
    const next = order[(i + 1) % order.length];
    this.setCamera(next);
    this.settings.sync();
    this.toast(`Camera: ${next ? SHOT_LABELS[next] : 'auto director'}`);
  }

  // Cycle the player's vehicle (V / car button).
  nextCar() {
    const i = CAR_KINDS.indexOf(this.traffic.player.kind);
    const k = (i + 1) % CAR_KINDS.length;
    this.setPlayerCar(CAR_KINDS[k]);
    this.toast(`Car ${k + 1}`);
  }

  // Cycle the environments (B / world button).
  nextBiome() {
    if (this.busy) return;
    const i = BIOME_ORDER.indexOf(this.biome.id);
    const next = BIOME_ORDER[(i + 1) % BIOME_ORDER.length];
    this.toast(BIOMES[next].name);
    this.switchTo(next);
  }

  // Dashboard gauges: speed in km/h with a little flutter, and engine rpm
  // from a simple 6-speed gearbox (smoothed so the needle swings).
  private gaugeState = [0, 800];
  private gauges(speed: number, accel: number, dt: number): number[] {
    const kmh = speed * 3.6;
    const t = this.time;
    const shift = [0, 18, 35, 55, 80, 110, 1e9];
    let gear = 1;
    while (kmh > shift[gear] && gear < 6) gear++;
    const lo = shift[gear - 1],
      hi = Math.min(shift[gear], 170);
    const frac = Math.max(0, Math.min(1, (kmh - lo) / Math.max(hi - lo, 1)));
    let rpm = kmh < 3 ? 850 : 1500 + frac * 2600 + Math.max(accel, 0) * 250;
    rpm += Math.sin(t * 7.3) * 40 + Math.sin(t * 2.1) * 60;
    const target = [
      kmh + Math.sin(t * 1.7) * 0.6 + Math.sin(t * 4.3) * 0.3,
      rpm,
    ];
    const k = 1 - Math.exp(-Math.max(dt, 0) * 6);
    for (let i = 0; i < 2; ++i)
      this.gaugeState[i] += (target[i] - this.gaugeState[i]) * k;
    if (dt === 0) return target;
    return [...this.gaugeState];
  }

  private toastTimer = 0;
  private toast(text: string) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(
      () => el.classList.remove('visible'),
      1200,
    );
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

  // Showroom: only the player's car, parked, chosen body/paint, fixed view.
  private setupShowroom() {
    const t = this.traffic;
    const p = t.player;
    if (this.params.car && CAR_KINDS.includes(this.params.car as CarKind)) {
      t.setPlayerKind(this.params.car as CarKind);
      this.updateDriverEye();
    }
    if (this.params.paint && PAINTS[this.params.paint])
      p.color = PAINTS[this.params.paint];
    t.vehicles = [p];
    t.autopilot = false;
    p.speed = 0;
    p.desired = 0;
    p.accel = 0;
    p.pitch = p.roll = p.pitchVel = p.rollVel = p.latVel = 0;
    const view = this.params.view ?? 'front34';
    if (view === 'interior') {
      this.director.forced = 'interior';
      this.director.cut(p.s, 'interior');
    } else {
      const v = SHOWROOM_VIEWS[view] ?? SHOWROOM_VIEWS.front34;
      // Scale the framing to the vehicle; a semi rig is framed around its
      // middle (the pose is the tractor's).
      const sp = carSpec(p.kind);
      const k = view === 'wheel' ? 1 : Math.max(1, p.length / 4.8);
      const ky = view === 'wheel' ? 1 : Math.max(1, sp.roofY / 1.45);
      const mid = p.kind === 'semi' ? -semiLayout().tractor : 0;
      this.director.customEye = [v[0][0] * k + mid, v[0][1] * k, v[0][2] * ky];
      this.director.customTarget = [
        v[1][0] * k + mid,
        v[1][1] * k,
        v[1][2] * ky,
      ];
      this.director.customFov = v[2];
      this.director.forced = 'custom';
      this.director.cut(p.s, 'custom');
    }
  }

  // Load-time profile (logged with ?debug=timing).
  timings: Array<[string, number]> = [];
  private mark(label: string) {
    this.timings.push([label, Math.round(performance.now())]);
    if (location.search.includes('timing')) {
      console.log(`[timing] ${label} ${Math.round(performance.now())}`);
    }
  }

  async generate(id: BiomeId) {
    if (this.busy) return;
    this.busy = true;
    const name = BIOMES[id].name;
    this.setProgress(`${name}: shaping the land`, 0.05);
    await this.yieldToPaint();
    this.mark('generate start');
    this.biome = structuredClone(BIOMES[id]);
    this.onWorldChanged(id);
    if (this.params.tod !== null) this.biome.sky.timeOfDay = this.params.tod;
    this.road = new Road(this.biome, this.params.seed);
    this.setProgress(`${name}: populating traffic`, 0.2);
    await this.yieldToPaint();
    this.mark('road done');
    const s0 = this.params.s ?? 800;
    this.traffic = new Traffic(this.biome, this.params.seed, s0);
    if (!this.playerKind && CAR_KINDS.includes(this.params.car as CarKind))
      this.playerKind = this.params.car as CarKind;
    if (this.playerKind) this.traffic.setPlayerKind(this.playerKind);
    const keepForced = this.director?.forced ?? null;
    this.director = new Director(
      this.road,
      this.params.seed,
      this.biome.shotWeights,
    );
    // Aerial shots must clear the canopy (vegetation is GPU-scattered, so we
    // use a conservative per-biome height).
    this.updateDriverEye();
    const fence = this.biome.road.fence;
    this.director.fence =
      fence === 'none'
        ? null
        : fence === 'guardrail'
          ? {offset: this.road.halfWidth + 0.7, top: 0.8}
          : {offset: this.road.halfWidth + 3.2, top: 1.4};
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
    } else if (keepForced) {
      // Switching environments keeps the chosen camera.
      this.director.forced = keepForced;
      this.director.cut(s0, keepForced);
    }
    // Let traffic settle into a natural arrangement before we start.
    for (let i = 0; i < 120; ++i) this.traffic.update(1 / 30);
    if (this.params.s !== null) this.traffic.player.s = this.params.s;
    if (this.params.showroom) this.setupShowroom();
    this.setProgress(`${name}: growing trees and baking impostors`, 0.35);
    await this.yieldToPaint();
    this.mark('traffic done');
    this.mark('setWorld');
    this.renderer.setWorld(this.road, this.biome);
    this.tumbleweeds =
      this.biome.scatter.tumbleweeds > 0
        ? new Tumbleweeds(this.road, this.params.seed, 7)
        : null;
    this.prevCam = null;
    this.prevPoses.clear();
    this.setProgress(
      `${name}: warming up the GPU`,
      0.6,
      'The first time can take 10-30 seconds on phones.',
    );
    this.busy = false;
    this.mark('world ready (setWorld done)');
  }

  private installInput() {
    window.addEventListener('keydown', e => {
      // Don't steer the car while typing into the settings controls.
      const t0 = e.target as HTMLElement | null;
      if (t0 && t0.closest('input, select, textarea, #settings')) return;
      this.keys.add(e.key);
      this.idle = 0;
      const t = this.traffic;
      // Orbit camera: the arrows move the focus point around the car
      // (W/A/S/D still drive).
      if (this.director.forced === 'orbit' && e.key.startsWith('Arrow')) {
        const f = this.director.orbit.focus;
        const step = 0.5;
        if (e.key === 'ArrowLeft') f[1] += step;
        if (e.key === 'ArrowRight') f[1] -= step;
        if (e.key === 'ArrowUp') f[e.shiftKey ? 2 : 0] += step;
        if (e.key === 'ArrowDown') f[e.shiftKey ? 2 : 0] -= step;
        f[2] = Math.max(0.2, f[2]);
        const r = Math.hypot(f[0], f[1], f[2] - 0.8);
        if (r > ORBIT_FOCUS_MAX) {
          const k = ORBIT_FOCUS_MAX / r;
          f[0] *= k;
          f[1] *= k;
          f[2] = 0.8 + (f[2] - 0.8) * k;
        }
        e.preventDefault();
        return;
      }
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
          this.nextCamera();
          break;
        case 'v':
          this.nextCar();
          break;
        case 'b':
          this.nextBiome();
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

  // The trailer behind a semi: its own pose along the lane (with its own
  // body springs), drawn as a separate vehicle part.
  private trailers = new Map<number, Vehicle>();
  private trailerFor(
    v: Vehicle,
    dt: number,
    lights: boolean,
    offset: number,
  ): WorldCar {
    let t = this.trailers.get(v.id);
    if (!t) {
      t = {...v, roll: 0, rollVel: 0, pitch: 0, pitchVel: 0, bump: undefined};
      this.trailers.set(v.id, t);
    }
    t.s = v.s + v.dir * offset;
    t.d = v.d;
    t.dir = v.dir;
    t.speed = v.speed;
    t.accel = v.accel;
    t.latVel = v.latVel;
    const spec = carSpec('trailer');
    const pose = vehiclePose(
      this.road,
      t,
      Math.max(dt, 1 / 120),
      spec.wheelbase,
      spec.track,
    );
    pose.steer = 0;
    const id = v.id + 1e6;
    const prev = this.prevPoses.get(id) ?? null;
    this.prevPoses.set(id, pose);
    const white = [0.75, 0.76, 0.77, 0.05] as [number, number, number, number];
    return {
      draw: {
        kind: 'trailer',
        color: v.id % 3 === 0 ? v.color : white,
        spin: v.spin * (carSpec('semi').wheelR / spec.wheelR),
        steer: 0,
        brake: v.brake,
        lights: lights ? 1 : 0,
        dirt: 0.3,
      },
      pose,
      prevPose: prev,
      player: false,
      id,
      s: t.s,
      d: t.d,
      dir: t.dir,
      length: spec.length,
      track: spec.track,
      speed: v.speed,
    };
  }

  // Drag (mouse / one finger) orbits the car, wheel / pinch dollies; the
  // first drag switches to the orbit camera starting from the current view.
  private installOrbit() {
    const cv = this.gpu.canvas;
    cv.style.touchAction = 'none';
    const pts = new Map<number, {x: number; y: number}>();
    let pinch = 0;
    const ensureOrbit = () => {
      if (this.director.forced === 'orbit') return;
      if (this.lastCamera && this.lastPose)
        this.director.orbitFrom(this.lastCamera.eye, this.lastPose);
      this.setCamera('orbit');
      this.settings.sync();
    };
    const spread = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    cv.addEventListener('pointerdown', e => {
      pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
      cv.setPointerCapture(e.pointerId);
      if (pts.size === 2) pinch = spread();
    });
    cv.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x,
        dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (!this.traffic || this.busy) return;
      const o = this.director.orbit;
      if (pts.size === 1) {
        if (Math.abs(dx) + Math.abs(dy) < 1) return;
        ensureOrbit();
        o.yaw -= dx * 0.006;
        o.pitch = Math.max(-0.05, Math.min(1.45, o.pitch + dy * 0.005));
      } else if (pts.size === 2) {
        const sp = spread();
        if (pinch > 0 && sp > 0) {
          ensureOrbit();
          o.dist = Math.max(2.5, Math.min(40, (o.dist * pinch) / sp));
        }
        pinch = sp;
      }
      this.idle = 0;
    });
    const end = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch = pts.size === 2 ? spread() : 0;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener(
      'wheel',
      e => {
        if (!this.traffic || this.busy) return;
        e.preventDefault();
        ensureOrbit();
        const o = this.director.orbit;
        o.dist = Math.max(
          2.5,
          Math.min(40, o.dist * Math.exp(e.deltaY * 0.0015)),
        );
        this.idle = 0;
      },
      {passive: false},
    );
  }

  frame(now: number) {
    if (this.busy || !this.traffic) return;
    if (this.showingProgress) {
      // Terrain clipmaps, road chunks and TAA/exposure warm up over the
      // first frames of a new world.
      const p = this.renderer.worldProgress;
      this.setProgress(
        this.loadingLabel.textContent ?? '',
        0.6 + 0.4 * p,
        this.loadingNote.textContent ?? '',
      );
      this.mark(`warm frame p=${p.toFixed(2)}`);
      if (p >= 1) {
        this.progressStart = 0;
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
    const semi = semiLayout();
    for (const v of this.traffic.vehicles) {
      const spec = carSpec(v.kind);
      // A semi's s is the middle of the rig: the tractor sits ahead of it.
      const s0 = v.s;
      if (v.kind === 'semi') v.s = s0 + v.dir * semi.tractor;
      const pose = vehiclePose(
        this.road,
        v,
        Math.max(dt, 1 / 120),
        spec.wheelbase,
        spec.track,
      );
      v.s = s0;
      if (v.kind === 'semi')
        cars.push(this.trailerFor(v, dt, lights, semi.trailer));
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
        id: v.id,
        s: v.kind === 'semi' ? v.s + v.dir * semi.tractor : v.s,
        d: v.d,
        dir: v.dir,
        length: v.kind === 'semi' ? spec.length : v.length,
        track: carSpec(v.kind).track,
        speed: v.speed,
      });
    }
    const pp = playerPose!;
    this.lastPose = pp;
    const camera0 = this.director.update(
      this.params.freeze && this.params.shotTime === null ? 0 : dt,
      pp,
      player.s,
      // Pose centre to the rear of the vehicle (a semi's pose is the
      // tractor's; its trailer trails behind).
      player.kind === 'semi'
        ? semi.tractor + semi.total / 2
        : player.length / 2,
    );
    const camera = camera0;
    this.renderer.exposureBias = camera.interior ? 0.45 : 1;
    for (const c of cars)
      if (c.player) {
        c.draw.interior = camera.interior;
        const g = this.gauges(player.speed, player.accel, dt);
        c.draw.speed = g[0];
        c.draw.rpm = g[1];
      }
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
  private lastPose: Pose | null = null;

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
