import mvpCityData from "./content/mvpCityData.json";
import { roundPathCorners } from "./pathGeometry";

// Main city line geometry. Coordinates come from the MVP city_data.json.
// 2D points are [x, z] in Three.js space. Vehicles must use lane centers:
// lane center = road axis +/- grid.laneOffset.

export const STOP_PAUSE_SECONDS = 1.5;

export type RoutePoint = readonly [number, number];

export type RouteTier = "starter" | "working" | "premium" | "intercity";

export type CityBusStop = {
  id: string;
  position: RoutePoint;
  passengerSlots: number;
  modelPosition?: RoutePoint;
  rotationY?: number;
};

export type RouteDefinition = {
  id: string;
  name: string;
  tier: RouteTier;
  wealthMultiplier: number;
  unlockCost: number;
  points: readonly RoutePoint[];
  note: string;
};

type RawBusStop = {
  id: string;
  position: [number, number, number];
  rotationY: number;
  dock: [number, number];
  slots: number;
  road: "horizontal" | "vertical";
};

const BUS_STOP_ORDER = [
  "STOP_01",
  "STOP_02",
  "STOP_03",
  "STOP_07",
  "STOP_09",
  "STOP_10",
  "STOP_11",
  "STOP_06",
  "STOP_08",
  "STOP_04",
  "STOP_05",
] as const;

const RAW_BUS_STOPS = mvpCityData.busStops as unknown as RawBusStop[];
const GRID = mvpCityData.grid;
const LANE_OFFSET = GRID.laneOffset;
const STOP_MODEL_OFFSET = GRID.asphaltWidth / 2 + GRID.sidewalkWidth / 2;

function getBusStop(id: string): RawBusStop {
  const stop = RAW_BUS_STOPS.find((candidate) => candidate.id === id);
  if (!stop) throw new Error(`Missing MVP bus stop: ${id}`);
  return stop;
}

export const CITY_BUS_STOPS = BUS_STOP_ORDER.map((id) => {
  const stop = getBusStop(id);
  return { id, position: stop.dock, passengerSlots: stop.slots };
}) satisfies CityBusStop[];

function laneX(axis: number, side: -1 | 1): number {
  return Number((axis + side * LANE_OFFSET).toFixed(3));
}

function laneZ(axis: number, side: -1 | 1): number {
  return Number((axis + side * LANE_OFFSET).toFixed(3));
}

const AXIS = {
  west: GRID.roadAxesX[2],
  centerWest: GRID.roadAxesX[3],
  centerEast: GRID.roadAxesX[4],
  east: GRID.roadAxesX[5],
  north: GRID.roadAxesZ[3],
  centerSouth: GRID.roadAxesZ[4],
  south: GRID.roadAxesZ[5],
  farSouth: GRID.roadAxesZ[6],
} as const;

const LANE = {
  westSouthbound: laneX(AXIS.west, -1),
  centerWestNorthbound: laneX(AXIS.centerWest, -1),
  centerEastSouthbound: laneX(AXIS.centerEast, 1),
  eastNorthbound: laneX(AXIS.east, 1),
  // Starter ring uses the lane away from the terminal island on all four sides.
  northEastbound: laneZ(AXIS.north, 1),
  centerSouthWestbound: laneZ(AXIS.centerSouth, -1),
  southEastbound: laneZ(AXIS.south, 1),
  farSouthWestbound: laneZ(AXIS.farSouth, -1),
} as const;

