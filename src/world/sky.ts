// Sun / moon placement from time of day, and CPU-side atmospheric
// transmittance (same model as atmosphere.wgsl) to color the sunlight.
import {Sky} from './biome';

const DEG = Math.PI / 180;
export const SUN_INTENSITY = 20;

export interface SkyState {
  sunDir: [number, number, number]; // toward the sun
  moonDir: [number, number, number];
  lightDir: [number, number, number]; // main directional light
  isSun: boolean;
  night: number; // 0 day .. 1 night
  lightColor: [number, number, number]; // illuminance at ground
}

function dirFrom(az: number, el: number): [number, number, number] {
  return [
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ];
}

// Optical depth integration through the atmosphere (Mm units).
function transmittance(
  altM: number,
  dir: [number, number, number],
  mie: number,
) {
  const R = 6.36,
    TOP = 6.46;
  const pos = [0, R + altM * 1e-6 + 2e-5, 0];
  // Ground hit?
  const b = pos[1] * dir[1];
  const cG = pos[1] * pos[1] - R * R;
  if (b < 0 && b * b - cG > 0) return [0, 0, 0];
  const cT = pos[1] * pos[1] - TOP * TOP;
  const tMax = -b + Math.sqrt(b * b - cT);
  const od = [0, 0, 0];
  const N = 40;
  for (let i = 0; i < N; ++i) {
    const t = ((i + 0.5) / N) * tMax;
    const p = [dir[0] * t, pos[1] + dir[1] * t, dir[2] * t];
    const alt = (Math.hypot(p[0], p[1], p[2]) - R) * 1000;
    const rd = Math.exp(-alt / 8);
    const md = Math.exp(-alt / 1.2) * mie;
    const oz = Math.max(0, 1 - Math.abs(alt - 25) / 15);
    const dt = tMax / N;
    od[0] += (5.802 * rd + (3.996 + 4.4) * md + 0.65 * oz) * dt;
    od[1] += (13.558 * rd + (3.996 + 4.4) * md + 1.881 * oz) * dt;
    od[2] += (33.1 * rd + (3.996 + 4.4) * md + 0.085 * oz) * dt;
  }
  return od.map(x => Math.exp(-x));
}

export function computeSky(sky: Sky, altitude: number): SkyState {
  const t = sky.timeOfDay;
  // Sun elevation: rises at 6, sets at 18.5, peaks at 55 deg.
  const dayT = (t - 6) / 12.5;
  const el = Math.sin(dayT * Math.PI) * 55 * DEG;
  const sunDir = dirFrom(sky.sunAzimuth * DEG + (t - 12) * 0.08, el);
  // Moon high in the night sky, roughly opposite the sun azimuth.
  // Moon low-ish over the road ahead so chase/interior shots can frame it.
  const moonDir = dirFrom(sky.sunAzimuth * 0.3 * DEG + 0.25, 18 * DEG);
  const elDeg = el / DEG;
  const night = Math.min(1, Math.max(0, (2 - elDeg) / 10));
  const isSun = elDeg > -3;
  const lightDir = isSun ? sunDir : moonDir;
  const tr = transmittance(altitude, lightDir, sky.turbidity);
  const intensity = isSun ? SUN_INTENSITY : SUN_INTENSITY * 0.02;
  // Sun below the horizon still casts a little light during civil twilight.
  const fade = isSun ? Math.min(1, Math.max(0, (elDeg + 3) / 4)) : 1;
  const moonTint = isSun ? [1, 1, 1] : [0.75, 0.85, 1.1];
  const cloudDim = 1 - 0.85 * Math.pow(sky.clouds, 3);
  const lightColor = [0, 1, 2].map(
    i => tr[i] * intensity * fade * moonTint[i] * cloudDim,
  ) as [number, number, number];
  return {sunDir, moonDir, lightDir, isSun, night, lightColor};
}
