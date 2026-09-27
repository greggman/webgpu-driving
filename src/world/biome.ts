// Biome (environment) configuration. Each environment is data: terrain
// parameters, road style, palette, scatter density, sky/time, and weather.

export type BiomeId =
  | 'country'
  | 'desert'
  | 'coast'
  | 'forest'
  | 'snow'
  | 'lahonda'
  | 'night'
  | 'arizona'
  | 'autumn';

export interface TerrainParams {
  hillAmp: number;
  hillFreq: number;
  hillOctaves: number;
  baseHeight: number;
  mountAmp: number;
  mountFreq: number;
  mountStart: number;
  mountEnd: number;
  terraceAmt: number;
  terraceStep: number;
  macroAmp: number;
  macroFreq: number;
  coastSide: number; // -1 / +1: ocean on that side of the road, 0 = none
  coastOffset: number;
  seaFloor: number;
  cliffWidth: number;
  canyonDepth: number;
  canyonFreq: number;
  canyonWidth: number;
  detailAmp: number;
  roadFlatHalf: number;
  cutSlope: number;
  fillSlope: number;
  valleyDepth: number;
  valleyWidth: number;
  dunes: number;
}

export interface RoadStyle {
  lanesPerDir: 1 | 2;
  laneWidth: number;
  shoulder: number;
  dirt: boolean;
  maxHeading: number; // radians
  wiggle: number; // 0..1 how twisty
  smoothing: number; // elevation smoothing half-window (m)
  centerLine: 'double-yellow' | 'dashed-yellow' | 'dashed-white' | 'none';
  edgeLine: boolean;
  fence: 'none' | 'wood' | 'split-rail' | 'barbed' | 'guardrail';
  poles: boolean;
  flowers: number;
  cruise: number; // m/s
  traffic: number; // cars per km per lane
}

export interface Palette {
  grassA: [number, number, number];
  grassB: [number, number, number];
  dry: [number, number, number];
  dirt: [number, number, number];
  rock: [number, number, number];
  sand: [number, number, number];
  snow: number; // 0..1 snow cover
  foliage: [number, number, number];
  flower: [number, number, number];
  autumn?: number; // 0..1 broadleaf autumn colours
}

export interface Scatter {
  grass: number; // blade density multiplier
  grassHeight: number;
  trees: number; // probability per cell
  treeKinds: TreeKind[];
  bushes: number;
  rocks: number;
  cactus: number;
  crops: number;
  hedges: number;
  flowers: number;
  tumbleweeds: number;
  buildings: number;
  forestEdge: number; // how far from the road trees start
}

export type TreeKind =
  'oak' | 'pine' | 'birch' | 'redwood' | 'bare' | 'cactus' | 'palm' | 'cypress';

export interface Sky {
  timeOfDay: number; // hours
  sunAzimuth: number; // degrees, relative to road direction (+z)
  turbidity: number; // mie scale
  clouds: number; // coverage 0..1
  cloudScale: number;
  fogDensity: number;
  fogHeight: number;
  exposure: number;
  grade: [number, number, number]; // color balance multiplier
  saturation: number;
  contrast: number;
}

export interface Weather {
  snow: number;
  dust: number;
  wetness: number;
  wind: number;
  rain?: number; // 0..1
  lightning?: number; // strikes per minute
}

export interface Biome {
  id: BiomeId;
  name: string;
  terrain: TerrainParams;
  road: RoadStyle;
  palette: Palette;
  scatter: Scatter;
  sky: Sky;
  weather: Weather;
  ocean: boolean;
  headlights: boolean;
  shotWeights: Partial<Record<string, number>>;
}

const baseTerrain: TerrainParams = {
  hillAmp: 45,
  hillFreq: 1 / 900,
  hillOctaves: 9,
  baseHeight: 60,
  mountAmp: 0,
  mountFreq: 1 / 5000,
  mountStart: 1500,
  mountEnd: 5000,
  terraceAmt: 0,
  terraceStep: 20,
  macroAmp: 30,
  macroFreq: 1 / 6000,
  coastSide: 0,
  coastOffset: 60,
  seaFloor: -25,
  cliffWidth: 30,
  canyonDepth: 0,
  canyonFreq: 1 / 1500,
  canyonWidth: 0.08,
  detailAmp: 0.4,
  roadFlatHalf: 6,
  cutSlope: 1.2,
  fillSlope: 0.6,
  valleyDepth: 10,
  valleyWidth: 250,
  dunes: 0,
};