const STARTER_ROUTE_POINTS = [
  // Terminal north side -> east neighborhood.
  [-5.4, LANE.northEastbound],
  [laneX(GRID.roadAxesX[6], 1), LANE.northEastbound],
  // East boulevard -> south-east.
  [laneX(GRID.roadAxesX[6], 1), laneZ(GRID.roadAxesZ[5], -1)],
  [laneX(GRID.roadAxesX[5], 1), laneZ(GRID.roadAxesZ[5], -1)],
  // Dive to the outer south road.
  [laneX(GRID.roadAxesX[5], 1), laneZ(GRID.roadAxesZ[7], -1)],
  [laneX(GRID.roadAxesX[1], -1), laneZ(GRID.roadAxesZ[7], -1)],
  // Climb through the south-west blocks, then cut back east.
  [laneX(GRID.roadAxesX[1], -1), laneZ(GRID.roadAxesZ[6], 1)],
  [laneX(GRID.roadAxesX[2], -1), laneZ(GRID.roadAxesZ[6], 1)],
  // Long northbound avenue to the upper neighborhood.
  [laneX(GRID.roadAxesX[2], -1), laneZ(GRID.roadAxesZ[2], -1)],
  [laneX(GRID.roadAxesX[0], 1), laneZ(GRID.roadAxesZ[2], -1)],
  // Return to the terminal from the western boulevard.
  [laneX(GRID.roadAxesX[0], 1), LANE.northEastbound],
  [-5.4, LANE.northEastbound],
] as const satisfies readonly RoutePoint[];

const MAIN_CITY_ROUTE_POINTS = [
  [-5.4, LANE.northEastbound],
  [-0.6, LANE.northEastbound],
  [4.2, LANE.northEastbound],
  [LANE.centerEastSouthbound, LANE.northEastbound],
  [LANE.centerEastSouthbound, AXIS.centerSouth],
  [LANE.eastNorthbound, AXIS.centerSouth],
  [LANE.eastNorthbound, -16.32],
  [AXIS.east, -16.32],
  [AXIS.east, LANE.southEastbound],
  [16.32, LANE.southEastbound],
  [LANE.centerWestNorthbound, LANE.southEastbound],
  [LANE.centerWestNorthbound, -28.35],
  [AXIS.west, -28.35],
  [AXIS.west, -11.007],
  [-28.35, -11.007],
  [-28.35, 16.32],
  [-21.639, 16.32],
  [-21.639, 23.035],
  [-16.32, 23.035],
  [AXIS.centerWest, 23.035],
  [AXIS.centerWest, LANE.northEastbound],
  [-5.4, LANE.northEastbound],
] as const satisfies readonly RoutePoint[];

const WEST_WORKER_ROUTE_POINTS = [
  [LANE.centerWestNorthbound, LANE.centerSouthWestbound],
  [LANE.centerWestNorthbound, LANE.southEastbound],
  [LANE.westSouthbound, LANE.southEastbound],
  [LANE.westSouthbound, 16.32],
  [-28.35, 16.32],
  [-28.35, -11.007],
  [LANE.westSouthbound, -11.007],
  [LANE.westSouthbound, LANE.centerSouthWestbound],
  [-4, LANE.centerSouthWestbound],
  [LANE.centerWestNorthbound, LANE.centerSouthWestbound],
] as const satisfies readonly RoutePoint[];

const PREMIUM_OUTER_ROUTE_POINTS = [
  [LANE.eastNorthbound, LANE.southEastbound],
  [LANE.eastNorthbound, LANE.northEastbound],
  [34.365, LANE.northEastbound],
  [34.365, LANE.farSouthWestbound],
  [LANE.westSouthbound, LANE.farSouthWestbound],
  [LANE.westSouthbound, 23.035],
  [LANE.centerWestNorthbound, 23.035],
  [LANE.centerWestNorthbound, LANE.southEastbound],
  [LANE.eastNorthbound, LANE.southEastbound],
] as const satisfies readonly RoutePoint[];


// --- Faz 4: ek hatlar. Noktalar mevcut serit yardimcilariyla uretilir,
// boylece hepsi yol ekseninde kalir (arac yol disina cikamaz). ---

const NORTH_LOOP_ROUTE_POINTS = [
  [laneX(GRID.roadAxesX[2], -1), laneZ(GRID.roadAxesZ[1], 1)],
  [laneX(GRID.roadAxesX[5], 1), laneZ(GRID.roadAxesZ[1], 1)],
  [laneX(GRID.roadAxesX[5], 1), laneZ(GRID.roadAxesZ[3], -1)],
  [laneX(GRID.roadAxesX[2], -1), laneZ(GRID.roadAxesZ[3], -1)],
  [laneX(GRID.roadAxesX[2], -1), laneZ(GRID.roadAxesZ[1], 1)],
] as const satisfies readonly RoutePoint[];

