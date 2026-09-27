// Settings panel: a gear button (top left) toggles a panel that slides in
// from the left with environment, scene, camera, graphics and interface
// options. Graphics/interface choices persist in localStorage.
import type {App} from '../app';
import {BIOMES, BIOME_ORDER, BiomeId, envKeys} from '../world/biome';
import {SHOT_KINDS, ShotKind} from '../camera/director';
import {CAR_KINDS, CarKind} from '../gen/car';
import {
  DEFAULT_GRAPHICS,
  GraphicsSettings,
  LOW_POWER_GRAPHICS,
} from '../render/renderer';

const STORAGE_KEY = 'webgpu-driving-settings';

interface Stored {
  graphics?: Partial<GraphicsSettings>;
  // Only an explicit choice turns the HUD on. (The key changed: an older
  // build stored the HUD's state whenever settings were saved, which kept
  // it on after it became off by default.)
  showHud?: boolean;
}

export const SHOT_NAMES: Record<ShotKind, string> = {
  chase: 'Chase',
  helicopter: 'Helicopter',
  drone: 'Drone flyover',
  roadside: 'Roadside',
  dolly: 'Side dolly',
  wheel: 'Wheel cam',
  interior: 'Driver (interior)',
  passenger: 'Passenger window',
  topdown: 'Top down',
  hood: 'Hood cam',
  front: 'Front tracking',
  orbit: 'Orbit (drag / wheel / arrows)',
  custom: 'Custom',
};

const GRAPHICS_LABELS: Array<[keyof GraphicsSettings, string]> = [
  ['dof', 'Depth of field'],
  ['motionBlur', 'Motion blur'],
  ['volumetrics', 'Volumetric fog & light shafts'],
  ['ssao', 'Ambient occlusion'],
  ['bloom', 'Bloom & glow'],
  ['grass', 'Grass'],
  ['filmGrain', 'Film grain & vignette'],
  ['letterbox', 'Cinematic letterbox'],
  ['native', 'Native display resolution (Retina; slower)'],
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function formatTime(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

export function saveGraphics(g: GraphicsSettings) {
  try {
    const cur = loadStoredSettings();
    cur.graphics = g;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cur));
  } catch {
    // Storage may be unavailable.
  }
}

export function loadStoredSettings(): Stored {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Stored;
  } catch {
    return {};
  }
}

export class SettingsPanel {
  private panel: HTMLElement;
  private gear: HTMLButtonElement;
  private envButtons = new Map<BiomeId, HTMLButtonElement>();
  private tod!: HTMLInputElement;
  private todOut!: HTMLOutputElement;
  private clouds!: HTMLInputElement;
  private cloudsOut!: HTMLOutputElement;
  private cruise!: HTMLInputElement;
  private cruiseOut!: HTMLOutputElement;
  private autopilot!: HTMLInputElement;
  private camera!: HTMLSelectElement;
  private car!: HTMLSelectElement;
  private hud!: HTMLInputElement;
  private graphicsInputs = new Map<keyof GraphicsSettings, HTMLInputElement>();
  private scale!: HTMLInputElement;
  private quality!: HTMLSelectElement;
  private scaleOut!: HTMLOutputElement;

