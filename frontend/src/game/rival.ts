import { ECONOMY } from "./economy";

// ---------------------------------------------------------------------------
// Rakip firma
//
// Gelir bugüne kadar yalnızca artıyordu; korunması gereken bir şey yoktu, bu
// yüzden filoya bakmanın da bir sebebi yoktu. Rakip o boşluğu dolduruyor:
// ihmal edilen hatta duraklar el değiştirir, iyi geçen bir günle geri alınır.
//
// Kural bilerek yavaş işler — oyuncu bir günlük kötü performansla ceza yemez,
// üst üste ihmalle yer. Sayılar: shared/economy.json > rival
// ---------------------------------------------------------------------------

export interface RivalRouteState {
  /** Biriken ihmal. Eşiği geçince bir durak rakibe gider. */
  neglectPoints: number;
  /** Rakibin bu hatta elinde tuttuğu durak sayısı. */
  stopsLost: number;
}

export type RivalState = Record<string, RivalRouteState>;

const EMPTY: RivalRouteState = { neglectPoints: 0, stopsLost: 0 };

export function rivalStateFor(rival: RivalState, routeId: string): RivalRouteState {
  return rival[routeId] ?? EMPTY;
}

/** Kaybedilen her durak o hattın talebini düşürür — gelir gözle görülür şekilde erir. */
export function rivalDemandFactor(rival: RivalState, routeId: string): number {
  const lost = rivalStateFor(rival, routeId).stopsLost;
  return Math.max(0.2, 1 - lost * ECONOMY.rival.demandPenaltyPerStop);
}

export interface RivalDayOutcome {
  rival: RivalState;
  /** Bugün sürülen hatta durak kaybedildi mi, geri alındı mı — rapor bunu söyler. */
  lostStopOnDrivenRoute: boolean;
  recoveredStopOnDrivenRoute: boolean;
}

/**
 * Gün sonunda rakip baskısını günceller.
 *
 * Sürülen hat: iyi biten gün bir durak geri kazandırır, kötü biten gün ihmali
 * hızlı büyütür, arası ihmali eritir. Sürülmeyen hatlar yavaşça ihmale düşer —
 * oyuncu hat açtıkça hepsine bakmak zorunda kalsın diye.
 */
export function applyRivalDay(
  rival: RivalState,
  unlockedRouteIds: string[],
  drivenRouteId: string,
  endOfDaySatisfaction: number,
): RivalDayOutcome {
  const config = ECONOMY.rival;
  const next: RivalState = {};
  let lostStopOnDrivenRoute = false;
  let recoveredStopOnDrivenRoute = false;

  for (const routeId of unlockedRouteIds) {
    const current = rivalStateFor(rival, routeId);
    let { neglectPoints, stopsLost } = current;

    if (routeId === drivenRouteId) {
      if (endOfDaySatisfaction >= config.recoverSatisfaction) {
        neglectPoints = 0;
        if (stopsLost > 0) {
          stopsLost -= 1;
          recoveredStopOnDrivenRoute = true;
        }
      } else if (endOfDaySatisfaction < config.poorDaySatisfaction) {
        neglectPoints += config.poorDayNeglect;
      } else {
        neglectPoints = Math.max(0, neglectPoints - 1);
      }
    } else {
      neglectPoints += config.idleNeglectPerDay;
    }

    while (neglectPoints >= config.neglectToLoseStop && stopsLost < config.maxStopsLost) {
      neglectPoints -= config.neglectToLoseStop;
      stopsLost += 1;
      if (routeId === drivenRouteId) lostStopOnDrivenRoute = true;
    }
    // Rakip her şeyi alamaz: tavana gelince ihmal birikmeye devam etmez.
    if (stopsLost >= config.maxStopsLost) neglectPoints = 0;

    next[routeId] = { neglectPoints, stopsLost };
  }

  return { rival: next, lostStopOnDrivenRoute, recoveredStopOnDrivenRoute };
}