const EAST_EXPRESS_ROUTE_POINTS = [
  [laneX(GRID.roadAxesX[4], 1), laneZ(GRID.roadAxesZ[1], 1)],
  [laneX(GRID.roadAxesX[6], 1), laneZ(GRID.roadAxesZ[1], 1)],
  [laneX(GRID.roadAxesX[6], 1), laneZ(GRID.roadAxesZ[6], -1)],
  [laneX(GRID.roadAxesX[4], 1), laneZ(GRID.roadAxesZ[6], -1)],
  [laneX(GRID.roadAxesX[4], 1), laneZ(GRID.roadAxesZ[1], 1)],
] as const satisfies readonly RoutePoint[];

const SOUTH_COAST_ROUTE_POINTS = [
  [laneX(GRID.roadAxesX[1], -1), laneZ(GRID.roadAxesZ[5], -1)],
  [laneX(GRID.roadAxesX[6], 1), laneZ(GRID.roadAxesZ[5], -1)],
  [laneX(GRID.roadAxesX[6], 1), laneZ(GRID.roadAxesZ[7], -1)],
  [laneX(GRID.roadAxesX[1], -1), laneZ(GRID.roadAxesZ[7], -1)],
  [laneX(GRID.roadAxesX[1], -1), laneZ(GRID.roadAxesZ[5], -1)],
] as const satisfies readonly RoutePoint[];

const GRAND_RING_ROUTE_POINTS = [
  [laneX(GRID.roadAxesX[0], 1), laneZ(GRID.roadAxesZ[0], 1)],
  [laneX(GRID.roadAxesX[7], 1), laneZ(GRID.roadAxesZ[0], 1)],
  [laneX(GRID.roadAxesX[7], 1), laneZ(GRID.roadAxesZ[7], -1)],
  [laneX(GRID.roadAxesX[0], 1), laneZ(GRID.roadAxesZ[7], -1)],
  [laneX(GRID.roadAxesX[0], 1), laneZ(GRID.roadAxesZ[0], 1)],
] as const satisfies readonly RoutePoint[];

export const ROUTE_DEFINITIONS = [
  {
    id: "starter-center",
    name: "Mahalle Hattı",
    tier: "starter",
    wealthMultiplier: 0.75,
    unlockCost: 0,
    points: STARTER_ROUTE_POINTS,
    note: "Terminalden çıkıp doğu, güney, batı ve kuzey mahallelerini dolaşan seyrek duraklı şehir hattı.",
  },
  {
    id: "main-city",
    name: "Üniversite Hattı",
    tier: "working",
    wealthMultiplier: 1,
    unlockCost: 25000,
    points: MAIN_CITY_ROUTE_POINTS,
    note: "MVP şehirdeki 11 durağı dolaşan, öğrenci yoğunluğu yüksek tam mahalle hattı.",
  },
  {
    id: "west-worker",
    name: "Sanayi Hattı",
    tier: "working",
    wealthMultiplier: 1.45,
    unlockCost: 110000,
    points: WEST_WORKER_ROUTE_POINTS,
    note: "Batı ve güney sokaklarını kullanan, vardiya çıkışı yoğun uzun işçi hattı.",
  },
  {
    id: "premium-outer",
    name: "Hastane Hattı",
    tier: "premium",
    wealthMultiplier: 2.2,
    unlockCost: 400000,
    points: PREMIUM_OUTER_ROUTE_POINTS,
    note: "Dış yola çıkan, hassas yolcu taşıyan sakin ve pahalı açılan gelişim hattı.",
  },
  {
    id: "north-loop",
    name: "Gece Hattı",
    tier: "working",
    wealthMultiplier: 1.2,
    unlockCost: 60000,
    points: NORTH_LOOP_ROUTE_POINTS,
    note: "Kuzey bloklarini dolasan kisa halka; gece vardiyasi ve ilk genisleme icin uygun.",
  },
  {
    id: "east-express",
    name: "Ekspres Hat",
    tier: "working",
    wealthMultiplier: 1.6,
    unlockCost: 180000,
    points: EAST_EXPRESS_ROUTE_POINTS,
    note: "Az duraklı, uzun düz parkurlu doğu hattı — hız limitini yükseltmeye değer.",
  },
  {
    id: "south-coast",
    name: "Sahil Hattı",
    tier: "premium",
    wealthMultiplier: 1.95,
    unlockCost: 280000,
    points: SOUTH_COAST_ROUTE_POINTS,
    note: "Güney sahil yolunu kullanan, yolcusu bol ve bahşişi yüksek turist hattı.",
  },
  {
    id: "grand-ring",
    name: "Büyük Ring",
    tier: "intercity",
    wealthMultiplier: 2.8,
    unlockCost: 650000,
    points: GRAND_RING_ROUTE_POINTS,
    note: "Şehrin en dış halkası: en uzun parkur, en zengin yolcu, en yüksek açılış bedeli.",
  },
] as const satisfies readonly RouteDefinition[];