const baseRoad: RoadStyle = {
  lanesPerDir: 1,
  laneWidth: 3.5,
  shoulder: 1.0,
  dirt: false,
  maxHeading: 0.9,
  wiggle: 0.6,
  smoothing: 70,
  centerLine: 'double-yellow',
  edgeLine: true,
  fence: 'none',
  poles: false,
  flowers: 0,
  cruise: 22,
  traffic: 1.2,
};

const baseScatter: Scatter = {
  grass: 1,
  grassHeight: 0.5,
  trees: 0.05,
  treeKinds: ['oak'],
  bushes: 0.3,
  rocks: 0.02,
  cactus: 0,
  crops: 0,
  hedges: 0,
  flowers: 0,
  tumbleweeds: 0,
  buildings: 0,
  forestEdge: 12,
};

const baseSky: Sky = {
  timeOfDay: 17.2,
  sunAzimuth: 35,
  turbidity: 1,
  clouds: 0.48,
  cloudScale: 1,
  fogDensity: 0.00002,
  fogHeight: 300,
  exposure: 1,
  grade: [1, 1, 1],
  saturation: 1.05,
  contrast: 1.05,
};

const basePalette: Palette = {
  grassA: [0.16, 0.3, 0.06],
  grassB: [0.32, 0.36, 0.1],
  dry: [0.55, 0.45, 0.22],
  dirt: [0.33, 0.25, 0.17],
  rock: [0.42, 0.4, 0.37],
  sand: [0.7, 0.6, 0.42],
  snow: 0,
  foliage: [0.12, 0.22, 0.05],
  flower: [0.9, 0.2, 0.4],
};

const noWeather: Weather = {snow: 0, dust: 0, wetness: 0, wind: 0.4};