  constructor(private app: App) {
    this.gear = document.getElementById('gear') as HTMLButtonElement;
    this.panel = document.getElementById('settings')!;
    this.build();
    this.gear.addEventListener('click', () => this.toggle());
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
        this.gear.focus();
      }
    });
  }

  get isOpen(): boolean {
    return this.panel.classList.contains('open');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.sync();
    this.panel.classList.add('open');
    this.panel.removeAttribute('inert');
    this.gear.setAttribute('aria-expanded', 'true');
  }

  close() {
    this.panel.classList.remove('open');
    this.panel.setAttribute('inert', '');
    this.gear.setAttribute('aria-expanded', 'false');
  }

  private save() {
    const app = this.app;
    const stored: Stored = {
      graphics: app.renderer.graphics,
      showHud: !app.hudHidden,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Storage may be unavailable (private mode); settings still apply.
    }
  }

  private section(title: string): HTMLElement {
    const s = el('section');
    s.appendChild(el('h3', {}, title));
    this.panel.querySelector('.body')!.appendChild(s);
    return s;
  }

  private slider(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    onInput: (v: number) => void,
  ): [HTMLInputElement, HTMLOutputElement] {
    const id = `s-${label.replace(/\W+/g, '-').toLowerCase()}`;
    const row = el('div', {class: 'row'});
    const lab = el('label', {for: id}, label);
    const out = el('output', {for: id});
    const input = el('input', {
      id,
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
    });
    input.addEventListener('input', () => onInput(Number(input.value)));
    row.append(lab, out);
    parent.append(row, input);
    return [input, out];
  }

  private checkbox(
    parent: HTMLElement,
    label: string,
    onChange: (v: boolean) => void,
  ): HTMLInputElement {
    const lab = el('label', {class: 'check'});
    const input = el('input', {type: 'checkbox'});
    input.addEventListener('change', () => onChange(input.checked));
    lab.append(input, el('span', {}, label));
    parent.appendChild(lab);
    return input;
  }

  private build() {
    const app = this.app;
    // Environment.
    const env = this.section('Environment');
    const grid = el('div', {class: 'env-grid'});
    BIOME_ORDER.forEach((id, i) => {
      const b = el(
        'button',
        {type: 'button', 'aria-pressed': 'false', title: `Key ${i + 1}`},
        BIOMES[id].name,
      );
      b.addEventListener('click', () => {
        app.switchTo(id);
        this.close();
      });
      grid.appendChild(b);
      this.envButtons.set(id, b);
    });
    const regen = el(
      'button',
      {type: 'button', class: 'wide'},
      'New world (random seed)',
    );
    regen.addEventListener('click', () => void app.regenerate());
    env.append(grid, regen);

    // Scene.
    const scene = this.section('Scene');
    [this.tod, this.todOut] = this.slider(
      scene,
      'Time of day',
      0,
      24,
      0.25,
      v => {
        app.biome.sky.timeOfDay = v;
        app.params.tod = v;
        this.todOut.value = formatTime(v);
      },
    );
    [this.clouds, this.cloudsOut] = this.slider(
      scene,
      'Cloud cover',
      0,
      1,
      0.01,
      v => {
        app.biome.sky.clouds = v;
        this.cloudsOut.value = `${Math.round(v * 100)}%`;
      },
    );
    [this.cruise, this.cruiseOut] = this.slider(
      scene,
      'Cruise speed',
      30,
      140,
      5,
      v => {
        app.setCruise(v / 3.6);
        this.cruiseOut.value = `${v} km/h`;
      },
    );
    this.autopilot = this.checkbox(
      scene,
      'Autopilot (lane changes & overtaking)',
      v => {
        app.traffic.autopilot = v;
      },
    );

    // Player car (unnamed: Car 1..N; V cycles them).
    const carId = 's-car';
    scene.appendChild(el('label', {for: carId, class: 'block'}, 'Car (V)'));
    this.car = el('select', {id: carId});
    CAR_KINDS.forEach((k, i) =>
      this.car.appendChild(el('option', {value: k}, `Car ${i + 1}`)),
    );
    this.car.addEventListener('change', () => {
      app.setPlayerCar(this.car.value as CarKind);
    });
    scene.appendChild(this.car);

    // Camera.
    const cam = this.section('Camera');
    const camId = 's-camera';
    cam.appendChild(
      el('label', {for: camId, class: 'block'}, 'Shot (C cycles)'),
    );
    this.camera = el('select', {id: camId});
    this.camera.appendChild(
      el('option', {value: ''}, 'Auto director (cuts between shots)'),
    );
    for (const k of SHOT_KINDS) {
      if (k !== 'custom')
        this.camera.appendChild(el('option', {value: k}, SHOT_NAMES[k]));
    }
    this.camera.addEventListener('change', () => {
      app.setCamera((this.camera.value || null) as ShotKind | null);
    });
    cam.appendChild(this.camera);

    // Graphics.
    const gfx = this.section('Graphics');
    const qId = 's-quality';
    gfx.appendChild(el('label', {for: qId, class: 'block'}, 'Quality'));
    this.quality = el('select', {id: qId});
    this.quality.appendChild(el('option', {value: 'high'}, 'High (desktop)'));
    this.quality.appendChild(
      el('option', {value: 'low'}, 'Low power (phones, tablets)'),
    );
    this.quality.addEventListener('change', () => {
      app.renderer.graphics = {
        ...(this.quality.value === 'low'
          ? LOW_POWER_GRAPHICS
          : DEFAULT_GRAPHICS),
      };
      this.save();
      this.sync();
    });
    gfx.appendChild(this.quality);
    for (const [key, label] of GRAPHICS_LABELS) {
      const input = this.checkbox(gfx, label, v => {
        (app.renderer.graphics[key] as boolean) = v;
        this.save();
      });
      this.graphicsInputs.set(key, input);
    }
    [this.scale, this.scaleOut] = this.slider(
      gfx,
      'Render resolution',
      0.5,
      1,
      0.05,
      v => {
        app.renderer.graphics.renderScale = v;
        this.scaleOut.value = `${Math.round(v * 100)}%`;
        this.save();
      },
    );

    // Interface.
    const ui = this.section('Interface');
    this.hud = this.checkbox(ui, 'Show HUD (speed, camera, fps)', v => {
      app.setHudVisible(v);
      this.save();
    });
    ui.appendChild(
      el(
        'p',
        {class: 'hint'},
        `Keys: ←/→ lanes · ↑/↓ speed · C next shot · V next car · B next environment · R new world · ${envKeys()} environments · H hide UI · Esc close`,
      ),
    );

    this.panel.querySelector('.close')!.addEventListener('click', () => {
      this.close();
      this.gear.focus();
    });
  }

  // Refresh every control from the current app state.
  sync() {
    const app = this.app;
    if (!app.biome) return;
    for (const [id, b] of this.envButtons) {
      b.setAttribute('aria-pressed', id === app.biome.id ? 'true' : 'false');
    }
    const sky = app.biome.sky;
    this.tod.value = String(sky.timeOfDay);
    this.todOut.value = formatTime(sky.timeOfDay);
    this.clouds.value = String(sky.clouds);
    this.cloudsOut.value = `${Math.round(sky.clouds * 100)}%`;
    const kmh = Math.round((app.biome.road.cruise * 3.6) / 5) * 5;
    this.cruise.value = String(kmh);
    this.cruiseOut.value = `${kmh} km/h`;
    this.autopilot.checked = app.traffic?.autopilot ?? true;
    this.camera.value = app.director?.forced ?? '';
    if (app.traffic) this.car.value = app.playerCar;
    const g = app.renderer.graphics;
    for (const [k, input] of this.graphicsInputs)
      input.checked = g[k] as boolean;
    this.quality.value = g.lowPower ? 'low' : 'high';
    this.scale.value = String(g.renderScale);
    this.scaleOut.value = `${Math.round(g.renderScale * 100)}%`;
    this.hud.checked = !app.hudHidden;
  }
}