// ---------------------------------------------------------------------------
// Hat geometrisi kaydi. Her hat icin uzunluk/durak ilerlemesi BIR KEZ hesaplanir;
// aktif hat degisince yalnizca isaretci degisir (yeniden hesap yok).
// ---------------------------------------------------------------------------

export interface RouteGeometry {
  id: string;
  definition: RouteDefinition;
  points: readonly RoutePoint[];
  length: number;
  stops: readonly CityBusStop[];
  stopCount: number;
  /** Duraklarin hat uzerindeki 0-1 ilerlemesi. */
  stopProgress: readonly number[];
}

function distance(a: RoutePoint, b: RoutePoint): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function samplePathAtLength(
  points: readonly RoutePoint[],
  cumulativeLengths: readonly number[],
  pathLength: number,
  progress: number,
): { position: RoutePoint; direction: RoutePoint } {
  const normalized = ((progress % 1) + 1) % 1;
  const targetLength = normalized * pathLength;
  for (let index = 0; index < points.length - 1; index += 1) {
    if (targetLength > cumulativeLengths[index + 1]) continue;
    const start = points[index];
    const end = points[index + 1];
    const segmentLength = Math.max(
      0.0001,
      cumulativeLengths[index + 1] - cumulativeLengths[index],
    );
    const t = Math.max(
      0,
      Math.min(1, (targetLength - cumulativeLengths[index]) / segmentLength),
    );
    return {
      position: [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ],
      direction: [
        (end[0] - start[0]) / segmentLength,
        (end[1] - start[1]) / segmentLength,
      ],
    };
  }
  return {
    position: points[0],
    direction: [points[1][0] - points[0][0], points[1][1] - points[0][1]],
  };
}

function nearestAxis(value: number, axes: readonly number[]): number {
  return axes.reduce((closest, axis) =>
    Math.abs(axis - value) < Math.abs(closest - value) ? axis : closest,
  );
}

function distanceFromNearestIntersection(
  position: RoutePoint,
  direction: RoutePoint,
): number {
  const horizontal = Math.abs(direction[0]) >= Math.abs(direction[1]);
  const along = horizontal ? position[0] : position[1];
  const crossingAxes = horizontal ? GRID.roadAxesX : GRID.roadAxesZ;
  return Math.min(...crossingAxes.map((axis) => Math.abs(axis - along)));
}

const TARGET_STOP_SPACING_METERS = 24;
const MIN_ROUTE_STOPS = 4;
const MAX_ROUTE_STOPS = 12;
const MIN_INTERSECTION_CLEARANCE_METERS = 4.8;
const MIN_STOP_SPACING_METERS = 16;

function targetStopCount(pathLength: number): number {
  return Math.max(
    MIN_ROUTE_STOPS,
    Math.min(MAX_ROUTE_STOPS, Math.round(pathLength / TARGET_STOP_SPACING_METERS)),
  );
}