export const BIOMES: Record<BiomeId, Biome> = {
  country: {
    id: 'country',
    name: 'Country Road',
    terrain: {
      ...baseTerrain,
      hillAmp: 75,
      hillFreq: 1 / 1300,
      mountAmp: 380,
      mountFreq: 1 / 6500,
      mountStart: 2500,
      mountEnd: 9000,
      valleyDepth: 18,
      valleyWidth: 380,
    },
    road: {...baseRoad, poles: true, fence: 'wood'},
    palette: {...basePalette},
    scatter: {
      ...baseScatter,
      trees: 0.06,
      treeKinds: ['oak', 'birch', 'oak'],
      bushes: 0.25,
      crops: 1,
      hedges: 1,
      buildings: 0.4,
    },
    sky: {...baseSky},
    weather: {...noWeather},
    ocean: false,
    headlights: false,
    shotWeights: {helicopter: 2, chase: 2, drone: 1.5},
  },
  desert: {
    id: 'desert',
    name: 'Desert Dirt Road',
    terrain: {
      ...baseTerrain,
      hillAmp: 18,
      hillFreq: 1 / 700,
      baseHeight: 400,
      mountAmp: 900,
      mountFreq: 1 / 7000,
      mountStart: 1500,
      mountEnd: 7000,
      terraceAmt: 0.6,
      terraceStep: 14,
      macroAmp: 40,
      valleyDepth: 5,
      dunes: 3,
    },
    road: {
      ...baseRoad,
      dirt: true,
      laneWidth: 3.2,
      shoulder: 0.8,
      centerLine: 'none',
      edgeLine: false,
      maxHeading: 0.55,
      wiggle: 0.35,
      smoothing: 45,
      cruise: 20,
      traffic: 0.25,
    },
    palette: {
      ...basePalette,
      grassA: [0.42, 0.36, 0.2],
      grassB: [0.55, 0.45, 0.25],
      dry: [0.62, 0.45, 0.28],
      dirt: [0.62, 0.42, 0.26],
      rock: [0.55, 0.33, 0.2],
      sand: [0.78, 0.58, 0.38],
      foliage: [0.3, 0.33, 0.14],
    },
    scatter: {
      ...baseScatter,
      grass: 0.18,
      grassHeight: 0.35,
      trees: 0.01,
      treeKinds: ['cactus', 'cactus', 'bare'],
      bushes: 0.25,
      rocks: 0.12,
      cactus: 1,
      tumbleweeds: 1,
      forestEdge: 8,
    },
    sky: {
      ...baseSky,
      timeOfDay: 17.6,
      sunAzimuth: -30,
      clouds: 0.12,
      fogDensity: 0.000012,
      turbidity: 1.3,
      grade: [1.06, 0.98, 0.9],
    },
    weather: {...noWeather, dust: 1},
    ocean: false,
    headlights: false,
    shotWeights: {helicopter: 3, drone: 2, roadside: 1.5},
  },
  arizona: {
    id: 'arizona',
    name: 'Arizona Storm',
    terrain: {
      ...baseTerrain,
      hillAmp: 18,
      hillFreq: 1 / 700,
      baseHeight: 400,
      mountAmp: 900,
      mountFreq: 1 / 7000,
      mountStart: 1500,
      mountEnd: 7000,
      terraceAmt: 0.6,
      terraceStep: 14,
      macroAmp: 40,
      valleyDepth: 5,
      dunes: 3,
    },
    road: {
      ...baseRoad,
      laneWidth: 3.5,
      centerLine: 'dashed-yellow',
      maxHeading: 0.5,
      wiggle: 0.3,
      smoothing: 60,
      poles: true,
      cruise: 24,
      traffic: 0.7,
    },
    palette: {
      ...basePalette,
      grassA: [0.42, 0.36, 0.2],
      grassB: [0.55, 0.45, 0.25],
      dry: [0.62, 0.45, 0.28],
      dirt: [0.62, 0.42, 0.26],
      rock: [0.55, 0.33, 0.2],
      sand: [0.78, 0.58, 0.38],
      foliage: [0.3, 0.33, 0.14],
    },
    scatter: {
      ...baseScatter,
      grass: 0.18,
      grassHeight: 0.35,
      trees: 0.01,
      treeKinds: ['cactus', 'cactus', 'bare'],
      bushes: 0.25,
      rocks: 0.12,
      cactus: 1,
      tumbleweeds: 0,
      forestEdge: 8,
    },
    sky: {
      ...baseSky,
      timeOfDay: 22.5,
      sunAzimuth: -30,
      clouds: 0.97,
      cloudScale: 0.7,
      fogDensity: 0.00007,
      fogHeight: 500,
      grade: [0.95, 0.98, 1.08],
    },
    weather: {...noWeather, rain: 0.85, lightning: 6, wetness: 1, wind: 0.6},
    ocean: false,
    headlights: true,
    shotWeights: {chase: 2, interior: 2.5, passenger: 1, roadside: 1},
  },
  coast: {
    id: 'coast',
    name: 'Ocean Coastline',
    terrain: {
      ...baseTerrain,
      hillAmp: 80,
      hillFreq: 1 / 1100,
      baseHeight: 55,
      coastSide: 1,
      coastOffset: 70,
      seaFloor: -30,
      cliffWidth: 22,
      canyonDepth: 70,
      canyonFreq: 1 / 1800,
      canyonWidth: 0.07,
      mountAmp: 260,
      mountFreq: 1 / 3000,
      mountStart: 300,
      mountEnd: 2500,
      valleyDepth: 0,
      macroAmp: 10,
    },
    road: {
      ...baseRoad,
      lanesPerDir: 1,
      maxHeading: 0.7,
      smoothing: 120,
      fence: 'guardrail',
      cruise: 24,
    },
    palette: {
      ...basePalette,
      grassA: [0.15, 0.27, 0.07],
      grassB: [0.3, 0.34, 0.12],
      dry: [0.5, 0.45, 0.25],
      rock: [0.42, 0.37, 0.32],
      sand: [0.76, 0.68, 0.52],
    },
    scatter: {
      ...baseScatter,
      trees: 0.02,
      treeKinds: ['cypress', 'pine', 'cypress'],
      bushes: 0.4,
      rocks: 0.05,
      flowers: 0.3,
    },
    sky: {
      ...baseSky,
      timeOfDay: 17.8,
      sunAzimuth: 70,
      clouds: 0.25,
      // Clear, saturated California coast light.
      fogDensity: baseSky.fogDensity * 0.5,
      saturation: 1.15,
    },
    weather: {...noWeather, wind: 0.7},
    ocean: true,
    headlights: false,
    shotWeights: {helicopter: 3, drone: 2, chase: 1.5, roadside: 1.5},
  },
  forest: {
    id: 'forest',
    name: 'Forest Flower Road',
    terrain: {
      ...baseTerrain,
      hillAmp: 90,
      hillFreq: 1 / 900,
      mountAmp: 500,
      mountFreq: 1 / 5000,
      mountStart: 1500,
      mountEnd: 6000,
      valleyDepth: 30,
      valleyWidth: 260,
    },
    road: {...baseRoad, flowers: 1, maxHeading: 0.8, wiggle: 0.7, cruise: 18},
    palette: {
      ...basePalette,
      grassA: [0.1, 0.24, 0.05],
      grassB: [0.2, 0.3, 0.08],
      foliage: [0.07, 0.17, 0.04],
      flower: [0.95, 0.75, 0.2],
    },
    scatter: {
      ...baseScatter,
      trees: 0.55,
      treeKinds: ['pine', 'birch', 'oak', 'pine'],
      bushes: 0.6,
      flowers: 1,
      forestEdge: 9,
    },
    sky: {
      ...baseSky,
      timeOfDay: 16.4,
      sunAzimuth: 50,
      clouds: 0.3,
      // Clear air under the canopy: a tenth of the usual haze.
      fogDensity: baseSky.fogDensity * 0.1,
    },
    weather: {...noWeather, wind: 0.3},
    ocean: false,
    headlights: false,
    shotWeights: {chase: 2, interior: 1.5, roadside: 2},
  },
  autumn: {
    id: 'autumn',
    name: 'New England Autumn',
    terrain: {
      ...baseTerrain,
      hillAmp: 75,
      hillFreq: 1 / 850,
      mountAmp: 350,
      mountFreq: 1 / 5000,
      mountStart: 1800,
      mountEnd: 7000,
      valleyDepth: 20,
      valleyWidth: 220,
    },
    road: {
      ...baseRoad,
      poles: true,
      fence: 'split-rail',
      maxHeading: 0.7,
      wiggle: 0.6,
      cruise: 19,
    },
    palette: {
      ...basePalette,
      grassA: [0.24, 0.27, 0.08],
      grassB: [0.42, 0.36, 0.13],
      dry: [0.5, 0.36, 0.16],
      foliage: [0.1, 0.2, 0.05],
      autumn: 1,
    },
    scatter: {
      ...baseScatter,
      trees: 0.4,
      treeKinds: ['oak', 'oak', 'birch', 'oak', 'pine'],
      bushes: 0.45,
      buildings: 0.12,
      forestEdge: 10,
    },
    sky: {
      ...baseSky,
      timeOfDay: 15.6,
      sunAzimuth: 20,
      clouds: 0.38,
      turbidity: 1.3,
      grade: [1.05, 1.0, 0.92],
      saturation: 1.12,
    },
    weather: {...noWeather, wind: 0.5},
    ocean: false,
    headlights: false,
    shotWeights: {chase: 2, helicopter: 2.5, drone: 2, roadside: 1.5},
  },
  snow: {
    id: 'snow',
    name: 'Pennsylvania Snowstorm',
    terrain: {
      ...baseTerrain,
      hillAmp: 55,
      hillFreq: 1 / 900,
      valleyDepth: 12,
      mountAmp: 220,
      mountFreq: 1 / 5000,
      mountStart: 1500,
      mountEnd: 5000,
    },
    road: {...baseRoad, poles: true, fence: 'wood', cruise: 14, traffic: 0.6},
    palette: {
      ...basePalette,
      grassA: [0.3, 0.3, 0.22],
      grassB: [0.35, 0.33, 0.25],
      snow: 0.9,
      foliage: [0.12, 0.16, 0.1],
    },
    scatter: {
      ...baseScatter,
      grass: 0.25,
      trees: 0.08,
      treeKinds: ['bare', 'pine', 'bare'],
      bushes: 0.2,
      buildings: 0.5,
      hedges: 0.5,
    },
    sky: {
      ...baseSky,
      timeOfDay: 13,
      clouds: 1,
      fogDensity: 0.0025,
      fogHeight: 400,
      grade: [0.95, 0.98, 1.05],
      saturation: 0.8,
    },
    weather: {snow: 1, dust: 0, wetness: 0.3, wind: 0.8},
    ocean: false,
    headlights: true,
    shotWeights: {interior: 3, chase: 2, roadside: 1},
  },
  lahonda: {
    id: 'lahonda',
    name: 'La Honda Road',
    terrain: {
      ...baseTerrain,
      hillAmp: 130,
      hillFreq: 1 / 1100,
      valleyDepth: 45,
      valleyWidth: 320,
      mountAmp: 300,
      mountFreq: 1 / 4000,
      mountStart: 1200,
      mountEnd: 5000,
    },
    road: {
      ...baseRoad,
      fence: 'split-rail',
      laneWidth: 3.2,
      shoulder: 0.5,
      maxHeading: 1.0,
      wiggle: 0.9,
      cruise: 17,
    },
    palette: {
      ...basePalette,
      grassA: [0.52, 0.42, 0.18],
      grassB: [0.62, 0.5, 0.24],
      dry: [0.7, 0.58, 0.3],
      foliage: [0.12, 0.2, 0.07],
    },
    scatter: {
      ...baseScatter,
      grassHeight: 0.6,
      trees: 0.08,
      treeKinds: ['oak', 'redwood', 'oak'],
      bushes: 0.3,
    },
    sky: {...baseSky, timeOfDay: 16.8, sunAzimuth: -40, fogDensity: 0.00006},
    weather: {...noWeather},
    ocean: false,
    headlights: false,
    shotWeights: {chase: 2, helicopter: 2, roadside: 2},
  },
  night: {
    id: 'night',
    name: 'Night Drive',
    terrain: {
      ...baseTerrain,
      hillAmp: 70,
      hillFreq: 1 / 1200,
      mountAmp: 300,
      mountFreq: 1 / 6000,
      mountStart: 2500,
      mountEnd: 8000,
    },
    road: {
      ...baseRoad,
      lanesPerDir: 2,
      centerLine: 'double-yellow',
      poles: true,
      fence: 'guardrail',
      cruise: 26,
      traffic: 1.6,
    },
    palette: {...basePalette},
    scatter: {
      ...baseScatter,
      trees: 0.08,
      treeKinds: ['pine', 'oak'],
      buildings: 0.3,
    },
    sky: {
      ...baseSky,
      timeOfDay: 23.5,
      clouds: 0.15,
      fogDensity: 0.00004,
    },
    // Dry: the beams light the road (a wet road would swallow them).
    weather: {...noWeather},
    ocean: false,
    headlights: true,
    shotWeights: {chase: 2, interior: 2, helicopter: 1},
  },
};

export const BIOME_ORDER: BiomeId[] = [
  'country',
  'desert',
  'coast',
  'forest',
  'snow',
  'lahonda',
  'night',
  'arizona',
  'autumn',
];

// Packs terrain params into 8 vec4s, matching src/shaders/terrain.wgsl.
export function packTerrain(t: TerrainParams, seed: number): Float32Array {
  const sx = ((seed * 7919) % 10000) + 1000;
  const sz = ((seed * 104729) % 10000) + 1000;
  return new Float32Array([
    t.hillAmp,
    t.hillFreq,
    t.hillOctaves,
    t.baseHeight,
    t.mountAmp,
    t.mountFreq,
    t.mountStart,
    t.mountEnd,
    t.terraceAmt,
    t.terraceStep,
    t.macroAmp,
    t.macroFreq,
    t.coastSide,
    t.coastOffset,
    t.seaFloor,
    t.cliffWidth,
    t.canyonDepth,
    t.canyonFreq,
    t.canyonWidth,
    t.detailAmp,
    t.roadFlatHalf,
    t.cutSlope,
    t.fillSlope,
    sx,
    sz,
    t.valleyDepth,
    t.valleyWidth,
    t.dunes,
    0,
    0,
    0,
    0,
  ]);
}
