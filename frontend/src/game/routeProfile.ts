import { ECONOMY } from "./economy";
import { economyScore, type DriverProfile } from "./driverProfile";

// Faz 6 — Hat 2.0 (dikey dilim). Sekiz hat, kurmaca isim ve altı hattan üçünü sayısallaştırır:
// talep yoğunluğu, denetim riski ve baskın yolcu profili (bkz. shared/economy.json > routes).
// Trafik yoğunluğu ve event uyumu Faz 7 canlı şehir yönetmeniyle birlikte etkinleşecek —
// bu dilimde yalnızca ölçülebilir iki oynanış farkı (talep + risk) uygulanır.

export type RouteConfig = (typeof ECONOMY.routes)[keyof typeof ECONOMY.routes];
export type RecommendedTrait = RouteConfig["recommendedTrait"];

export function getRouteConfig(routeId: string): RouteConfig {
  return (ECONOMY.routes as Record<string, RouteConfig>)[routeId] ?? Object.values(ECONOMY.routes)[0];
}

function traitValue(driver: DriverProfile, trait: RecommendedTrait): number {
  switch (trait) {
    case "speed":
      return driver.speedMultiplier;
    case "economy":
      return economyScore(driver);
    case "punctuality":
      return driver.punctuality;
    case "service":
      return driver.service;
    case "reliability":
      return driver.reliability;
    case "coolness":
      return driver.coolness;
    default:
      return 0;
  }
}

/** Rosterdeki en uygun şoför + gerekçe (bitiş kriteri: "seçim ekranı ... gerekçesini anlatır"). */
export function recommendDriverForRoute(routeId: string): { driver: DriverProfile; trait: RecommendedTrait } {
  const config = getRouteConfig(routeId);
  const best = [...ECONOMY.drivers].sort((a, b) => traitValue(b, config.recommendedTrait) - traitValue(a, config.recommendedTrait))[0];
  return { driver: best, trait: config.recommendedTrait };
}

/** Riskli/yoğun hatlarda araç önerisi metni için eşik sınıflaması. */
export function recommendedVehicleTier(routeId: string): "standard" | "upgraded" | "premium" {
  const config = getRouteConfig(routeId);
  if (config.riskMultiplier >= 1.2 || config.demandMultiplier >= 1.15) return "premium";
  if (config.riskMultiplier >= 1 || config.demandMultiplier >= 1) return "upgraded";
  return "standard";
}

export interface RouteMasteryEntry {
  level: number;
  xp: number;
}

const MASTERY = ECONOMY.routeMastery;

export function masteryLevelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < MASTERY.levelThresholds.length; i++) {
    if (xp >= MASTERY.levelThresholds[i]) level = i + 1;
  }
  return Math.min(MASTERY.maxLevel, level);
}

export function xpForNextLevel(level: number): number | null {
  if (level >= MASTERY.maxLevel) return null;
  return MASTERY.levelThresholds[level];
}

/** Gün notuna göre bir hattın mastery XP'sini artırır (bitiş kriteri: mastery kalıcıdır — bkz. store.ts persist). */
export function advanceRouteMastery(
  mastery: Record<string, RouteMasteryEntry>,
  routeId: string,
  scorePct: number,
): Record<string, RouteMasteryEntry> {
  const current = mastery[routeId] ?? { level: 1, xp: 0 };
  const gained = Math.round(MASTERY.xpPerGoodDay * Math.max(0, Math.min(100, scorePct)) / 100);
  if (gained <= 0) return mastery;
  const xp = current.xp + gained;
  return { ...mastery, [routeId]: { xp, level: masteryLevelForXp(xp) } };
}

// ---------------------------------------------------------------------------
// Hat kuralları — her hattın kendi oynanış problemi
//
// Talep ve risk çarpanı iki hattı ayırmaya yetmiyordu: oyuncu ikisini de
// hissetmiyor, yalnızca sayıları okuyordu. Aşağıdaki kurallar hattı sürerken
// fark edilir: Üniversite sabah patlayıp gün ortası boşalır, Hastane sert fren
// affetmez, Gece geç saatte iyi öder. Mahalle hattının kuralı yoktur — orada
// oyuncu önce sürmeyi öğrenir.
// Sayılar: shared/economy.json > routes
// ---------------------------------------------------------------------------

interface RouteRushRule {
  startHour: number;
  endHour: number;
  peakMultiplier: number;
  offPeakMultiplier: number;
}

interface RouteSmoothRideRule {
  /** Bir saniyede bu kadar km/s düşüş sert fren sayılır. */
  harshBrakeKmh: number;
  harshBrakeSatisfactionPenalty: number;
  speedingPenaltyMultiplier: number;
}

interface RouteNightRule {
  startHour: number;
  endHour: number;
  fareMultiplier: number;
}

interface RouteRules {
  rush?: RouteRushRule;
  smoothRide?: RouteSmoothRideRule;
  nightShift?: RouteNightRule;
}

export function getRouteRules(routeId: string): RouteRules {
  return getRouteConfig(routeId) as RouteRules;
}

/** Hangi hattın kuralı var — gün başı ekranı bunu metne çevirir. */
export function routeRuleId(routeId: string): "rush" | "smoothRide" | "nightShift" | null {
  const rules = getRouteRules(routeId);
  if (rules.rush) return "rush";
  if (rules.smoothRide) return "smoothRide";
  if (rules.nightShift) return "nightShift";
  return null;
}

function hourOf(gameTimeMinutes: number): number {
  return Math.floor(gameTimeMinutes / 60) % 24;
}

/** Gece yarısını geçen pencereler için (20:00–06:00 gibi). */
function withinHours(hour: number, startHour: number, endHour: number): boolean {
  return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

/** Üniversite hattı: pik saatte kuyruk hızlı büyür, dışında yavaşlar. */
export function routeDemandFactorAt(routeId: string, gameTimeMinutes: number): number {
  const rush = getRouteRules(routeId).rush;
  if (!rush) return 1;
  return withinHours(hourOf(gameTimeMinutes), rush.startHour, rush.endHour)
    ? rush.peakMultiplier
    : rush.offPeakMultiplier;
}

/** Gece hattı: geç saatte ücret yüksek. */
export function routeFareFactorAt(routeId: string, gameTimeMinutes: number): number {
  const night = getRouteRules(routeId).nightShift;
  if (!night) return 1;
  return withinHours(hourOf(gameTimeMinutes), night.startHour, night.endHour) ? night.fareMultiplier : 1;
}

/** Hastane hattı: hız cezası ağırlaşır, sert fren ayrıca memnuniyet kırar. */
export function routeSpeedingPenaltyMultiplier(routeId: string): number {
  return getRouteRules(routeId).smoothRide?.speedingPenaltyMultiplier ?? 1;
}

/**
 * Ani yavaşlama memnuniyet cezası. Kuralı olmayan hatta 0 döner; hızlanma ve
 * durakta durma cezalandırılmaz — yalnızca seyir hâlindeki sert fren.
 */
export function harshBrakePenalty(routeId: string, previousKmh: number, nextKmh: number): number {
  const rule = getRouteRules(routeId).smoothRide;
  if (!rule) return 0;
  const drop = previousKmh - nextKmh;
  return drop >= rule.harshBrakeKmh && nextKmh > 5 ? rule.harshBrakeSatisfactionPenalty : 0;
}