function buildRouteStops(
  definition: RouteDefinition,
  points: readonly RoutePoint[],
  cumulativeLengths: readonly number[],
  pathLength: number,
): { stops: CityBusStop[]; progress: number[] } {
  const stops: CityBusStop[] = [];
  const stopProgresses: number[] = [];
  const stopCount = targetStopCount(pathLength);
  const nominalSpacing = pathLength / stopCount;
  const maxSearchMeters = Math.max(7, nominalSpacing * 0.48);
  const searchOffsetsMeters = [0];
  for (let offset = 1.5; offset <= maxSearchMeters; offset += 1.5) {
    searchOffsetsMeters.push(offset, -offset);
  }

  for (let stopIndex = 0; stopIndex < stopCount; stopIndex += 1) {
    const template = RAW_BUS_STOPS[stopIndex % RAW_BUS_STOPS.length];
    const baseProgress = (stopIndex + 0.5) / stopCount;
    let chosenProgress = baseProgress;
    let sample = samplePathAtLength(
      points,
      cumulativeLengths,
      pathLength,
      baseProgress,
    );

    let foundSafeCandidate = false;
    for (const offsetMeters of searchOffsetsMeters) {
      const candidateProgress = (baseProgress + offsetMeters / pathLength + 1) % 1;
      const candidate = samplePathAtLength(
        points,
        cumulativeLengths,
        pathLength,
        candidateProgress,
      );
      if (
        distanceFromNearestIntersection(candidate.position, candidate.direction) <
        MIN_INTERSECTION_CLEARANCE_METERS
      ) {
        continue;
      }
      const tooClose = stopProgresses.some(
        (existingProgress) =>
          Math.min(
            Math.abs(candidateProgress - existingProgress),
            1 - Math.abs(candidateProgress - existingProgress),
          ) * pathLength < MIN_STOP_SPACING_METERS,
      );
      if (tooClose) continue;
      chosenProgress = candidateProgress;
      sample = candidate;
      foundSafeCandidate = true;
      break;
    }

    // Hat geometrisi cok kisa bir blokta sikisirsa duragi kavsaga/bina kenarina
    // zorla koymak yerine o adayi atla. Kalan duraklar esit dagilimini korur.
    if (!foundSafeCandidate) continue;

    const horizontal =
      Math.abs(sample.direction[0]) >= Math.abs(sample.direction[1]);
    let modelPosition: RoutePoint;
    let rotationY: number;

    if (horizontal) {
      const roadAxis = nearestAxis(sample.position[1], GRID.roadAxesZ);
      const side = sample.direction[0] >= 0 ? 1 : -1;
      modelPosition = [
        sample.position[0],
        roadAxis + side * STOP_MODEL_OFFSET,
      ];
      rotationY = side > 0 ? 0 : Math.PI;
    } else {
      const roadAxis = nearestAxis(sample.position[0], GRID.roadAxesX);
      const side = sample.direction[1] >= 0 ? -1 : 1;
      modelPosition = [
        roadAxis + side * STOP_MODEL_OFFSET,
        sample.position[1],
      ];
      rotationY = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    }

    stops.push({
      id: `${definition.id}-stop-${String(stopIndex + 1).padStart(2, "0")}`,
      position: sample.position,
      modelPosition,
      rotationY,
      passengerSlots: template.slots,
    });
    stopProgresses.push(chosenProgress);
  }

  const ordered = stops
    .map((stop, index) => ({ stop, progress: stopProgresses[index] }))
    .sort((a, b) => a.progress - b.progress);

  return {
    stops: ordered.map((entry) => entry.stop),
    progress: ordered.map((entry) => entry.progress),
  };
}

/**
 * Every route receives evenly spaced stops on its direction-side pavement.
 * Shared stop labels remain only as passenger-capacity templates.
 */
function buildRouteGeometry(definition: RouteDefinition): RouteGeometry {
  const points = roundPathCorners(
    definition.points,
    GRID.laneWidth * 1.8,
    10,
  ) as RoutePoint[];
  const segmentLengths = points.slice(0, -1).map((point, index) => distance(point, points[index + 1]));
  const cumulativeLengths = segmentLengths.reduce<number[]>(
    (lengths, segmentLength) => {
      lengths.push(lengths[lengths.length - 1] + segmentLength);
      return lengths;
    },
    [0]
  );
  const length = cumulativeLengths[cumulativeLengths.length - 1];
  const routeStops = buildRouteStops(
    definition,
    points,
    cumulativeLengths,
    length,
  );
  const stops = routeStops.stops;

  return {
    id: definition.id,
    definition,
    points,
    length,
    stops,
    stopCount: stops.length,
    stopProgress: routeStops.progress,
  };
}

export const ROUTE_GEOMETRIES: Record<string, RouteGeometry> = Object.fromEntries(
  ROUTE_DEFINITIONS.map((definition) => [definition.id, buildRouteGeometry(definition)])
);

export const DEFAULT_ROUTE_ID = ROUTE_DEFINITIONS[0].id;

export function getRouteGeometry(routeId: string): RouteGeometry {
  return ROUTE_GEOMETRIES[routeId] ?? ROUTE_GEOMETRIES[DEFAULT_ROUTE_ID];
}

export function getRouteDefinition(routeId: string): RouteDefinition {
  return getRouteGeometry(routeId).definition;
}

// Aktif hat isaretcisi. store.setActiveRoute() bunu gunceller; simulasyon
// (GameCanvas) her karede buradan okur, boylece hat degisimi aninda gecerli olur.
let activeGeometry: RouteGeometry = ROUTE_GEOMETRIES[DEFAULT_ROUTE_ID];

export function setActiveRouteGeometry(routeId: string): void {
  activeGeometry = getRouteGeometry(routeId);
}

export function getActiveRouteGeometry(): RouteGeometry {
  return activeGeometry;
}

export function getRouteLength(): number {
  return activeGeometry.length;
}

export function getStopCount(): number {
  return activeGeometry.stopCount;
}

export function getActiveRouteStops(): readonly CityBusStop[] {
  return activeGeometry.stops;
}

export function routePoint(progress: number): [number, number] {
  const geometry = activeGeometry;
  const points = geometry.points;
  const normalized = ((progress % 1) + 1) % 1;
  const targetLength = normalized * geometry.length;

  let accumulated = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const segmentLength = distance(points[i], points[i + 1]);
    if (targetLength > accumulated + segmentLength) {
      accumulated += segmentLength;
      continue;
    }
    const start = points[i];
    const end = points[i + 1];
    const segmentProgress = segmentLength === 0 ? 0 : (targetLength - accumulated) / segmentLength;
    return [
      start[0] + (end[0] - start[0]) * segmentProgress,
      start[1] + (end[1] - start[1]) * segmentProgress,
    ];
  }

  const [x, z] = points[0];
  return [x, z];
}

export function stopProgress(stopIndex: number): number {
  const geometry = activeGeometry;
  return geometry.stopProgress[stopIndex % geometry.stopCount];
}

/**
 * Verilen progress'in ÖNÜNDEKİ ilk durağın indeksi.
 * Gezintiden güne dönerken şart: araç hattın ortasına oturuyorsa "sıradaki durak"
 * 0 kabul edilirse aradaki bütün duraklar tetiklenmeden geçilir.
 */
export function nextStopIndexAfter(progress: number): number {
  const geometry = activeGeometry;
  let bestIndex = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let index = 0; index < geometry.stopCount; index += 1) {
    const gap = (geometry.stopProgress[index] - progress + 1) % 1;
    // gap === 0 → tam üstündeyiz; bir sonrakini hedefle.
    if (gap > 1e-6 && gap < bestGap) {
      bestGap = gap;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/** Gezinti modundan güne dönerken kullanılır: verilen noktaya en yakın hat progress'i. */
const NEAREST_PROGRESS_SAMPLES = 400;
export function nearestRouteProgress(x: number, z: number): number {
  let bestProgress = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < NEAREST_PROGRESS_SAMPLES; index += 1) {
    const candidate = index / NEAREST_PROGRESS_SAMPLES;
    const [px, pz] = routePoint(candidate);
    const distance = (px - x) ** 2 + (pz - z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestProgress = candidate;
    }
  }
  return bestProgress;
}
