import { create } from "zustand";
import { applyRivalDay, rivalDemandFactor, type RivalState } from "./rival";
import { ECONOMY } from "./economy";
import {
  DEFAULT_ROUTE_ID,
  getRouteDefinition,
  getRouteLength,
  getStopCount,
  setActiveRouteGeometry,
  stopProgress,
} from "./route";
import { setCachedUsername } from "./username";
import { BUS_CATALOG, getBusCatalogEntry } from "./content/busCatalog";
import { pickPassengerLine } from "./content/passengerLines";
import { useUiStore, type FeedbackTone } from "./uiStore";
import { useProfileStore } from "./profileStore";
import { useProgressionStore } from "./progressionStore";
import {
  getTerminalEffects,
  getTerminalUpgrade,
  type TerminalUpgradeId,
} from "./terminal";
import { computeDayGrade, type DimensionBreakdown } from "./dayGrading";
import {
  generateContractOffers,
  advanceContractProgress,
  syncContractEarnProgress,
  type ActiveContract,
  type ContractOffer,
} from "./contracts";
import { resolveContract, fetchTodayEvent, type DailyEvent } from "./api";
import { track } from "./telemetry";
import { getPlayerId } from "./playerId";
import {
  getRouteConfig,
  advanceRouteMastery,
  routeDemandFactorAt,
  routeFareFactorAt,
  routeSpeedingPenaltyMultiplier,
  harshBrakePenalty,
  type RouteMasteryEntry,
} from "./routeProfile";
import { useTutorialStore } from "./tutorialStore";
import { streakFareMultiplier } from "./profileStore";

// Oyun state'i React render döngüsünden bağımsızdır (ADR-001).
// Sık değişen değerler (dolmuş pozisyonu) store'a DEÄÄ°L, useFrame içindeki ref'lere yazılır;
// store yalnızca oyunsal olaylarda (para, yolcu, karar) güncellenir.

export type DecisionChoice = "DUR" | "GEC";
export type InteractionType =
  | "overflow"
  | "student"
  | "change"
  | "offroute"
  | "dropoffStop"
  | "dropoffRoadside"
  | null;

export type GoalType = "earn" | "board" | "dur" | "offroute";
export type ShiftSlotId = "morning" | "evening" | "night";
export type ServicePlanId = "balanced" | "express" | "busyStops";

// Faz 3 — gerçek vardiya/gün. Oyuncu "Gün Başlat" der, biriken sinyaller "Gün Bitir"de notlanır.
export type DayGoalId = "earnings" | "satisfaction" | "safety";
export interface DayRunConfig {
  routeId: string;
  manual: boolean;
  goalId: DayGoalId;
}
export interface DayRunState extends DayRunConfig {
  startedAtGameMinutes: number;
  startedAtGameDay: number;
  boardings: number;
  stopsServed: number;
  stopsMissed: number;
  violations: number;
  netEarned: number;
  contractsCompleted: number;
  contractsFailed: number;
}
/**
 * Günün işletme gideri. Kalem kalem tutulur çünkü rapor bunu tek bir "gider"
 * satırı olarak gösterirse oyuncu parasının nereye gittiğini öğrenemez.
 */
export interface UpkeepBreakdown {
  /** Yakıt ve bakım — sahip olunan her araç için. */
  fleet: number;
  /** İşe alınmış şoförlerin günlük maaşı. */
  salaries: number;
  /** Haftada bir hat kirası. */
  rent: number;
  /** İki haftada bir muayene. */
  inspection: number;
  total: number;
}

export interface DayReportData {
  grade: string;
  score: number;
  xp: number;
  breakdown: DimensionBreakdown[];
  netEarned: number;
  /** Giderler düşüldükten sonra kasaya kalan. Eksi olabilir. */
  upkeep: UpkeepBreakdown;
  /** Bugun surulen hatta rakip bir durak aldi mi, geri mi verdi. */
  rivalLostStop: boolean;
  rivalRecoveredStop: boolean;
  gameDay: number;
  goalId: DayGoalId;
  /** Günün hedefi tutturuldu mu? Tutunca net kazancın bir oranı prim olarak ödenir. */
  goalMet: boolean;
  /** Hedefin hangi eşikte olduğu (raporda "X / Y" göstermek için). */
  goalTarget: number;
  goalActual: number;
  goalBonus: number;
  /** Faz 7: sürülen hat — gün sonu raporunda şehir olayının bu güne etkisini göstermek için. */
  routeId: string;
  /** Backend'e idempotent gönderim için kararlı anahtar; yenilemede çift ödül olmaz. */
  idempotencyKey: string;
}

/** Gün içi sayaçları güvenle artırır; gün başlamamışsa (null) hiçbir şey yapmaz. */
type DayRunCounter = "boardings" | "stopsServed" | "stopsMissed" | "violations" | "netEarned" | "contractsCompleted" | "contractsFailed";
function addToDayRun(dayRun: DayRunState | null, deltas: Partial<Record<DayRunCounter, number>>): DayRunState | null {
  if (!dayRun) return dayRun;
  return {
    ...dayRun,
    boardings: dayRun.boardings + (deltas.boardings ?? 0),
    stopsServed: dayRun.stopsServed + (deltas.stopsServed ?? 0),
    stopsMissed: dayRun.stopsMissed + (deltas.stopsMissed ?? 0),
    violations: dayRun.violations + (deltas.violations ?? 0),
    netEarned: dayRun.netEarned + (deltas.netEarned ?? 0),
    contractsCompleted: dayRun.contractsCompleted + (deltas.contractsCompleted ?? 0),
    contractsFailed: dayRun.contractsFailed + (deltas.contractsFailed ?? 0),
  };
}

/**
 * Şirket kurarken seçilen yönetim yaklaşımının SAYISAL karşılığı.
 * Her yaklaşımın tek ve ölçülebilir bir etkisi vardır (gizli bonus yok):
 *  - Hizmet    → durakta kazanılan memnuniyet daha yüksek
 *  - Operasyon → polis riski daha yavaş birikir
 *  - Büyüme    → filodaki ek dolmuşların pasif geliri daha yüksek
 * Değerler: `shared/economy.json > progression.strategies`
 */
type StrategyEffects = { satisfactionGainMultiplier: number; policeRiskMultiplier: number; fleetIncomeMultiplier: number };
const NEUTRAL_STRATEGY: StrategyEffects = {
  satisfactionGainMultiplier: 1,
  policeRiskMultiplier: 1,
  fleetIncomeMultiplier: 1,
};
export function strategyEffects(): StrategyEffects {
  const strategy = useProgressionStore.getState().bootstrap?.company?.strategy;
  if (!strategy) return NEUTRAL_STRATEGY;
  const table = ECONOMY.progression.strategies as Record<string, StrategyEffects | undefined>;
  return table[strategy] ?? NEUTRAL_STRATEGY;
}

/** Tur içi sayaçları güvenle artırır; tur yoksa (gezinti modu) hiçbir şey yapmaz. */
type LapRunCounter =
  | "stopsServed" | "stopsMissed" | "boardings" | "grossEarned" | "expenses"
  | "offRouteTrips" | "overflowAccepted" | "policeFines" | "policeFineAmount" | "violations";
function addToLapRun(lapRun: LapRunState | null, deltas: Partial<Record<LapRunCounter, number>>): LapRunState | null {
  if (!lapRun) return lapRun;
  const next = { ...lapRun };
  for (const [key, value] of Object.entries(deltas) as [LapRunCounter, number | undefined][]) {
    if (value) next[key] = next[key] + value;
  }
  return next;
}

/** Yükseltme kutlama kartının verisi — dolmuşun yükseltme SONRASI durumunu taşır. */
function buildCelebration(
  state: { upgradeCelebration: UpgradeCelebration | null; speedMultiplier: number; seatCapacity: number },
  kind: UpgradeKind,
  level: number,
  maxLevel: number,
  after: { speedMultiplier?: number; seatCapacity?: number },
): UpgradeCelebration {
  return {
    id: (state.upgradeCelebration?.id ?? 0) + 1,
    kind,
    level,
    maxLevel,
    speedMultiplier: after.speedMultiplier ?? state.speedMultiplier,
    seatCapacity: after.seatCapacity ?? state.seatCapacity,
  };
}

function createLapRun(routeId: string, gameTimeMinutes: number, lapIndex: number): LapRunState {
  return {
    lapIndex,
    routeId,
    startedAtGameMinutes: gameTimeMinutes,
    stopsServed: 0,
    stopsMissed: 0,
    boardings: 0,
    grossEarned: 0,
    expenses: 0,
    offRouteTrips: 0,
    overflowAccepted: 0,
    policeFines: 0,
    policeFineAmount: 0,
    violations: 0,
  };
}

/** WASD surus girdisi. Sofor kiralaninca (driverActive) yok sayilir. */
export interface DrivingInput {
  /** W = +1, S = -1, bosta 0. */
  throttle: number;
  /** A = -1 (sola), D = +1 (saga). Serit kaydirma/sollama icin. */
  steer: number;
  /** Space — guclu fren. */
  handbrake: boolean;
  /** F — kapi acik degilse durakta yolcu binmez. */
  doorsOpen: boolean;
}

export const SERVICE_PLAN_DURATION_MINUTES = 180;

export function getServicePlanEffects(plan: ServicePlanId | null): {
  speed: number;
  fare: number;
  satisfactionPerPassenger: number;
} {
  switch (plan) {
    case "express":
      return { speed: 1.14, fare: 1.08, satisfactionPerPassenger: -0.04 };
    case "busyStops":
      return { speed: 0.94, fare: 1.2, satisfactionPerPassenger: 0.03 };
    case "balanced":
      return { speed: 1.04, fare: 1.06, satisfactionPerPassenger: 0.02 };
    default:
      return { speed: 1, fare: 1, satisfactionPerPassenger: 0 };
  }
}

export interface ShiftAssignments {
  morning?: string | null;
  evening?: string | null;
  night?: string | null;
}

export interface NpcBus {
  progress: number;    // 0-1 hat üzerinde konum
  speedFactor: number; // temel hıza çarpan
}

export type ChanceRewardType = "money" | "maintenanceCoupon" | "cosmetic" | "eventPrep" | "contractReroll";

export interface ChanceGameResult {
  id: string;
  gameId: "wheel" | "plate" | "lottery" | "envelope" | "coupon" | "tombala";
  label: string;
  stake: number;
  payout: number;
  net: number;
  multiplier: number;
  tone: string;
  createdAtUtc: string;
  /** Faz 9: para dışı ödül türü — "money" dışındakiler için istemci kendi efektini uygular. */
  rewardType?: ChanceRewardType;
  cosmeticId?: string | null;
}

export interface ChanceGamesState {
  day: number;
  dailyLimitUsed: number;
  wheelSpinsToday: number;
  recentResults: ChanceGameResult[];
}
interface DecisionState {
  open: boolean;
  secondsLeft: number;
  choice: DecisionChoice | null;
}

interface InteractionState {
  type: InteractionType;
  stopIndex: number;
  secondsLeft: number;
  /** overflow: kapasitenin doldugu andaki koltuk sayısı (ekstra 1 kişi bu sayıya eklenir). */
  normalBoardingCount?: number;
  /** Duraga gelirken bu serviste inen yolcu sayisi; overflow sonrasi geri bildirimde kullanilir. */
  dropoffCount?: number;
  /** change: yolcunun uzattığı banknot. */
  billAmount?: number;
  /** change: dürüst para üstü (banknot - ücret). Beyaz seçeneğin tutarı. */
  correctChange?: number;
  /** change: kırmızı seçenekte yolcuya verilen eksik üstü (aradaki fark cebe kalır). */
  shortChange?: number;
  /** change: yeşil seçenekte yolcuya verilen fazla üstü (aradaki fark zarardır). */
  generousChange?: number;
  /** Bu olay icin secilen yolcu repligi (i18n anahtari). Havuz: content/passengerLines.ts */
  lineKey?: string;
}

/**
 * Para üstü kararı: kırmızı kazık / beyaz dürüst / yeşil ikram.
 * `timeout` süre dolunca otomatik uygulanır (kâr yok, küçük memnuniyet cezası).
 */
export type ChangeChoiceMode = "short" | "exact" | "generous" | "timeout";

/**
 * Bir hat turu (12 durak) boyunca biriken sayaçlar. Gün birden çok tur içerebilir;
 * her tur bitiminde `lapReport` üretilip sayaçlar sıfırlanır.
 * Bkz. docs/game-design/02-cekirdek-dongu.md — "Tur / gün / gezinti".
 */
export interface LapRunState {
  lapIndex: number;
  routeId: string;
  startedAtGameMinutes: number;
  stopsServed: number;
  stopsMissed: number;
  boardings: number;
  /** Yolcu bileti + bahşiş + kontrat primi (brüt gelir). */
  grossEarned: number;
  /** Ceza, ikram gibi cepten çıkan tutarlar (pozitif sayı olarak tutulur). */
  expenses: number;
  offRouteTrips: number;
  /** Kapasitenin üstünde alınan yolcu sayısı. */
  overflowAccepted: number;
  policeFines: number;
  policeFineAmount: number;
  violations: number;
}

export interface LapReportData extends LapRunState {
  endedAtGameMinutes: number;
  net: number;
}

/**
 * Yükseltme satın alınınca ekranın ortasında açılan kutlama kartının verisi.
 * Kart, alınan parçayı ve dolmuşun yükseltme sonrası GÜNCEL durumunu gösterir.
 */
export type UpgradeKind = "motor" | "seat" | "sound" | "cashRegister";
export interface UpgradeCelebration {
  id: number;
  kind: UpgradeKind;
  /** Yeni seviye (yazarkasa için 1). */
  level: number;
  /** Bu parçanın ulaşılabilir en yüksek seviyesi. */
  maxLevel: number;
  /** Karttaki "dolmuşun güncel durumu" özeti. */
  speedMultiplier: number;
  seatCapacity: number;
}

/** Yolcu memnuniyetsizliğinin görünür sebebi. */
export type MoodReason = "speeding" | "harshBrake";
/** Sebep etiketi bu kadar saniye ekranda kalır. */
const MOOD_REASON_VISIBLE_SECONDS = 2.5;
/** Günün olay kartının duyurulduğu oyun saati (dakika cinsinden): 12:00. */
const EVENT_ANNOUNCE_MINUTE = 720;

/** Kesilen trafik cezasının ekranda gösterilecek kaydı. */
export interface PenaltyCardData {
  id: number;
  offence: "speeding" | "offRoute" | "overflow" | "shortChange";
  /** Bu ihlalden yazılan ceza puanı. */
  points: number;
  fine: number;
  /** Ceza sonrası toplam ehliyet puanı. */
  totalPoints: number;
  /** true: 100 puana ulaşıldı, araç kilitlendi. */
  suspended: boolean;
}

/** Durakta tahsil edilen tutarın tek seferlik gösterim kaydı (tycoon "kasa" hissi). */
export interface StopPayout {
  /** Her tahsilat için artan sayaç — aynı tutar üst üste gelse de efekt yeniden tetiklenir. */
  id: number;
  stopIndex: number;
  amount: number;
  boarded: number;
  alighted: number;
}

export interface UpgradesState {
  motorLevel: number;
  seatLevel: number;
  soundLevel: number;
  hasCashRegister: boolean;
}

export interface SecondLineState {
  unlocked: boolean;
  hasDriver: boolean;
}

export interface OwnedBus {
  id: string;
  name: string;
  driverAssignedId: string | null;
  color: string;
}

export type DriverProfile = (typeof ECONOMY.drivers)[number];

export interface GameSnapshot {
  saveVersion: number;
  money: number;
  satisfaction: number;
  stopsWaiting: number[];
  passengersOnBoard?: number;
  nextStopDropoffs?: number;
  seatCapacity: number;
  upgrades: UpgradesState;
  busUpgrades?: Record<string, UpgradesState>;
  hiredDriverId: string | null;
  secondLine: SecondLineState;
  hasCheckpoint: boolean;
  ownedBuses?: OwnedBus[];
  driverAssignments?: Record<string, ShiftAssignments>;
  driverShiftMinutes?: Record<string, number>;
  driverMorale?: Record<string, number>;
  routeMastery?: Record<string, RouteMasteryEntry>;
  rival?: RivalState;
  /** Faz 8: paket bazlı tutorial tamamlanma/atlama durumu. */
  tutorialStatus?: Record<string, string>;
  chanceGames?: ChanceGamesState;
  servicePlan?: ServicePlanId | null;
  servicePlanMinutesLeft?: number;
  terminalUpgrades?: TerminalUpgradeId[];
  unlockedRoutes?: string[];
  activeRouteId?: string;
  ownedBusIds?: string[];
  activeBusId?: string;
  gameTimeMinutes?: number;
  gameDay?: number;
  licencePoints?: number;
  policeRisk?: number;
  shortChangeStreak?: number;
  vehicleLockSecondsLeft?: number;
  /** Yalnızca sunucudan gelir (yanıtta) — PUT isteğinde gönderilmez, kullanıcı adı ayrı uçla ayarlanır. */
  username?: string | null;
}

/** Lider sekmenin diğer sekmelere yaydığı salt-veri anlık görüntü (bkz. ADR-004). */
export interface BroadcastPayload {
  money: number;
  satisfaction: number;
  stopsWaiting: number[];
  passengersOnBoard: number;
  nextStopDropoffs: number;
  seatCapacity: number;
  upgrades: UpgradesState;
  busUpgrades: Record<string, UpgradesState>;
  hiredDriverId: string | null;
  driverActive: boolean;
  secondLine: SecondLineState;
  hasCheckpoint: boolean;
  ownedBuses: OwnedBus[];
  /** busId -> sabah/aksam/gece sofor atamalari. Ana arac id'si "main". */
  driverAssignments: Record<string, ShiftAssignments>;
  driverShiftMinutes: Record<string, number>;
  driverMorale: Record<string, number>;
  /** Faz 6: hat basina mastery seviye/XP. Gun sonu notuyla artar, sunucuda kalicidir. */
  routeMastery: Record<string, RouteMasteryEntry>;
  rival: RivalState;
  /** Faz 7: bugunun sehir olayi (sunucu uretir) + oyuncu "hazirlik" secimi. */
  cityEvent: DailyEvent | null;
  eventPrepared: boolean;
  /** Dolmuşun ana hat üzerindeki konumu (0-1) — izleyici sekmenin 3B render'ı bunu kullanır. */
  busProgress: number;
  decision: DecisionState;
  interaction: InteractionState;
  /** Hat dışı sefer: izleyici sekme de kasa efektini ve duran dolmuşu doğru göstersin. */
  detourActive: boolean;
  detourSecondsLeft: number;
  detourEarned: number;
  /** Durak tahsilatı sinyali — izleyici sekmede de +₺ patlaması oynar. */
  stopPayout: StopPayout | null;
  // Zaman / hız / polis
  gameTimeMinutes: number;
  gameDay: number;
  licencePoints: number;
  shortChangeStreak: number;
  vehicleLockSecondsLeft: number;
  speedLimitKmh: number;
  /** Birleşik polis riski (0-100): hız + hat dışı + sürücü yorgunluğu. */
  policeRisk: number;
  policeLevel: number;
  suspensionMinutesLeft: number;
  // İniş talepleri
  stopDropoffPromised: boolean;
  roadsidePauseLeft: number;
  // Günlük
  dailyEarnings: number;
  activeContracts: ActiveContract[];
  contractOffers: ContractOffer[];
  dayRun: DayRunState | null;
  dayReport: DayReportData | null;
  /** Sürülmekte olan hat turu. `dayRun === null` ise gün yok = gezinti modu. */
  lapRun: LapRunState | null;
  lapReport: LapReportData | null;
  npcBuses: NpcBus[];
  chanceGames: ChanceGamesState;
  servicePlan: ServicePlanId | null;
  servicePlanMinutesLeft: number;
  terminalUpgrades: TerminalUpgradeId[];
}

interface GameState {
  money: number;
  passengersOnBoard: number;
  /** Bir sonraki durakta inecek yolcu sayısı. Kalan yolcular araçta kalır. */
  nextStopDropoffs: number;
  seatCapacity: number;
  /** 0-100: duraklardaki talebi (kuyruk birikme hızını) etkiler. */
  satisfaction: number;
  /** Satın alınan ek dolmuşlar (oyuncunun ana aracı hariç). */
  ownedBuses: OwnedBus[];
  /** busId -> sabah/aksam/gece sofor atamalari. Ana arac id'si "main". */
  driverAssignments: Record<string, ShiftAssignments>;
  /** Sürücü başına bugün çalıştığı oyun dakikası. Yeni günde sıfırlanır. */
  driverShiftMinutes: Record<string, number>;
  /** Faz 5: sofor basina moral (0-100). Iyi/kotu gun notuyla degisir; atama ekraninda gosterilir. */
  driverMorale: Record<string, number>;
  /** Faz 6: hat basina mastery seviye/XP. Sunucuda kalicidir. */
  routeMastery: Record<string, RouteMasteryEntry>;
  rival: RivalState;
  /** Faz 7: bugunun sehir olayi + hazirlik secimi. Yeni gunde sunucudan yeniden cekilir. */
  cityEvent: DailyEvent | null;
  eventPrepared: boolean;
  fetchCityEvent: () => Promise<void>;
  prepareForEvent: () => void;
  /** Her durakta bekleyen yolcu sayısı (bkz. content/scene.ts'teki STOP_COUNT ile aynı uzunluk). */
  stopsWaiting: number[];
  decision: DecisionState;
  interaction: InteractionState;
  upgrades: UpgradesState;
  /** Katalog araci bazinda kalici yukseltmeler. `upgrades` aktif aracin hizli erisim kopyasidir. */
  busUpgrades: Record<string, UpgradesState>;
  /** Motor yükseltmesinden gelen hız çarpanı (1 = temel). */
  speedMultiplier: number;
  /** Tutulan dolmuşçunun id'si — economy.ts'teki drivers dizisinden (bkz. docs/kemal/dolmusculer.md). */
  hiredDriverId: string | null;
  /** true: dolmuş şoförle otomatik çalışır, oyuncu kararlara karışmaz (dolmuşçunun verimiyle). */
  driverActive: boolean;
  /**
   * Oyuncunun "kendim sürerim" tercihi. Vardiyada atanmış bir şoför olsa bile
   * direksiyonu oyuncuda tutar (bkz. resolveShiftDriver).
   */
  manualOverride: boolean;

  /** 0-100: hat dışı seferlerde dolar; detour sonunda yakalanma ihtimalini belirler (iç kullanım). */
  attention: number;
  /** Birleşik polis riski (0-100): hız + hat dışı + sürücü yorgunluğu tüm kaynaklardan birikir. */
  policeRisk: number;
  detourActive: boolean;
  detourSecondsLeft: number;
  /** Hat dışı seferde şu ana kadar biriken ücret — ortadaki kasa efektini besler. */
  detourEarned: number;
  /** Hat dışı seferin toplam getirisi (kabul anında sabitlenir). */
  detourTotal: number;
  /** Son durak tahsilatı — StopPayoutFx bunu görünce "+₺" patlaması oynatır. */
  stopPayout: StopPayout | null;
  secondLine: SecondLineState;

  /** Aşama 5: link=şehir savunması — korsan seferci yakalanırsa 2 katını öder. */
  hasCheckpoint: boolean;
  /** Aşama 5: claim edilmiş kullanıcı adı (backend'de benzersiz) — yoksa null. */
  username: string | null;
  buyCheckpoint: () => void;
  setUsername: (username: string | null) => void;
  /** Ziyaretçilerin bıraktığı bahşiş/çaldığı para gibi, sunucu tarafında oluşan ve istemcinin
   * bilmediği kazanç/kayıpları yerel state'e yansıtır (bkz. AutoSave.tsx — periyodik senkron). */
  applyExternalGain: (amount: number) => void;

  // Oyun saati — bkz. economy.ts time bloğu
  gameTimeMinutes: number;
  gameDay: number;
  tickGameTime: (deltaSeconds: number) => void;
  isNight: () => boolean;

  // Faz 3 — gün döngüsü (Gün Başlat → sür → Gün Bitir + not)
  dayRun: DayRunState | null;
  dayReport: DayReportData | null;
  lapRun: LapRunState | null;
  lapReport: LapReportData | null;
  /** Her `startDay` çağrısında artar — GameCanvas dolmuşu hattın BAŞINA alır. */
  dayStartToken: number;
  /** Günün olay kartının gösterildiği oyun günü — her gün 12:00'de bir kez açılır. */
  eventCardDay: number | null;
  /** true: büyük olay kartı ekranda. */
  eventCardOpen: boolean;
  /** Yolcuların memnuniyetsizlik SEBEBİ — emoji balonunda gösterilir. */
  moodReason: MoodReason | null;
  /** Sebep etiketinin ekranda kalan süresi (gerçek saniye). */
  moodReasonLeft: number;
  /** Ehliyet ceza puanı (0-100). 100'e ulaşınca para cezası + araç kilidi. */
  licencePoints: number;
  /** > 0: araç kilitli, sürülemez (ehliyet cezası). Gerçek saniye. */
  vehicleLockSecondsLeft: number;
  /** Peş peşe kazık sayacı — her 5'te bir ceza puanı yazılır. */
  shortChangeStreak: number;
  /** Son kesilen ceza — PenaltyCard bunu görünce kartı açar. */
  penaltyCard: PenaltyCardData | null;
  /**
   * Son yükseltme kutlaması — UpgradeCelebrationCard bunu görünce kartı açar.
   * Sekmeler arası yayınlanmaz: kutlama, satın almayı YAPAN sekmenin olayıdır.
   */
  upgradeCelebration: UpgradeCelebration | null;
  /** Yeni açılan terminal tesisi — kamera etrafında döner, altında tanıtım kartı çıkar. */
  terminalUnveil: TerminalUpgradeId | null;
  startDay: (config: DayRunConfig) => void;
  endDay: () => void;
  /** Hat raporundan "Tekrar Sür": rapor kapanır, yeni tur sayaçları başlar. */
  startNextLap: () => void;
  /** Hat raporundan "Gezinti Modu": gün biter (gün raporu çıkar), serbest gezintiye dönülür. */
  returnToRoam: () => void;
  dismissUpgradeCelebration: () => void;
  dismissTerminalUnveil: () => void;
  dismissPenaltyCard: () => void;
  tickPassengerMood: (deltaSeconds: number) => void;
  dismissEventCard: () => void;
  dismissDayReport: () => void;

  // Oyuncu hız kontrolü (dolmuşçu modunda kilitli)
  speedLimitKmh: number;
  /** Aktif hat + acilmis hatlar (Faz 4). Acilis bedeli sunucuda tahsil edilir. */
  activeRouteId: string;
  unlockedRouteIds: string[];
  unlockRoute: (routeId: string) => void;
  setActiveRoute: (routeId: string) => void;
  /** Garaj: surulen dolmus + sahip olunan katalog araclari (Faz 4). */
  activeBusId: string;
  ownedBusIds: string[];
  buyCatalogBus: (busId: string) => void;
  setActiveBus: (busId: string) => void;
  increaseSpeed: () => void;
  decreaseSpeed: () => void;
  /** Anlik gosterge hizi (km/h) — GameCanvas her karede yazar, HUD okur. */
  currentSpeedKmh: number;
  setCurrentSpeedKmh: (kmh: number) => void;
  /** WASD sürüş girdisi (şoför aktifken yok sayılır). */
  driving: DrivingInput;
  setDrivingInput: (input: Partial<DrivingInput>) => void;
  toggleDoors: () => void;
  tickSpeedRisk: (deltaSeconds: number) => void;
  /** İsteğe bağlı, üç oyun saati süren vardiya emri. Seçilmezse idle akış normal devam eder. */
  servicePlan: ServicePlanId | null;
  servicePlanMinutesLeft: number;
  chooseServicePlan: (plan: ServicePlanId) => void;

  // Merkez terminal yatırımları
  terminalUpgrades: TerminalUpgradeId[];
  buyTerminalUpgrade: (id: TerminalUpgradeId) => void;
  tickTerminal: (deltaSeconds: number) => void;

  // Yolcu iniş talepleri
  /** true: oyuncu durakta indireceğini söyledi — GEÇ seçerse ceza */
  stopDropoffPromised: boolean;
  /** > 0: bu kadar saniye sonra "müsait yerde?" talebi tetiklenecek */
  roadsidePendingDelay: number;
  /** > 0: müsait iniş kabul edildi, dolmuş bu süre duruyor */
  roadsidePauseLeft: number;

  resolveDropoffStop: (accept: boolean) => void;
  resolveDropoffRoadside: (accept: boolean) => void;
  deferRoadsideDropoff: () => void;
  tickRoadsideDelay: (deltaSeconds: number) => void;
  tickRoadsidePause: (deltaSeconds: number) => void;

  // Kademeli trafik cezası: 0=temiz, 1-2=para cezası, 3=ehliyet askı, 4=araç el koyma
  policeLevel: number;
  suspensionMinutesLeft: number;
  policeAlert: { message: string; level: number } | null;
  isSuspended: () => boolean;
  buyNewVehicle: () => void;
  dismissPoliceAlert: () => void;

  /** Sekme-arası: bu sekme simülasyonu çalıştıran "lider" mi (bkz. ADR-004 + tabSync.ts). */
  isLeader: boolean;
  /** Lider sekmenin dolmuş konumu (0-1) — izleyici sekmeler bunu render eder, kendileri hesaplamaz. */
  busProgress: number;

  setLeader: (isLeader: boolean) => void;
  setBusProgress: (progress: number) => void;
  getBroadcastPayload: () => BroadcastPayload;
  applyBroadcastState: (payload: BroadcastPayload) => void;

  growStopQueues: (deltaSeconds: number) => void;
  applySoundSystem: (deltaSeconds: number) => void;
  openDecision: () => void;
  tickDecision: (deltaSeconds: number) => void;
  chooseDecision: (choice: DecisionChoice) => void;
  autoChooseDur: () => void;
  tickInteraction: (deltaSeconds: number) => void;
  resolveOverflow: (accept: boolean) => void;
  resolveStudent: (accept: boolean) => void;
  resolveStudentFree: () => void;
  resolveChange: (mode: ChangeChoiceMode) => void;
  /** Durağa fiilen varılınca çağrılır: DUR/GEÇ seçimini uygular (yoksa DUR varsayar). */
  resolveArrivalAtStop: (stopIndex: number) => DecisionChoice | null;

  buyMotorUpgrade: () => void;
  buySeatUpgrade: () => void;
  buySoundUpgrade: () => void;
  buyCashRegister: () => void;
  hireDriver: (driverId: string) => void;
  fireDriver: () => void;
  toggleDriverActive: () => void;
  getActiveDriver: () => DriverProfile | null;
  /** Ek dolmuş satın al (purchaseCosts[index]). */
  buyBus: () => void;
  /** Ek dolmuşa şoför ata. */
  assignDriverToBus: (busId: string, driverId: string) => void;
  /** Ek dolmuştan şoförü çıkar. */
  unassignDriverFromBus: (busId: string) => void;
  assignDriverShift: (busId: string, shiftId: ShiftSlotId, driverId: string) => void;
  unassignDriverShift: (busId: string, shiftId: ShiftSlotId) => void;
  /** Ek dolmuşlardan pasif gelir üret + sürücü vardiya dakikalarını artır. */
  tickOwnedBuses: (deltaSeconds: number) => void;

  resolveOffRoute: (accept: boolean) => void;
  tickDetour: (deltaSeconds: number) => void;

  unlockSecondLine: () => void;
  hireSecondLineDriver: () => void;
  tickSecondLine: (deltaSeconds: number) => void;

  getSnapshot: () => GameSnapshot;
  loadSnapshot: (snapshot: GameSnapshot) => void;

  // Günlük istatistikler
  dailyEarnings: number;

  // Faz 4 — kontrat motoru (bkz. contracts.ts): teklif havuzu + kabul edilen kontratlar.
  activeContracts: ActiveContract[];
  contractOffers: ContractOffer[];
  recentContractFamilyIds: string[];
  refreshContractOffers: () => void;
  acceptContract: (offerId: string) => void;
  abandonContract: (contractId: string) => void;

  chanceGames: ChanceGamesState;
  applyChanceGameResult: (money: number, chanceGames: ChanceGamesState, result?: ChanceGameResult) => void;
  /** Faz 9: para dışı şans ödülleri. */
  freeEventPrepCredits: number;
  ownedCosmetics: string[];

  // NPC rakip dolmuşlar
  npcBuses: NpcBus[];
  tickNpcBuses: (deltaSeconds: number) => void;
}

// ---------------------------------------------------------------------------
// Yardımcı fonksiyonlar
// ---------------------------------------------------------------------------

/**
 * Bir günün işletme gideri. Şimdiye kadar hiçbir şey tahsil edilmiyordu: para
 * yalnızca artıyor, dolayısıyla bir süre sonra anlamını yitiriyordu. Filo
 * büyüdükçe gider de büyür — araç almak bir karar hâline gelir.
 * Sayılar: shared/economy.json > upkeep
 */
function computeDayUpkeep(
  ownedBusCount: number,
  hiredDriverIds: string[],
  gameDay: number,
): UpkeepBreakdown {
  const config = ECONOMY.upkeep;
  const fleet = Math.max(1, ownedBusCount) * config.busPerDay;
  const salaries = hiredDriverIds.reduce((total, driverId) => {
    const driver = ECONOMY.drivers.find((d) => d.id === driverId);
    return total + (driver ? getDriverDailySalary(driver) : 0);
  }, 0);
  const rent = gameDay % config.weeklyRentEveryDays === 0 ? config.weeklyRent : 0;
  const inspection = gameDay % config.inspectionEveryDays === 0 ? config.inspectionCost : 0;
  return { fleet, salaries, rent, inspection, total: fleet + salaries + rent + inspection };
}

function isNightTime(gameTimeMinutes: number): boolean {
  const hour = Math.floor(gameTimeMinutes / 60) % 24;
  return hour >= ECONOMY.time.nightStartHour || hour < ECONOMY.time.nightEndHour;
}

function formatGameTime(gameTimeMinutes: number): string {
  const h = Math.floor(gameTimeMinutes / 60) % 24;
  const m = Math.floor(gameTimeMinutes % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export { formatGameTime, isNightTime };

/** Oyun saatine göre aktif tarifeyi döner. TopNav ve fare hesaplarında kullanılır. */
export function getTariffInfo(gameTimeMinutes: number): {
  multiplier: number;
  label: string;
  /** Binen her yolcu başına memnuniyet değişimi (negatif = azalır, pozitif = artar). */
  satDelta: number;
} {
  const hour = Math.floor(gameTimeMinutes / 60) % 24;
  const { tariff } = ECONOMY;
  if (hour >= tariff.morningPeak.startHour && hour < tariff.morningPeak.endHour)
    return { multiplier: tariff.morningPeak.multiplier, label: tariff.morningPeak.label, satDelta: tariff.morningPeak.satDeltaPerPassenger };
  if (hour >= tariff.eveningPeak.startHour && hour < tariff.eveningPeak.endHour)
    return { multiplier: tariff.eveningPeak.multiplier, label: tariff.eveningPeak.label, satDelta: tariff.eveningPeak.satDeltaPerPassenger };
  if (hour >= ECONOMY.time.nightStartHour || hour < ECONOMY.time.nightEndHour)
    return { multiplier: tariff.night.multiplier, label: tariff.night.label, satDelta: tariff.night.satDeltaPerPassenger };
  return { multiplier: tariff.normal.multiplier, label: tariff.normal.label, satDelta: tariff.normal.satDeltaPerPassenger };
}

/** Aktif kontratlardan tamamlananları XP/itibar için sunucuya bildirir (bkz. contracts.ts). */
function settleCompletedContracts(justCompleted: ActiveContract[]): void {
  if (justCompleted.length === 0) return;
  const playerId = getPlayerId();
  for (const contract of justCompleted) {
    track("contract_completed", { familyId: contract.familyId, contractId: contract.id, reward: contract.reward });
    if (!playerId) continue;
    resolveContract(playerId, {
      idempotencyKey: `contract:${contract.id}`,
      contractId: contract.id,
      familyId: contract.familyId,
      bonusIds: contract.bonusIds,
      outcome: "completed",
      gameDay: contract.acceptedAtGameDay,
    }).then((res) => useProgressionStore.getState().setBootstrap(res.bootstrap)).catch(() => {});
  }
}

/** Süresi dolan (gün değişiminde tamamlanmamış) kontratları başarısız olarak kapatır. */
function settleFailedContracts(failed: ActiveContract[]): void {
  if (failed.length === 0) return;
  const playerId = getPlayerId();
  for (const contract of failed) {
    track("contract_failed", { familyId: contract.familyId, contractId: contract.id, reason: "day_ended" });
    if (!playerId) continue;
    resolveContract(playerId, {
      idempotencyKey: `contract:${contract.id}`,
      contractId: contract.id,
      familyId: contract.familyId,
      bonusIds: contract.bonusIds,
      outcome: "failed",
      gameDay: contract.acceptedAtGameDay,
    }).catch(() => {});
  }
}

export const SAVE_VERSION = 2;

// PERF birikticileri: zustand her `set` cagrisinda TUM abonelere haber verir. Yuksek
// frekansli tikleri ekranda gorunen cozunurluge indirmek icin kesirli artislari store
// DISINDA biriktiriyoruz — hassasiyet korunur, gereksiz abone suprumu ortadan kalkar.
let pendingGameMinutes = 0;
let pendingQueueSeconds = 0;

function clampSatisfaction(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Faz 7: aktif şehir olayının bu an için etkisi. Olay yalnızca kendi `affectedRouteId`'siyle
 * eşleşen hatta sürülürken uygulanır (bitiş kriteri: "event'li aynı hat farklı karar gerektirir").
 * "Hazırlık" alınmışsa risk/olumsuz ücret/memnuniyet etkisi `counterEffectRatio` ile yarıya iner;
 * talep/olumlu etkiler dokunulmadan kalır (kaçırılmaz, sadece riski yönetirsin).
 */
function activeEventEffects(s: GameState): {
  demandMultiplier: number;
  riskMultiplier: number;
  fareMultiplier: number;
  satisfactionDriftPerSecond: number;
} {
  const neutral = { demandMultiplier: 1, riskMultiplier: 1, fareMultiplier: 1, satisfactionDriftPerSecond: 0 };
  if (!s.cityEvent || s.cityEvent.affectedRouteId !== s.activeRouteId) return neutral;
  const ratio = s.eventPrepared ? s.cityEvent.counterEffectRatio : 1;
  const templates = [s.cityEvent.primary, s.cityEvent.secondary].filter((t): t is NonNullable<typeof t> => t != null);
  let demandMultiplier = 1;
  let riskMultiplier = 1;
  let fareMultiplier = 1;
  let satisfactionDriftPerSecond = 0;
  for (const template of templates) {
    demandMultiplier *= 1 + template.demandDelta;
    riskMultiplier *= 1 + template.riskDelta * ratio;
    fareMultiplier *= 1 + (template.fareDelta < 0 ? template.fareDelta * ratio : template.fareDelta);
    satisfactionDriftPerSecond += template.satisfactionDrift < 0 ? template.satisfactionDrift * ratio : template.satisfactionDrift;
  }
  return { demandMultiplier, riskMultiplier, fareMultiplier, satisfactionDriftPerSecond };
}

function findDriver(driverId: string | null): DriverProfile | null {
  return ECONOMY.drivers.find((d) => d.id === driverId) ?? null;
}

const MAIN_BUS_ID = "main";
const MAX_MANUAL_DOOR_OPEN_SPEED_KMH = 2;
const REAL_SECONDS_PER_GAME_DAY = 1440 / ECONOMY.time.gameMinutesPerRealSecond;
const SHIFT_REAL_SECONDS = REAL_SECONDS_PER_GAME_DAY / 3;

function getActiveShiftId(gameTimeMinutes: number): ShiftSlotId {
  const hour = Math.floor((gameTimeMinutes % 1440) / 60);
  if (hour >= 8 && hour < 16) return "morning";
  if (hour >= 16) return "evening";
  return "night";
}

/**
 * Ana dolmuşu ŞU ANDA kim sürüyor?
 *
 * Şoför, yalnızca ATANDIĞI vardiyanın saatlerinde direksiyona geçer. Eskiden
 * `assignDriverShift` atama anında `driverActive = true` yapıyordu; bu yüzden
 * gece 03:00'te sabah (08–16) vardiyasına şoför atayınca şoför hemen devralıyordu.
 *
 * `manualOverride` oyuncunun "kendim sürerim" tercihidir ve her zaman kazanır.
 */
function resolveShiftDriver(state: {
  driverAssignments: Record<string, ShiftAssignments>;
  ownedBuses: OwnedBus[];
  hiredDriverId: string | null;
  gameTimeMinutes: number;
  manualOverride: boolean;
}): { hiredDriverId: string | null; driverActive: boolean } {
  const assignments = normalizeDriverAssignments(
    state.ownedBuses,
    state.driverAssignments,
    null,
  );
  const shiftId = getActiveShiftId(state.gameTimeMinutes);
  const driverId = assignments[MAIN_BUS_ID]?.[shiftId] ?? null;
  return {
    hiredDriverId: driverId,
    driverActive: driverId !== null && !state.manualOverride,
  };
}

function getShiftIncomeMultiplier(shiftId: ShiftSlotId): number {
  return shiftId === "night" ? (ECONOMY.shifts.nightIncomeMultiplier as number) : 1;
}

function getBusDailyGrossIncome(busId: string): number {
  if (busId === MAIN_BUS_ID) return ECONOMY.shifts.mainBusDailyGrossIncome as number;
  return (ECONOMY.extraBuses.dailyGrossIncome as number | undefined) ?? ECONOMY.extraBuses.idleIncomePerSecond * REAL_SECONDS_PER_GAME_DAY;
}

function getDriverDailySalary(driver: DriverProfile): number {
  return (driver.dailySalary as number | undefined) ?? driver.hireCost;
}

function netShiftIncomePerSecond(busId: string, shiftId: ShiftSlotId, driver: DriverProfile): number {
  const grossPerShift = (getBusDailyGrossIncome(busId) / 3) * getShiftIncomeMultiplier(shiftId);
  const netPerShift = grossPerShift * driver.efficiency - getDriverDailySalary(driver);
  return Math.max(0, netPerShift / SHIFT_REAL_SECONDS);
}

function normalizeDriverAssignments(
  ownedBuses: OwnedBus[],
  assignments: Record<string, ShiftAssignments> | undefined,
  legacyMainDriverId: string | null
): Record<string, ShiftAssignments> {
  const normalized: Record<string, ShiftAssignments> = { ...(assignments ?? {}) };
  normalized[MAIN_BUS_ID] = { ...(normalized[MAIN_BUS_ID] ?? {}) };
  if (legacyMainDriverId && !normalized[MAIN_BUS_ID].morning) normalized[MAIN_BUS_ID].morning = legacyMainDriverId;

  for (const bus of ownedBuses) {
    normalized[bus.id] = { ...(normalized[bus.id] ?? {}) };
    if (bus.driverAssignedId && !normalized[bus.id].morning) normalized[bus.id].morning = bus.driverAssignedId;
  }

  return normalized;
}

// Para üstü artık bir aritmetik bilmecesi değil, bir dürüstlük kararı:
// kırmızı = eksik üstü (kazık), beyaz = tam üstü, yeşil = fazla üstü (ikram).
// Üç tutar da oyuncuya açıkça gösterilir; gizli ceza yok.
// Bkz. docs/game-design/03-surus-mekanigi.md — "Para üstü kararı".
function buildChangeChallenge(): {
  billAmount: number;
  correctChange: number;
  shortChange: number;
  generousChange: number;
} {
  const fare = ECONOMY.fare.full;
  const bills = ECONOMY.events.changeBillOptions.filter((b) => b > fare);
  const billAmount = bills[Math.floor(Math.random() * bills.length)];
  const correctChange = Math.round(billAmount - fare);
  const { shortChangeKeepRatio, generousExtraRatio } = ECONOMY.events.changeChoice;
  // Kazıkta cebe kalan pay, ikramda cepten çıkan pay — ikisi de tam sayıya yuvarlanır.
  const keep = Math.max(1, Math.round(correctChange * shortChangeKeepRatio));
  const extra = Math.max(1, Math.round(fare * generousExtraRatio));
  return {
    billAmount,
    correctChange,
    shortChange: Math.max(0, correctChange - keep),
    generousChange: correctChange + extra,
  };
}

// ---------------------------------------------------------------------------
// Başlangıç state değerleri
// ---------------------------------------------------------------------------
const initialDecision: DecisionState = { open: false, secondsLeft: 0, choice: null };
const initialInteraction: InteractionState = { type: null, stopIndex: -1, secondsLeft: 0 };
const initialUpgrades: UpgradesState = {
  motorLevel: 0,
  seatLevel: 0,
  soundLevel: 0,
  hasCashRegister: false,
};

function upgradesForBus(busUpgrades: Record<string, UpgradesState>, busId: string): UpgradesState {
  return busUpgrades[busId] ?? { ...initialUpgrades };
}

function seatCapacityForBus(busId: string, upgrades: UpgradesState): number {
  const catalogSeats = getBusCatalogEntry(busId)?.seats ?? ECONOMY.bus.baseSeatCapacity;
  const capacities = ECONOMY.upgrades.seatCapacityLevels as number[];
  const baseCapacity = capacities[0] ?? ECONOMY.bus.baseSeatCapacity;
  const upgradedCapacity = capacities[upgrades.seatLevel] ?? baseCapacity;
  return catalogSeats + Math.max(0, upgradedCapacity - baseCapacity);
}

function speedMultiplierForBus(busId: string, upgrades: UpgradesState): number {
  const catalogMultiplier = getBusCatalogEntry(busId)?.speedMultiplier ?? 1;
  return catalogMultiplier * (1 + ECONOMY.upgrades.motorSpeedBonusPerLevel * upgrades.motorLevel);
}
const initialSecondLine: SecondLineState = { unlocked: false, hasDriver: false };
const initialChanceGames: ChanceGamesState = {
  day: 1,
  dailyLimitUsed: 0,
  wheelSpinsToday: 0,
  recentResults: [],
};
const BUS_COLORS = ECONOMY.extraBuses.colors as string[];

// Rakip minibüsler başlangıç haritasında kapalıdır. Oyuncu bir araçla başlar;
// yeni minibüsler yalnızca satın alma sistemi üzerinden filoya eklenir.
const initialNpcBuses: NpcBus[] = [];

function normalizeChanceGames(chanceGames: ChanceGamesState | undefined, day: number): ChanceGamesState {
  if (!chanceGames || chanceGames.day !== day) {
    return { ...initialChanceGames, day };
  }
  const recentResultLimit = ECONOMY.chanceGames.recentResultLimit as number;
  return {
    day,
    dailyLimitUsed: Math.max(0, chanceGames.dailyLimitUsed),
    wheelSpinsToday: Math.max(0, chanceGames.wheelSpinsToday),
    recentResults: (chanceGames.recentResults ?? []).slice(0, recentResultLimit),
  };
}

// ---------------------------------------------------------------------------
// Ana store
// ---------------------------------------------------------------------------
/**
 * Kayittan gelen aktif hat: yalnizca ACILMIS hatlardan biri olabilir; degilse
 * baslangic hattina duseriz. Geometri isaretcisi de burada cevrilir ki
 * yukleme sonrasi ilk kare dogru hattı kullansin.
 */
function resolveLoadedRouteId(snapshot: GameSnapshot): string {
  const unlocked = snapshot.unlockedRoutes?.length ? snapshot.unlockedRoutes : [DEFAULT_ROUTE_ID];
  const candidate = snapshot.activeRouteId ?? DEFAULT_ROUTE_ID;
  const routeId = unlocked.includes(candidate) ? candidate : DEFAULT_ROUTE_ID;
  setActiveRouteGeometry(routeId);
  useUiStore.getState().selectRouteOverlay(routeId);
  return routeId;
}

export const useGameStore = create<GameState>((set, get) => {
  function showFeedback(tone: FeedbackTone, title: string, message: string) {
    useUiStore.getState().showFeedback(tone, title, message);
  }

  /** Åoför modundaki fare çarpanı: verim × (1 - maaş payı). */
  function driverFareMultiplier(): number {
    if (!get().driverActive) return 1;
    const driver = findDriver(get().hiredDriverId);
    if (!driver) return 1;
    return driver.efficiency * (1 - driver.salaryShare);
  }

  function routeFareMultiplier(): number {
    return getRouteDefinition(get().activeRouteId).wealthMultiplier;
  }

  function currentPassengerFare(baseFare: number): number {
    const tariff = getTariffInfo(get().gameTimeMinutes).multiplier;
    // Gece hattı geç saatte iyi öder — riski zaten yüksekti, karşılığı burada.
    const routeHour = routeFareFactorAt(get().activeRouteId, get().gameTimeMinutes);
    const plan = getServicePlanEffects(get().servicePlan).fare;
    // Faz 7: bugünün şehir olayı (festival/maç bahşişi, arıza kesintisi vb.) ücreti de değiştirir.
    const eventFare = activeEventEffects(get()).fareMultiplier;
    // Gunluk seri bonusu: ardisik gun oynadikca ucret artar (tavan +%30). Seriyi
    // "sadece sayilan" bir rakam olmaktan cikarip gercek bir kayba donusturur —
    // gun kacirinca carpan 1.00'a duser.
    const streak = streakFareMultiplier(useProfileStore.getState().stats?.currentStreak ?? 1);
    return (
      baseFare *
      routeFareMultiplier() *
      routeHour *
      driverFareMultiplier() *
      tariff *
      plan *
      eventFare *
      streak
    );
  }

  function triggerPolicePenalty(state: GameState, riskReason: string) {
    const level = state.policeLevel;
    const fines = ECONOMY.police.fines as number[];
    const fine = fines[Math.min(level, fines.length - 1)];
    const newLevel = level + 1;

    let message: string;
    let suspensionMinutesLeft = state.suspensionMinutesLeft;
    if (newLevel === 3) {
      message = `Polis yakaladı: ${riskReason}. Ehliyet askıda, ₺${fine} ceza.`;
      suspensionMinutesLeft = ECONOMY.police.suspensionGameMinutes;
    } else if (newLevel >= 4) {
      message = `Polis yakaladi: ${riskReason}. Araca el konuldu.`;
    } else {
      message = `Polis yakaladı: ${riskReason}. ₺${fine} ceza.`;
    }

    return {
      money: Math.max(0, state.money - fine),
      policeLevel: newLevel,
      policeRisk: ECONOMY.police.riskAfterPenalty as number,
      speedLimitKmh: Math.min(ECONOMY.speed.legalLimitKmh, state.speedLimitKmh),
      suspensionMinutesLeft,
      satisfaction: clampSatisfaction(state.satisfaction - ECONOMY.police.satisfactionPenalty),
      policeAlert: { message, level: newLevel },
      dayRun: addToDayRun(state.dayRun, { violations: 1 }),
      lapRun: addToLapRun(state.lapRun, {
        violations: 1,
        policeFines: 1,
        policeFineAmount: fine,
        expenses: fine,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Ehliyet ceza puanı sistemi
  //
  // Polis riski (0-100) bir BAR'dır; ucundaki yıldız dolunca yanıp söner.
  // Belirli eşiklerin üstünde ihlal yaparsan ehliyetine CEZA PUANI yazılır:
  //   hız (risk ≥ 15)      →  5 puan
  //   hat dışı (risk > 75) → 50 puan
  //   sıkışık yolcu (≥ 50) → 30 puan
  //   5 yolcu kazığı       → 20 puan (riski artırmaz)
  // 100 puana ulaşınca para cezası + araç kilidi.
  // Sayılar: shared/economy.json > licence
  // -------------------------------------------------------------------------
  type LicenceOffence = "speeding" | "offRoute" | "overflow" | "shortChange";

  function issueLicencePenalty<T extends GameState>(state: T, offence: LicenceOffence) {
    const rule = ECONOMY.licence[offence];
    const points = Math.min(ECONOMY.licence.maxPoints, state.licencePoints + rule.points);
    const suspended = points >= ECONOMY.licence.maxPoints;
    const fine = rule.fine + (suspended ? ECONOMY.licence.suspensionFine : 0);
    track("licence_penalty", { offence, points: rule.points, fine, totalPoints: points, suspended });

    return {
      money: Math.max(0, state.money - fine),
      // Ceza kesilince risk sıfırlanır: aynı ihlalden peş peşe ceza yağmaz.
      policeRisk: 0,
      licencePoints: suspended ? 0 : points,
      vehicleLockSecondsLeft: suspended ? ECONOMY.licence.suspensionSeconds : state.vehicleLockSecondsLeft,
      penaltyCard: {
        id: (state.penaltyCard?.id ?? 0) + 1,
        offence,
        points: rule.points,
        fine,
        totalPoints: suspended ? ECONOMY.licence.maxPoints : points,
        suspended,
      },
      dayRun: addToDayRun(state.dayRun, { violations: 1 }),
      lapRun: addToLapRun(state.lapRun, { violations: 1, policeFines: 1, policeFineAmount: fine, expenses: fine }),
    };
  }

  /** İhlal eşiği aşıldıysa ceza keser; aşılmadıysa yalnızca riski artırır. */
  function applyOffenceRisk<T extends GameState>(state: T, offence: "offRoute" | "overflow") {
    const rule = ECONOMY.licence[offence];
    const policeRisk = Math.min(100, state.policeRisk + rule.risk);
    if (policeRisk >= rule.riskThreshold) {
      return issueLicencePenalty({ ...state, policeRisk }, offence);
    }
    return { policeRisk };
  }

  /** Kazık sayacı: her `licence.shortChange.count` kazıkta bir ceza puanı. */
  function applyShortChangeStreak<T extends GameState>(state: T) {
    const streak = state.shortChangeStreak + 1;
    if (streak < ECONOMY.licence.shortChange.count) return { shortChangeStreak: streak };
    return { ...issueLicencePenalty(state, "shortChange"), shortChangeStreak: 0 };
  }

  function applyPoliceRiskToState<T extends GameState>(state: T, rawAmount: number, reason: string) {
    // Operasyon yaklaşımı riskin birikimini yavaşlatır — tüm risk kaynakları
    // bu tek noktadan geçtiği için etki her yerde tutarlı uygulanır.
    const amount = rawAmount * strategyEffects().policeRiskMultiplier;
    if (amount <= 0 || state.policeLevel >= 4) return {};
    const threshold = ECONOMY.police.catchRiskThreshold as number;
    const policeRisk = Math.min(threshold, state.policeRisk + amount);
    if (policeRisk < threshold) return { policeRisk };
    return triggerPolicePenalty({ ...state, policeRisk }, reason);
  }

  /**
   * Hattın son durağı servis edilince tur biter ve hat raporu açılır.
   * Rapor açıkken oyuncu "Tekrar Sür" (yeni tur) veya "Gezinti Modu" (günü bitir) seçer.
   */
  function maybeCompleteLap(stopIndex: number) {
    if (stopIndex !== getStopCount() - 1) return;
    const lap = get().lapRun;
    if (!lap) return;
    set((s) => ({
      lapRun: null,
      lapReport: {
        ...lap,
        endedAtGameMinutes: s.gameTimeMinutes,
        net: lap.grossEarned - lap.expenses,
      },
    }));
  }

  function startPostBoardingEvent(stopIndex: number) {
    // Åoför moddayken risk alınmaz, mini-etkileşimler otomatik/sessiz geçer.
    if (get().driverActive) {
      set({ interaction: initialInteraction });
      return;
    }
    const roadsideWindow =
      ECONOMY.events.changeTimeoutSeconds +
      ECONOMY.dropoff.roadsideMinDelay +
      Math.random() *
        (ECONOMY.dropoff.roadsideMaxDelay - ECONOMY.dropoff.roadsideMinDelay);
    set({
      roadsidePendingDelay:
        Math.random() < ECONOMY.dropoff.roadsideRequestChance ? roadsideWindow : 0,
    });

    // Tek bir ağırlıklı havuz kullanmak aynı iki olayın sürekli tekrarlanmasını önler.
    const eventRoll = Math.random();
    if (eventRoll < 0.18) {
      set({
        interaction: { type: "offroute", stopIndex, secondsLeft: ECONOMY.offRoute.offerWindowSeconds, lineKey: pickPassengerLine("offroute") },
      });
      return;
    }
    if (eventRoll < 0.4) {
      set({
        interaction: { type: "dropoffStop", stopIndex, secondsLeft: ECONOMY.dropoff.windowSeconds, lineKey: pickPassengerLine("dropoffStop") },
      });
      return;
    }
    if (eventRoll < 0.62) {
      set({ interaction: { type: "student", stopIndex, secondsLeft: ECONOMY.events.changeTimeoutSeconds, lineKey: pickPassengerLine("student") } });
      return;
    }
    if (eventRoll < 0.9 && !get().upgrades.hasCashRegister) {
      const { billAmount, correctChange, shortChange, generousChange } = buildChangeChallenge();
      set({
        interaction: {
          type: "change",
          stopIndex,
          secondsLeft: ECONOMY.events.changeTimeoutSeconds,
          billAmount,
          correctChange,
          shortChange,
          generousChange,
          lineKey: pickPassengerLine("change"),
        },
      });
      return;
    }
    set({ interaction: initialInteraction });
  }

  function finishBoarding(
    stopIndex: number,
    boardingCount: number,
    dropoffCount = 0,
    allowStandingPassenger = false,
  ) {
    const { satDelta } = getTariffInfo(get().gameTimeMinutes);
    const planEffects = getServicePlanEffects(get().servicePlan);
    const earned = boardingCount * currentPassengerFare(ECONOMY.fare.full);
    let justCompleted: ActiveContract[] = [];

    set((s) => {
      const stopsWaiting = s.stopsWaiting.slice();
      stopsWaiting[stopIndex] = Math.max(0, (s.stopsWaiting[stopIndex] ?? 0) - boardingCount);
      const newDailyEarnings = s.dailyEarnings + earned;

      const { contracts: afterBoard, reward: boardReward, justCompleted: c1 } = advanceContractProgress(s.activeContracts, "board", boardingCount);
      const { contracts: afterEarn, reward: earnReward, justCompleted: c2 } = syncContractEarnProgress(afterBoard, newDailyEarnings);
      const totalBonus = boardReward + earnReward;
      justCompleted = [...c1, ...c2];

      // Yüksek tarife yolcuyu mutsuz eder; gece tarifesi memnuniyet katar.
      // Hizmet yaklaşımı POZİTİF memnuniyeti büyütür; ceza aynı kalır (yaklaşım
      // hata örtmez, iyi hizmeti ödüllendirir).
      const rawSatChange = (satDelta + planEffects.satisfactionPerPassenger) * boardingCount;
      const satChange = rawSatChange > 0
        ? rawSatChange * strategyEffects().satisfactionGainMultiplier
        : rawSatChange;

      const passengerLimit = s.seatCapacity + (allowStandingPassenger ? 1 : 0);
      const passengersOnBoard = Math.min(passengerLimit, s.passengersOnBoard + boardingCount);
      const nextStopDropoffs =
        passengersOnBoard <= 0
          ? 0
          : 1 + Math.floor(Math.random() * Math.min(4, passengersOnBoard));

      return {
        money: s.money + earned + totalBonus,
        dailyEarnings: newDailyEarnings,
        activeContracts: afterEarn,
        passengersOnBoard,
        nextStopDropoffs,
        stopsWaiting,
        satisfaction: clampSatisfaction(s.satisfaction + satChange),
        // Durakta bir şey olduysa kasa efektini tetikle (boş durakta efekt yok).
        stopPayout:
          boardingCount > 0 || dropoffCount > 0
            ? {
                id: (s.stopPayout?.id ?? 0) + 1,
                stopIndex,
                amount: earned + totalBonus,
                boarded: boardingCount,
                alighted: dropoffCount,
              }
            : s.stopPayout,
        dayRun: addToDayRun(s.dayRun, { stopsServed: 1, boardings: boardingCount, netEarned: earned + totalBonus, contractsCompleted: justCompleted.length }),
        lapRun: addToLapRun(s.lapRun, { stopsServed: 1, boardings: boardingCount, grossEarned: earned + totalBonus }),
      };
    });
    settleCompletedContracts(justCompleted);

    useProfileStore.getState().recordStop(
      earned,
      boardingCount,
      stopIndex === getStopCount() - 1,
    );

    if (boardingCount > 0 || dropoffCount > 0) {
      if (!get().driverActive) {
        showFeedback(
          "positive",
          "Durak tamamlandı",
          `${dropoffCount} indi · ${boardingCount} bindi · Minibüste ${get().passengersOnBoard} yolcu var.`,
        );
      }
      if (boardingCount > 0) startPostBoardingEvent(stopIndex);
      else set({ interaction: initialInteraction });
    } else {
      if (!get().driverActive) {
        showFeedback("info", "Durakta bekleme", "Yeni yolcu binmedi; sefer devam ediyor.");
      }
      set({ interaction: initialInteraction });
    }
  }

  return {
    money: 0,
    passengersOnBoard: 0,
    nextStopDropoffs: 0,
    seatCapacity: ECONOMY.bus.baseSeatCapacity,
    satisfaction: ECONOMY.satisfaction.initial,
    // Duraklar kalabaliklasmadan canli gorunsun: baslangicta 1 veya 2 yolcu.
    stopsWaiting: Array.from(
      { length: getStopCount() },
      (_, stopIndex) => (stopIndex % 2) + 1,
    ),
    decision: initialDecision,
    interaction: initialInteraction,
    upgrades: initialUpgrades,
    busUpgrades: { [BUS_CATALOG[0].id]: initialUpgrades },
    speedMultiplier: 1,
    hiredDriverId: null,
    driverActive: false,
    manualOverride: false,
    attention: 0,
    policeRisk: 0,
    ownedBuses: [],
    driverAssignments: { [MAIN_BUS_ID]: {} },
    driverShiftMinutes: {},
    driverMorale: {},
    routeMastery: {},
    rival: {},
    cityEvent: null,
    eventPrepared: false,
    freeEventPrepCredits: 0,
    ownedCosmetics: [],
    detourActive: false,
    detourSecondsLeft: 0,
    detourEarned: 0,
    detourTotal: 0,
    stopPayout: null,
    secondLine: initialSecondLine,
    hasCheckpoint: false,
    username: null,
    gameTimeMinutes: 8 * 60, // sabah 08:00'den başlar
    gameDay: 1,
    speedLimitKmh: ECONOMY.speed.limiterDefaultKmh,
    activeRouteId: DEFAULT_ROUTE_ID,
    unlockedRouteIds: [DEFAULT_ROUTE_ID],
    activeBusId: BUS_CATALOG[0].id,
    ownedBusIds: [BUS_CATALOG[0].id],
    currentSpeedKmh: 0,
    driving: { throttle: 0, steer: 0, handbrake: false, doorsOpen: false },
    servicePlan: null,
    servicePlanMinutesLeft: 0,
    terminalUpgrades: [],
    policeLevel: 0,
    suspensionMinutesLeft: 0,
    policeAlert: null,
    stopDropoffPromised: false,
    roadsidePendingDelay: 0,
    roadsidePauseLeft: 0,
    isLeader: false,
    busProgress: 0,
    dailyEarnings: 0,
    activeContracts: [],
    contractOffers: [],
    recentContractFamilyIds: [],
    npcBuses: initialNpcBuses,
    chanceGames: initialChanceGames,
    dayRun: null,
    dayReport: null,
    lapRun: null,
    lapReport: null,
    dayStartToken: 0,
    eventCardDay: null,
    eventCardOpen: false,
    moodReason: null,
    moodReasonLeft: 0,
    licencePoints: 0,
    vehicleLockSecondsLeft: 0,
    shortChangeStreak: 0,
    penaltyCard: null,
    upgradeCelebration: null,
    terminalUnveil: null,

    buyCheckpoint: () =>
      set((s) => {
        if (s.hasCheckpoint || s.money < ECONOMY.social.checkpointCost) return s;
        return { money: s.money - ECONOMY.social.checkpointCost, hasCheckpoint: true };
      }),
    setUsername: (username) => {
      setCachedUsername(username);
      set({ username });
    },
    applyExternalGain: (amount) => {
      if (amount > 0) useProfileStore.getState().recordEarnings(amount);
      set((s) => ({ money: s.money + amount }));
    },
    applyChanceGameResult: (money, chanceGames, result) => {
      const gain = Math.max(0, money - get().money);
      if (gain > 0) useProfileStore.getState().recordEarnings(gain);
      set((s) => {
        // Faz 9: para dışı ödüller — kısayol değil, sadece kolaylık (XP/level/mastery vermez).
        const patch: Partial<GameState> = {};
        if (result?.rewardType === "maintenanceCoupon") patch.freeEventPrepCredits = s.freeEventPrepCredits + 1;
        if (result?.rewardType === "cosmetic" && result.cosmeticId && !s.ownedCosmetics.includes(result.cosmeticId)) {
          patch.ownedCosmetics = [...s.ownedCosmetics, result.cosmeticId];
        }
        if (result?.rewardType === "eventPrep" && s.cityEvent && !s.eventPrepared) patch.eventPrepared = true;
        return {
          money,
          chanceGames: normalizeChanceGames(chanceGames, s.gameDay),
          ...patch,
        };
      });
      if (result?.rewardType === "contractReroll") get().refreshContractOffers();
    },

    setLeader: (isLeader) => set({ isLeader }),
    setBusProgress: (progress) => set({ busProgress: progress }),

    getBroadcastPayload: () => {
      const s = get();
      return {
        money: s.money,
        satisfaction: s.satisfaction,
        stopsWaiting: s.stopsWaiting,
        passengersOnBoard: s.passengersOnBoard,
        nextStopDropoffs: s.nextStopDropoffs,
        seatCapacity: s.seatCapacity,
        upgrades: s.upgrades,
        busUpgrades: s.busUpgrades,
        hiredDriverId: s.hiredDriverId,
        driverActive: s.driverActive,
        secondLine: s.secondLine,
        hasCheckpoint: s.hasCheckpoint,
        ownedBuses: s.ownedBuses,
        driverAssignments: s.driverAssignments,
        driverShiftMinutes: s.driverShiftMinutes,
        driverMorale: s.driverMorale,
        routeMastery: s.routeMastery,
        rival: s.rival,
        cityEvent: s.cityEvent,
        eventPrepared: s.eventPrepared,
        busProgress: s.busProgress,
        decision: s.decision,
        interaction: s.interaction,
        detourActive: s.detourActive,
        detourSecondsLeft: s.detourSecondsLeft,
        detourEarned: s.detourEarned,
        stopPayout: s.stopPayout,
        gameTimeMinutes: s.gameTimeMinutes,
        gameDay: s.gameDay,
        licencePoints: s.licencePoints,
        shortChangeStreak: s.shortChangeStreak,
        vehicleLockSecondsLeft: s.vehicleLockSecondsLeft,
        speedLimitKmh: s.speedLimitKmh,
        policeRisk: s.policeRisk,
        policeLevel: s.policeLevel,
        suspensionMinutesLeft: s.suspensionMinutesLeft,
        stopDropoffPromised: s.stopDropoffPromised,
        roadsidePauseLeft: s.roadsidePauseLeft,
        dailyEarnings: s.dailyEarnings,
        activeContracts: s.activeContracts,
        contractOffers: s.contractOffers,
        dayRun: s.dayRun,
        dayReport: s.dayReport,
        lapRun: s.lapRun,
        lapReport: s.lapReport,
        npcBuses: s.npcBuses,
        chanceGames: s.chanceGames,
        servicePlan: s.servicePlan,
        servicePlanMinutesLeft: s.servicePlanMinutesLeft,
        terminalUpgrades: s.terminalUpgrades,
        unlockedRoutes: s.unlockedRouteIds,
        activeRouteId: s.activeRouteId,
        ownedBusIds: s.ownedBusIds,
        activeBusId: s.activeBusId,
      };
    },

    // İzleyici (follower) sekme: kendi simülasyonunu çalıştırmaz, lider sekmenin yayınladığı
    // salt-veriyi (decision/interaction dahil) doğrudan uygular.
    applyBroadcastState: (payload) => set(payload),

    growStopQueues: (deltaSeconds) =>
      set((s) => {
        // PERF: kuyruklar 2 Hz buyuyor ama arayuz yalnizca Math.floor(...) gosteriyor.
        // Gecen sure `pendingQueueSeconds`te birikir; taban HER ZAMAN store'daki guncel
        // diziden okundugu icin (yolcu binisi gibi baska yazimlar bozulmaz) yeni dizi
        // kimligi yalnizca gorunen tamsayi degisince yayinlanir.
        const elapsed = deltaSeconds + pendingQueueSeconds;
        const { demandMultiplierAtZero: min, demandMultiplierAtHundred: max } = ECONOMY.satisfaction;
        const terminalDemand = getTerminalEffects(s.terminalUpgrades).demandMultiplier;
        // Faz 6: hattın talep çarpanı — gelir çarpanı (wealthMultiplier) dışında ölçülebilir fark.
        // Hattın kendi kuralı: Üniversite hattında sabah pikinde kuyruk patlar,
        // gün ortasında yarıya iner (bkz. routeProfile > routeDemandFactorAt).
        const routeDemand =
          getRouteConfig(s.activeRouteId).demandMultiplier *
          routeDemandFactorAt(s.activeRouteId, s.gameTimeMinutes) *
          // Rakibin aldigi her durak bu hattin talebini dusurur.
          rivalDemandFactor(s.rival, s.activeRouteId);
        // Faz 7: bugünün şehir olayı, sürülen hatta ise talep/memnuniyeti de değiştirir.
        const eventEffects = activeEventEffects(s);
        const demandFactor = (min + (max - min) * (s.satisfaction / 100)) * terminalDemand * routeDemand * eventEffects.demandMultiplier;
        const nextQueues = s.stopsWaiting.map((w, stopIndex) =>
          Math.min(
            ECONOMY.stopQueue.maxWaiting,
            w +
              ECONOMY.stopQueue.growthPerSecond *
                (0.78 + ((stopIndex * 11 + 3) % 6) * 0.08) *
                demandFactor *
                elapsed
          )
        );
        const nextSatisfaction = clampSatisfaction(
          s.satisfaction + eventEffects.satisfactionDriftPerSecond * elapsed
        );
        const queuesLookSame = nextQueues.every(
          (w, i) => Math.floor(w) === Math.floor(s.stopsWaiting[i])
        );
        const satisfactionLooksSame = Math.round(nextSatisfaction) === Math.round(s.satisfaction);
        if (queuesLookSame && satisfactionLooksSame) {
          pendingQueueSeconds = elapsed;
          return s;
        }
        pendingQueueSeconds = 0;
        return { stopsWaiting: nextQueues, satisfaction: nextSatisfaction };
      }),

    applySoundSystem: (deltaSeconds) =>
      set((s) => {
        if (s.upgrades.soundLevel === 0) return s;
        const gain =
          ECONOMY.upgrades.soundSatisfactionPerSecondPerLevel * s.upgrades.soundLevel * deltaSeconds;
        return { satisfaction: clampSatisfaction(s.satisfaction + gain) };
      }),

    openDecision: () =>
      set((s) =>
        s.decision.open
          ? s
          : { decision: { open: true, secondsLeft: ECONOMY.decision.windowSeconds, choice: null } }
      ),

    tickDecision: (deltaSeconds) =>
      set((s) => {
        if (!s.decision.open) return s;
        const secondsLeft = s.decision.secondsLeft - deltaSeconds;
        if (secondsLeft <= 0) {
          return { decision: { open: false, secondsLeft: 0, choice: "DUR" } };
        }
        return { decision: { ...s.decision, secondsLeft } };
      }),

    chooseDecision: (choice) => {
      let justCompleted: ActiveContract[] = [];
      set((s) => {
        if (!s.decision.open) return s;
        const { contracts: afterDur, reward: durReward, justCompleted: done } =
          choice === "DUR" ? advanceContractProgress(s.activeContracts, "dur", 1) : { contracts: s.activeContracts, reward: 0, justCompleted: [] };
        justCompleted = done;
        return {
          decision: { open: false, secondsLeft: 0, choice },
          activeContracts: afterDur,
          money: s.money + durReward,
          dayRun: addToDayRun(s.dayRun, { contractsCompleted: done.length }),
        };
      });
      settleCompletedContracts(justCompleted);
    },

    // Åoför moddayken karar penceresi hiç açılmaz; şoför risk almaz, hep DUR seçer.
    autoChooseDur: () => set({ decision: { open: false, secondsLeft: 0, choice: "DUR" } }),

    tickInteraction: (deltaSeconds) => {
      const s = get();
      const timedTypes = ["overflow", "student", "change", "offroute", "dropoffStop", "dropoffRoadside"] as const;
      if (!timedTypes.includes(s.interaction.type as typeof timedTypes[number])) return;
      const secondsLeft = s.interaction.secondsLeft - deltaSeconds;
      if (secondsLeft <= 0) {
        if (s.interaction.type === "overflow") get().resolveOverflow(false);
        else if (s.interaction.type === "student") get().resolveStudent(false);
        else if (s.interaction.type === "change") get().resolveChange("timeout");
        else if (s.interaction.type === "offroute") get().resolveOffRoute(false);
        else if (s.interaction.type === "dropoffStop") get().resolveDropoffStop(false);
        else if (s.interaction.type === "dropoffRoadside") get().resolveDropoffRoadside(false);
        return;
      }
      set({ interaction: { ...s.interaction, secondsLeft } });
    },

    resolveOverflow: (accept) => {
      const { stopIndex, normalBoardingCount, dropoffCount } = get().interaction;
      const freeSeats = normalBoardingCount ?? get().seatCapacity;
      const boarding = accept ? freeSeats + 1 : freeSeats;
      if (accept) {
        // Sıkışık yolcu: riski artırır, eşiği aşarsa ehliyete ceza puanı yazar.
        set((s) => ({
          satisfaction: clampSatisfaction(s.satisfaction - ECONOMY.satisfaction.overflowPenalty),
          lapRun: addToLapRun(s.lapRun, { overflowAccepted: 1 }),
          ...applyOffenceRisk(s, "overflow"),
        }));
      }
      finishBoarding(stopIndex, boarding, dropoffCount ?? 0, accept);
      showFeedback(
        accept ? "warning" : "positive",
        accept ? "Ayakta yolcu alındı" : "Kapasite korundu",
        accept
          ? "Fazladan gelir var; polis riski ve memnuniyetsizlik arttı."
          : "Minibüs güvenli kapasitede devam ediyor.",
      );
    },

    resolveStudent: (accept) => {
      set((s) => {
        if (s.interaction.type !== "student") return s;
        const { studentAcceptBonus, studentRejectPenalty } = ECONOMY.satisfaction;
        const refund = accept
          ? currentPassengerFare(ECONOMY.fare.full - ECONOMY.fare.student)
          : 0;
        return {
          money: Math.max(0, s.money - refund),
          dailyEarnings: Math.max(0, s.dailyEarnings - refund),
          satisfaction: clampSatisfaction(
            s.satisfaction + (accept ? studentAcceptBonus : -studentRejectPenalty)
          ),
          interaction: initialInteraction,
          ...(!accept ? applyPoliceRiskToState(s, ECONOMY.police.globalRisk.rejectStudent as number, "ogrenci indirimini reddetmek") : {}),
        };
      });
      showFeedback(
        accept ? "positive" : "warning",
        accept ? "Öğrenci indirimi" : "Tam ücret alındı",
        accept
          ? "Yolcu memnun kaldı; ücret farkı kasadan düşüldü."
          : "Kısa vadede gelir korundu, memnuniyet azaldı.",
      );
    },

    resolveStudentFree: () => {
      set((s) => {
        if (s.interaction.type !== "student") return s;
        const refund = currentPassengerFare(ECONOMY.fare.full);
        return {
          money: Math.max(0, s.money - refund),
          dailyEarnings: Math.max(0, s.dailyEarnings - refund),
          satisfaction: clampSatisfaction(
            s.satisfaction + ECONOMY.satisfaction.studentAcceptBonus * 1.5,
          ),
          interaction: initialInteraction,
        };
      });
      showFeedback(
        "positive",
        "Ücretsiz yolculuk",
        "Bu yolcudan ücret alınmadı; memnuniyet belirgin şekilde arttı.",
      );
    },

    resolveChange: (mode) => {
      const interaction = get().interaction;
      const gained = interaction.correctChange !== undefined && interaction.shortChange !== undefined
        ? interaction.correctChange - interaction.shortChange
        : 0;
      const lost = interaction.generousChange !== undefined && interaction.correctChange !== undefined
        ? interaction.generousChange - interaction.correctChange
        : 0;
      let justCompleted: ActiveContract[] = [];
      set((s) => {
        if (s.interaction.type !== "change") return s;
        const { changeCorrectBonus } = ECONOMY.satisfaction;
        const {
          shortChangeSatisfactionPenalty,
          generousSatisfactionBonus,
          timeoutSatisfactionPenalty,
        } = ECONOMY.events.changeChoice;

        // Kazıkta cebe kalan tutar gelirdir; ikramda cepten çıkan tutar zarardır.
        // Dürüst seçimin ödülü bahşiş + memnuniyet.
        const delta =
          mode === "short" ? gained
          : mode === "generous" ? -lost
          : mode === "exact" ? ECONOMY.fare.tipMin + Math.random() * (ECONOMY.fare.tipMax - ECONOMY.fare.tipMin)
          : 0;
        const satisfactionDelta =
          mode === "short" ? -shortChangeSatisfactionPenalty
          : mode === "generous" ? generousSatisfactionBonus
          : mode === "exact" ? changeCorrectBonus
          : -timeoutSatisfactionPenalty;

        const newDailyEarnings = s.dailyEarnings + Math.max(0, delta);
        const { contracts, reward, justCompleted: done } = syncContractEarnProgress(s.activeContracts, newDailyEarnings);
        justCompleted = done;
        return {
          money: s.money + delta + reward,
          dailyEarnings: newDailyEarnings,
          activeContracts: contracts,
          satisfaction: clampSatisfaction(s.satisfaction + satisfactionDelta),
          interaction: initialInteraction,
          dayRun: addToDayRun(s.dayRun, {
            contractsCompleted: done.length,
            // Kazık bir ihlaldir: gün notunun güvenlik/hizmet boyutuna yazılır.
            violations: mode === "short" ? 1 : 0,
          }),
          lapRun: addToLapRun(s.lapRun, {
            violations: mode === "short" ? 1 : 0,
            grossEarned: Math.max(0, delta),
            expenses: Math.max(0, -delta),
          }),
          // Kazık polis riskini ARTIRMAZ (görünmeyen suç); ama her 5 kazıkta bir
          // şikâyet birikip ehliyete 20 ceza puanı yazılır.
          ...(mode === "short" ? applyShortChangeStreak(s) : {}),
        };
      });
      settleCompletedContracts(justCompleted);
      showFeedback(
        mode === "short" ? "negative" : mode === "timeout" ? "info" : "positive",
        mode === "short" ? "Üstü eksik verildi"
          : mode === "generous" ? "Yolcuya ikram"
          : mode === "timeout" ? "Karar veremedin"
          : "Para üstü tam",
        mode === "short" ? `₺${Math.round(gained)} cebe kaldı · Yolcu fark etti, memnuniyet ve güvenlik düştü.`
          : mode === "generous" ? `₺${Math.round(lost)} cebinden çıktı · Yolcu bunu unutmayacak, memnuniyet arttı.`
          : mode === "timeout" ? "Yolcu üstünü kendi aldı; memnuniyet biraz düştü."
          : "Yolcu bahşiş bıraktı ve memnuniyet arttı.",
      );
    },

    resolveArrivalAtStop: (stopIndex) => {
      const state = get();

      // Gezinti modu: gün başlatılmadan durakta iş yapılmaz. Oyuncu şehri
      // serbestçe gezer; yolcu, para ve karar akışı yalnızca vardiyada işler.
      if (!state.dayRun) {
        set({ decision: initialDecision, interaction: initialInteraction });
        return null;
      }

      const choice: DecisionChoice = state.decision.choice ?? "DUR";
      set({ decision: initialDecision });

      // Durakta iniş sözü verilmişken GEÇ seçilirse büyük ceza.
      if (get().stopDropoffPromised) {
        if (choice === "GEC") {
          set((s) => ({
            satisfaction: clampSatisfaction(s.satisfaction - ECONOMY.dropoff.promiseBreakPenalty),
            stopDropoffPromised: false,
            dayRun: addToDayRun(s.dayRun, { violations: 1 }),
            ...applyPoliceRiskToState(s, ECONOMY.police.globalRisk.breakStopPromise as number, "durakta indirme sozunu bozmak"),
          }));
        } else {
          set({ stopDropoffPromised: false });
        }
      }

      if (choice === "GEC") {
        const waiting = Math.floor(get().stopsWaiting[stopIndex] ?? 0);
        if (waiting > 0) {
          set((s) => ({
            interaction: initialInteraction,
            satisfaction: clampSatisfaction(
              s.satisfaction - Math.min(8, 1.5 + waiting * 1.25),
            ),
            dayRun: addToDayRun(s.dayRun, { stopsMissed: 1 }),
            lapRun: addToLapRun(s.lapRun, { stopsMissed: 1 }),
          }));
          showFeedback(
            "negative",
            "Durak geçildi",
            `${waiting} yolcu durakta kaldı · Memnuniyet düştü.`,
          );
        } else {
          set({ interaction: initialInteraction });
          showFeedback("info", "Durak boştu", "Bekleyen yolcu olmadığı için zaman kazandın.");
        }
        maybeCompleteLap(stopIndex);
        return choice;
      }

      const { contracts: afterStop, reward: stopReward, justCompleted: stopDone } = advanceContractProgress(
        get().activeContracts,
        "dur",
        1,
      );
      set((current) => ({
        activeContracts: afterStop,
        money: current.money + stopReward,
        dayRun: addToDayRun(current.dayRun, { contractsCompleted: stopDone.length }),
      }));
      settleCompletedContracts(stopDone);

      // Yalnızca bu durakta ineceği planlanan yolcular iner; kalanlar araçta kalır.
      const dropoffCount = Math.min(get().passengersOnBoard, get().nextStopDropoffs);
      set((s) => {
        return {
          passengersOnBoard: s.passengersOnBoard - dropoffCount,
          nextStopDropoffs: 0,
        };
      });

      const waiting = Math.floor(get().stopsWaiting[stopIndex] ?? 0);
      const freeSeats = Math.max(0, get().seatCapacity - get().passengersOnBoard);

      if (
        waiting > freeSeats &&
        !get().driverActive &&
        get().passengersOnBoard <= get().seatCapacity
      ) {
        set({
          interaction: {
            type: "overflow",
            stopIndex,
            secondsLeft: ECONOMY.events.changeTimeoutSeconds,
            normalBoardingCount: freeSeats,
            dropoffCount,
            lineKey: pickPassengerLine("overflow"),
          },
        });
      } else {
        finishBoarding(stopIndex, Math.min(waiting, freeSeats), dropoffCount);
      }

      maybeCompleteLap(stopIndex);
      return choice;
    },

    buyMotorUpgrade: () =>
      set((s) => {
        const { motorCosts } = ECONOMY.upgrades;
        const cost = motorCosts[s.upgrades.motorLevel];
        if (cost === undefined || s.money < cost) return s;
        const motorLevel = s.upgrades.motorLevel + 1;
        const speedMultiplier = speedMultiplierForBus(s.activeBusId, { ...s.upgrades, motorLevel });
        track("upgrade_purchased", { itemId: "motor", level: motorLevel, busId: s.activeBusId, amount: cost });
        return {
          money: s.money - cost,
          upgrades: { ...s.upgrades, motorLevel },
          busUpgrades: { ...s.busUpgrades, [s.activeBusId]: { ...s.upgrades, motorLevel } },
          speedMultiplier,
          upgradeCelebration: buildCelebration(s, "motor", motorLevel, motorCosts.length, {
            speedMultiplier,
          }),
        };
      }),

    buySeatUpgrade: () =>
      set((s) => {
        const { seatCosts } = ECONOMY.upgrades;
        const cost = seatCosts[s.upgrades.seatLevel];
        if (cost === undefined || s.money < cost) return s;
        const seatLevel = s.upgrades.seatLevel + 1;
        const seatCapacity = seatCapacityForBus(s.activeBusId, { ...s.upgrades, seatLevel });
        track("upgrade_purchased", { itemId: "seat", level: seatLevel, busId: s.activeBusId, amount: cost });
        return {
          money: s.money - cost,
          upgrades: { ...s.upgrades, seatLevel },
          busUpgrades: { ...s.busUpgrades, [s.activeBusId]: { ...s.upgrades, seatLevel } },
          seatCapacity,
          upgradeCelebration: buildCelebration(s, "seat", seatLevel, seatCosts.length, { seatCapacity }),
        };
      }),

    buySoundUpgrade: () =>
      set((s) => {
        const { soundCosts } = ECONOMY.upgrades;
        const cost = soundCosts[s.upgrades.soundLevel];
        if (cost === undefined || s.money < cost) return s;
        const soundLevel = s.upgrades.soundLevel + 1;
        track("upgrade_purchased", { itemId: "sound", level: soundLevel, busId: s.activeBusId, amount: cost });
        return {
          money: s.money - cost,
          upgrades: { ...s.upgrades, soundLevel },
          busUpgrades: {
            ...s.busUpgrades,
            [s.activeBusId]: { ...s.upgrades, soundLevel },
          },
          upgradeCelebration: buildCelebration(s, "sound", soundLevel, soundCosts.length, {}),
        };
      }),

    buyCashRegister: () =>
      set((s) => {
        if (s.upgrades.hasCashRegister || s.money < ECONOMY.upgrades.cashRegisterCost) return s;
        track("upgrade_purchased", { itemId: "cashRegister", level: 1, busId: s.activeBusId, amount: ECONOMY.upgrades.cashRegisterCost });
        return {
          money: s.money - ECONOMY.upgrades.cashRegisterCost,
          upgrades: { ...s.upgrades, hasCashRegister: true },
          busUpgrades: { ...s.busUpgrades, [s.activeBusId]: { ...s.upgrades, hasCashRegister: true } },
          upgradeCelebration: buildCelebration(s, "cashRegister", 1, 1, {}),
        };
      }),

    hireDriver: (driverId) =>
      set((s) => {
        if (s.hiredDriverId) return s;
        // Sürücü başka bir dolmuşa atanmışsa işe alınamaz.
        if (s.ownedBuses.some((b) => b.driverAssignedId === driverId)) return s;
        const driver = findDriver(driverId);
        if (!driver || s.money < driver.hireCost) return s;
        // İşe alım, şoförü O ANKİ vardiyaya yazar; sürüşü devralması yine
        // vardiya saatine bağlıdır (resolveShiftDriver).
        const normalized = normalizeDriverAssignments(s.ownedBuses, s.driverAssignments, null);
        const shiftId = getActiveShiftId(s.gameTimeMinutes);
        const driverAssignments = {
          ...normalized,
          [MAIN_BUS_ID]: { ...(normalized[MAIN_BUS_ID] ?? {}), [shiftId]: driver.id },
        };
        track("driver_hired", { driverId: driver.id, amount: driver.hireCost, shiftId });
        return {
          money: s.money - driver.hireCost,
          driverAssignments,
          ...resolveShiftDriver({ ...s, driverAssignments }),
          decision: initialDecision,
          interaction: initialInteraction,
          driverMorale: driver.id in s.driverMorale ? s.driverMorale : { ...s.driverMorale, [driver.id]: ECONOMY.driverMorale.initial },
        };
      }),

    fireDriver: () =>
      set((s) => {
        if (!s.hiredDriverId) return s;
        return { hiredDriverId: null, driverActive: false };
      }),

    // "Kendim sürerim" / "Şoföre bırak" — oyuncu tercihi. Vardiyada şoför yoksa
    // zaten oyuncu sürer; tercih o vardiya geldiğinde devreye girer.
    toggleDriverActive: () =>
      set((s) => {
        const manualOverride = !s.manualOverride;
        const resolved = resolveShiftDriver({ ...s, manualOverride });
        return {
          manualOverride,
          ...resolved,
          ...(resolved.driverActive
            ? { decision: initialDecision, interaction: initialInteraction }
            : {}),
        };
      }),

    getActiveDriver: () => findDriver(get().hiredDriverId),

    buyBus: () =>
      set((s) => {
        const costs = ECONOMY.extraBuses.purchaseCosts as number[];
        const costIndex = s.ownedBuses.length;
        if (costIndex >= costs.length) return s;
        const cost = costs[costIndex];
        if (s.money < cost) return s;
        const names = ECONOMY.extraBuses.names as string[];
        const newBus: OwnedBus = {
          id: `bus-${costIndex + 1}`,
          name: names[costIndex] ?? `Dolmuş #${costIndex + 2}`,
          driverAssignedId: null,
          color: BUS_COLORS[(costIndex + 1) % BUS_COLORS.length],
        };
        track("fleet_bus_purchased", { itemId: newBus.id, amount: cost });
        return { money: s.money - cost, ownedBuses: [...s.ownedBuses, newBus] };
      }),

    assignDriverToBus: (busId, driverId) => get().assignDriverShift(busId, "morning", driverId),

    unassignDriverFromBus: (busId) => get().unassignDriverShift(busId, "morning"),

    assignDriverShift: (busId, shiftId, driverId) =>
      set((s) => {
        const driver = findDriver(driverId);
        if (!driver) return s;
        const normalized = normalizeDriverAssignments(s.ownedBuses, s.driverAssignments, s.hiredDriverId);
        const alreadyAssigned = Object.entries(normalized).some(([assignedBusId, shifts]) =>
          Object.entries(shifts).some(([assignedShiftId, assignedDriverId]) =>
            assignedBusId !== busId || assignedShiftId !== shiftId
              ? assignedDriverId === driverId
              : false
          )
        );
        if (alreadyAssigned) return s;
        const driverAssignments = {
          ...normalized,
          [busId]: { ...(normalized[busId] ?? {}), [shiftId]: driverId },
        };
        // Şoför yalnızca ATANDIĞI vardiyanın saatinde devralır — atama anında değil.
        const resolved = resolveShiftDriver({ ...s, driverAssignments });
        return {
          driverAssignments,
          ...resolved,
          ...(resolved.driverActive && !s.driverActive
            ? { decision: initialDecision, interaction: initialInteraction }
            : {}),
        };
      }),

    unassignDriverShift: (busId, shiftId) =>
      set((s) => {
        const normalized = normalizeDriverAssignments(s.ownedBuses, s.driverAssignments, s.hiredDriverId);
        const driverAssignments = {
          ...normalized,
          [busId]: { ...(normalized[busId] ?? {}), [shiftId]: null },
        };
        return { driverAssignments, ...resolveShiftDriver({ ...s, driverAssignments }) };
      }),

    tickOwnedBuses: (deltaSeconds) => {
      let justCompleted: ActiveContract[] = [];
      set((s) => {
        const assignments = normalizeDriverAssignments(s.ownedBuses, s.driverAssignments, s.hiredDriverId);
        const activeShiftId = getActiveShiftId(s.gameTimeMinutes);
        let earned = 0;
        // Büyüme yaklaşımı filo (vardiyalı şoförlü dolmuşlar) gelirini artırır.
        const fleetMultiplier = strategyEffects().fleetIncomeMultiplier;
        const gameMinutesAdded = ECONOMY.time.gameMinutesPerRealSecond * deltaSeconds;
        const shiftUpdates: Record<string, number> = { ...s.driverShiftMinutes };

        const busIds = [MAIN_BUS_ID, ...s.ownedBuses.map((bus) => bus.id)];
        for (const busId of busIds) {
          const driverId = assignments[busId]?.[activeShiftId] ?? null;
          if (!driverId) continue;
          const driver = findDriver(driverId);
          if (!driver) continue;
          earned += netShiftIncomePerSecond(busId, activeShiftId, driver) * deltaSeconds * fleetMultiplier;
          shiftUpdates[driverId] = (shiftUpdates[driverId] ?? 0) + gameMinutesAdded;
        }

        if (earned === 0 && JSON.stringify(shiftUpdates) === JSON.stringify(s.driverShiftMinutes)) return s;

        const newDailyEarnings = s.dailyEarnings + earned;
        const { contracts, reward, justCompleted: done } = syncContractEarnProgress(s.activeContracts, newDailyEarnings);
        justCompleted = done;
        return {
          money: s.money + earned + reward,
          dailyEarnings: newDailyEarnings,
          activeContracts: contracts,
          driverAssignments: assignments,
          driverShiftMinutes: shiftUpdates,
          dayRun: addToDayRun(s.dayRun, { contractsCompleted: done.length }),
        };
      });
      settleCompletedContracts(justCompleted);
    },

    resolveOffRoute: (accept) => {
      let justCompleted: ActiveContract[] = [];
      set((s) => {
        if (s.interaction.type !== "offroute") return s;
        if (!accept) return { interaction: initialInteraction };
        const { contracts: afterOffroute, reward, justCompleted: done } = advanceContractProgress(s.activeContracts, "offroute", 1);
        justCompleted = done;
        // Toplam ücret kabul anında sabitlenir; 5 saniye boyunca kademeli olarak ödenir.
        // Böylece oyuncu parayı birikirken görür (sonda tek seferde düşmez).
        const { fareMultiplierMin, fareMultiplierMax } = ECONOMY.offRoute;
        const detourTotal =
          ECONOMY.fare.full *
          routeFareMultiplier() *
          (fareMultiplierMin + Math.random() * (fareMultiplierMax - fareMultiplierMin));
        return {
          interaction: initialInteraction,
          detourActive: true,
          detourSecondsLeft: ECONOMY.offRoute.detourSeconds,
          detourEarned: 0,
          detourTotal,
          activeContracts: afterOffroute,
          money: s.money + reward,
          dayRun: addToDayRun(s.dayRun, { contractsCompleted: done.length }),
          lapRun: addToLapRun(s.lapRun, { offRouteTrips: 1 }),
          // Hat dışı: riski artırır, %75 eşiğini aşarsa 50 ceza puanı.
          ...applyOffenceRisk(s, "offRoute"),
        };
      });
      settleCompletedContracts(justCompleted);
      showFeedback(
        accept ? "warning" : "info",
        accept ? "Hat dışı yolculuk" : "Teklif reddedildi",
        accept
          ? "Yüksek ücret karşılığında rota dışına çıktın; polis riski yükseldi."
          : "Ana hatta ve güvenli gelir akışında kaldın.",
      );
    },

    tickDetour: (deltaSeconds) => {
      let justCompleted: ActiveContract[] = [];
      set((s) => {
        if (!s.detourActive) {
          if (s.attention === 0) return s;
          return {
            attention: clampSatisfaction(
              s.attention - (100 / ECONOMY.offRoute.attentionDecaySeconds) * deltaSeconds
            ),
          };
        }

        const attention = clampSatisfaction(
          s.attention + ECONOMY.offRoute.attentionGainPerSecond * deltaSeconds
        );
        const secondsLeft = s.detourSecondsLeft - deltaSeconds;

        // Para süre boyunca eşit hızda birikir; her tick kadarı anında kasaya yazılır.
        const ratio = Math.min(1, deltaSeconds / ECONOMY.offRoute.detourSeconds);
        const tick = s.detourTotal * ratio;

        if (secondsLeft > 0) {
          const detourEarned = Math.min(s.detourTotal, s.detourEarned + tick);
          return {
            attention,
            detourSecondsLeft: secondsLeft,
            detourEarned,
            money: s.money + (detourEarned - s.detourEarned),
            dailyEarnings: s.dailyEarnings + (detourEarned - s.detourEarned),
            lapRun: addToLapRun(s.lapRun, { grossEarned: detourEarned - s.detourEarned }),
          };
        }

        // Son tick: yuvarlama kayıplarını kapatıp toplamı tam olarak öde.
        const netGain = Math.max(0, s.detourTotal - s.detourEarned);

        const newDailyEarnings = s.dailyEarnings + Math.max(0, netGain);
        const { contracts, reward: earnReward, justCompleted: done } = syncContractEarnProgress(s.activeContracts, newDailyEarnings);
        justCompleted = done;

        return {
          money: s.money + netGain + earnReward,
          dailyEarnings: newDailyEarnings,
          activeContracts: contracts,
          attention,
          detourActive: false,
          detourSecondsLeft: 0,
          detourEarned: s.detourTotal,
          dayRun: addToDayRun(s.dayRun, { contractsCompleted: done.length }),
          ...applyPoliceRiskToState(s, attention * 0.08, "hat disi sefer tamamlamak"),
        };
      });
      settleCompletedContracts(justCompleted);
    },

    resolveDropoffStop: (accept) => {
      set((s) => {
        if (s.interaction.type !== "dropoffStop") return s;
        if (!accept) {
          return {
            satisfaction: clampSatisfaction(s.satisfaction - ECONOMY.dropoff.rejectPenalty),
            interaction: initialInteraction,
            ...applyPoliceRiskToState(s, ECONOMY.police.globalRisk.rejectStopDropoff as number, "durakta inmek isteyen yolcuyu reddetmek"),
          };
        }
        return {
          satisfaction: clampSatisfaction(s.satisfaction + ECONOMY.dropoff.stopAcceptBonus),
          stopDropoffPromised: true,
          interaction: initialInteraction,
        };
      });
      showFeedback(
        accept ? "positive" : "negative",
        accept ? "İniş talebi alındı" : "İniş talebi reddedildi",
        accept
          ? "Yolcu bir sonraki durakta indirilecek."
          : "Yolcu memnuniyeti düştü ve şikâyet riski oluştu.",
      );
    },

    resolveDropoffRoadside: (accept) => {
      let justCompleted: ActiveContract[] = [];
      set((s) => {
        if (s.interaction.type !== "dropoffRoadside") return s;
        if (!accept) {
          return {
            satisfaction: clampSatisfaction(s.satisfaction - ECONOMY.dropoff.rejectPenalty),
            interaction: initialInteraction,
            ...applyPoliceRiskToState(s, ECONOMY.police.globalRisk.rejectRoadsideDropoff as number, "musait yerde inmek isteyen yolcuyu reddetmek"),
          };
        }
        const tip = ECONOMY.dropoff.roadsideTipAmount;
        const newDailyEarnings = s.dailyEarnings + tip;
        const { contracts, reward, justCompleted: done } = syncContractEarnProgress(s.activeContracts, newDailyEarnings);
        justCompleted = done;
        return {
          money: s.money + tip + reward,
          dailyEarnings: newDailyEarnings,
          activeContracts: contracts,
          dayRun: addToDayRun(s.dayRun, { contractsCompleted: done.length }),
          passengersOnBoard: Math.max(0, s.passengersOnBoard - 1),
          nextStopDropoffs: Math.min(
            s.nextStopDropoffs,
            Math.max(0, s.passengersOnBoard - 1),
          ),
          satisfaction: clampSatisfaction(s.satisfaction + ECONOMY.dropoff.roadsideAcceptBonus),
          interaction: initialInteraction,
          roadsidePauseLeft: ECONOMY.dropoff.roadsidePauseSeconds,
          roadsidePendingDelay: 0,
          ...applyPoliceRiskToState(s, ECONOMY.police.globalRisk.roadsideStop as number, "durak disi indirme yapmak"),
        };
      });
      settleCompletedContracts(justCompleted);
      showFeedback(
        accept ? "warning" : "negative",
        accept ? "Müsait yerde indirildi" : "Yolcu araçta kaldı",
        accept
          ? `₺${ECONOMY.dropoff.roadsideTipAmount} bahşiş aldın; küçük bir polis riski oluştu.`
          : "Talep reddedildi; memnuniyet azaldı.",
      );
    },

    deferRoadsideDropoff: () => {
      set((s) => {
        if (s.interaction.type !== "dropoffRoadside") return s;
        return {
          interaction: initialInteraction,
          roadsidePendingDelay: 0,
          stopDropoffPromised: true,
          satisfaction: clampSatisfaction(
            s.satisfaction + ECONOMY.dropoff.stopAcceptBonus,
          ),
        };
      });
      showFeedback(
        "positive",
        "Güvenli iniş planlandı",
        "Yolcu bir sonraki resmi durakta indirilecek.",
      );
    },

    tickRoadsideDelay: (deltaSeconds) =>
      set((s) => {
        if (s.roadsidePendingDelay <= 0) return s;
        const remaining = s.roadsidePendingDelay - deltaSeconds;
        if (remaining > 0) return { roadsidePendingDelay: remaining };
        if (s.passengersOnBoard <= 0 || s.interaction.type !== null) {
          return { roadsidePendingDelay: 0 };
        }
        return {
          roadsidePendingDelay: 0,
          interaction: {
            type: "dropoffRoadside" as const,
            stopIndex: -1,
            secondsLeft: ECONOMY.dropoff.windowSeconds,
            lineKey: pickPassengerLine("dropoffRoadside"),
          },
        };
      }),

    tickRoadsidePause: (deltaSeconds) =>
      set((s) => ({
        roadsidePauseLeft: Math.max(0, s.roadsidePauseLeft - deltaSeconds),
      })),

    tickGameTime: (deltaSeconds) => {
      let failedContracts: ActiveContract[] = [];
      let dayRolledOver = false;
      set((s) => {
        // PERF: saat 4 Hz tiklaniyor ama ekranda YALNIZCA "SS:DD" gorunuyor. Gorunen
        // dakika degismedikce store'a yazmayiz; kesirli artis `pendingGameMinutes`te
        // birikir, boylece hassasiyet kaybolmaz ama abone suprumu yariya iner.
        const added = ECONOMY.time.gameMinutesPerRealSecond * deltaSeconds + pendingGameMinutes;
        const total = s.gameTimeMinutes + added;
        const servicePlanMinutesLeft = Math.max(0, s.servicePlanMinutesLeft - added);
        const servicePlan = servicePlanMinutesLeft > 0 ? s.servicePlan : null;
        const daysAdded = Math.floor(total / 1440);
        if (daysAdded > 0) {
          dayRolledOver = true;
          pendingGameMinutes = 0;
          // Yeni gün: günlük sayaçları sıfırla, kontratları kapat ve yeni teklifler üret.
          const incomplete = s.activeContracts.filter((c) => !c.completed);
          failedContracts = incomplete;
          const level = useProgressionStore.getState().bootstrap?.progression.level ?? 1;
          const recentContractFamilyIds = [
            ...incomplete.map((c) => c.familyId),
            ...s.recentContractFamilyIds,
          ].slice(0, ECONOMY.contracts.recentPoolSize);
          return {
            gameTimeMinutes: total % 1440,
            gameDay: s.gameDay + daysAdded,
            dailyEarnings: 0,
            activeContracts: [],
            contractOffers: generateContractOffers(level, recentContractFamilyIds),
            recentContractFamilyIds,
            driverShiftMinutes: {},
            chanceGames: normalizeChanceGames(s.chanceGames, s.gameDay + daysAdded),
            servicePlan,
            servicePlanMinutesLeft,
            // Dünün şehir olayı yeni güne sızmasın: fetchCityEvent() tamamlanana kadar
            // (ağ hatasında hiç tamamlanmayabilir) activeEventEffects nötr kalsın.
            cityEvent: null,
            eventPrepared: false,
          };
        }
        const minuteUnchanged =
          Math.floor(total) === Math.floor(s.gameTimeMinutes) &&
          servicePlanMinutesLeft === s.servicePlanMinutesLeft &&
          servicePlan === s.servicePlan;
        if (minuteUnchanged) {
          pendingGameMinutes = added;
          return s;
        }
        pendingGameMinutes = 0;
        // Saat ilerledikçe vardiya değişir; direksiyonu o vardiyanın şoförü devralır
        // (veya kimse atanmamışsa oyuncuya döner).
        const gameTimeMinutes = total % 1440;
        // Günün olayı: her gün 12:00'de bir kez büyük kartla duyurulur.
        const announce =
          gameTimeMinutes >= EVENT_ANNOUNCE_MINUTE && s.eventCardDay !== s.gameDay && s.cityEvent !== null;
        return {
          gameTimeMinutes,
          servicePlan,
          servicePlanMinutesLeft,
          ...(announce ? { eventCardOpen: true, eventCardDay: s.gameDay } : {}),
          ...resolveShiftDriver({ ...s, gameTimeMinutes }),
        };
      });
      settleFailedContracts(failedContracts);
      if (dayRolledOver || get().cityEvent === null) get().fetchCityEvent();
    },

    isNight: () => isNightTime(get().gameTimeMinutes),

    startDay: (config) =>
      set((s) => {
        // Seçilen hat aktifleşir; manuel seçilirse şoför devre dışı (oyuncu sürer).
        const routeId = s.unlockedRouteIds.includes(config.routeId) ? config.routeId : s.activeRouteId;
        if (routeId !== s.activeRouteId) setActiveRouteGeometry(routeId);
        const manualOverride = config.manual;
        track("day_started", { routeId, manual: config.manual, goalId: config.goalId, servicePlan: s.servicePlan });
        return {
          activeRouteId: routeId,
          manualOverride,
          ...resolveShiftDriver({ ...s, manualOverride }),
          // Gün, hattın BAŞINDAN başlar. Gezintide hattın ortasına gelmiş olmak
          // vardiyayı 5. duraktan başlatmamalı (bkz. GameCanvas > dayStartToken).
          dayStartToken: s.dayStartToken + 1,
          dayReport: null,
          lapReport: null,
          lapRun: createLapRun(routeId, s.gameTimeMinutes, 1),
          dayRun: {
            ...config,
            routeId,
            startedAtGameMinutes: s.gameTimeMinutes,
            startedAtGameDay: s.gameDay,
            boardings: 0,
            stopsServed: 0,
            stopsMissed: 0,
            violations: 0,
            netEarned: 0,
            contractsCompleted: 0,
            contractsFailed: 0,
          },
        };
      }),

    endDay: () => {
      const s = get();
      if (!s.dayRun) return;
      const run = s.dayRun;
      const contractsResolved = run.contractsCompleted + run.contractsFailed;
      const result = computeDayGrade({
        violations: run.violations,
        satisfaction: s.satisfaction,
        boardings: run.boardings,
        stopsServed: run.stopsServed,
        stopsMissed: run.stopsMissed,
        netEarned: run.netEarned,
        contractCompletionPct: contractsResolved > 0 ? (run.contractsCompleted / contractsResolved) * 100 : 0,
      });
      // Faz 5: gün, otomatik şoförle geçtiyse notu şoförün moraline yansıt (önceden bildirilir,
      // gizli ceza değil — atama ekranı bu değeri gösterir).
      const moraleCfg = ECONOMY.driverMorale;
      const drivingDriverId = !run.manual ? s.hiredDriverId : null;
      let driverMorale = s.driverMorale;
      if (drivingDriverId) {
        const current = driverMorale[drivingDriverId] ?? moraleCfg.initial;
        const delta = (moraleCfg.goodDayGrades as string[]).includes(result.grade)
          ? moraleCfg.gainOnGoodDay
          : (moraleCfg.badDayGrades as string[]).includes(result.grade)
            ? -moraleCfg.lossOnBadDay
            : 0;
        if (delta !== 0) driverMorale = { ...driverMorale, [drivingDriverId]: Math.max(0, Math.min(100, current + delta)) };
      }
      // Faz 6: gün notu, sürülen hattın mastery XP'sine katkı yapar (sunucuda kalıcı — persist).
      const routeMastery = advanceRouteMastery(s.routeMastery, run.routeId, result.score);

      // Günün hedefi: gün başında seçilen bahis. Tutturulursa net kazancın bir oranı
      // prim olarak ödenir; tutmazsa ceza yok (hedef risk değil, yön verir).
      const goals = ECONOMY.dayGoals;
      const goalTarget =
        run.goalId === "earnings" ? goals.earnings.targetNet
        : run.goalId === "satisfaction" ? goals.satisfaction.targetSatisfaction
        : goals.safety.maxViolations;
      const goalActual =
        run.goalId === "earnings" ? run.netEarned
        : run.goalId === "satisfaction" ? s.satisfaction
        : run.violations;
      const goalMet =
        run.goalId === "safety" ? goalActual <= goalTarget : goalActual >= goalTarget;
      const bonusRatio =
        run.goalId === "earnings" ? goals.earnings.moneyBonusRatio
        : run.goalId === "satisfaction" ? goals.satisfaction.moneyBonusRatio
        : goals.safety.moneyBonusRatio;
      const goalBonus = goalMet ? Math.max(0, run.netEarned) * bonusRatio : 0;

      // Günün işletme gideri: yakıt/bakım, maaşlar, haftalık kira, muayene.
      // Bugüne kadar hiçbiri tahsil edilmiyordu — filo büyütmenin bedeli yoktu.
      const hiredDriverIds = [
        ...new Set(
          Object.values(s.driverAssignments)
            .flatMap((shifts) => Object.values(shifts))
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const upkeep = computeDayUpkeep(s.ownedBuses.length, hiredDriverIds, run.startedAtGameDay);

      // Rakip firma: ihmal edilen hatta duraklar el degistirir, iyi gun geri kazandirir.
      const rivalOutcome = applyRivalDay(s.rival, s.unlockedRouteIds, run.routeId, s.satisfaction);

      set({
        money: Math.max(0, s.money + goalBonus - upkeep.total),
        dayRun: null,
        lapRun: null,
        lapReport: null,
        driverMorale,
        routeMastery,
        rival: rivalOutcome.rival,
        dayReport: {
          grade: result.grade,
          score: result.score,
          xp: result.xp,
          breakdown: result.breakdown,
          netEarned: Math.round(run.netEarned),
          upkeep,
          rivalLostStop: rivalOutcome.lostStopOnDrivenRoute,
          rivalRecoveredStop: rivalOutcome.recoveredStopOnDrivenRoute,
          gameDay: run.startedAtGameDay,
          goalId: run.goalId,
          goalMet,
          goalTarget,
          goalActual,
          goalBonus,
          routeId: run.routeId,
          idempotencyKey: `day:${run.startedAtGameDay}:${run.startedAtGameMinutes}:${Date.now()}`,
        },
      });
      track("day_completed", {
        routeId: run.routeId,
        grade: result.grade,
        score: result.score,
        netEarned: Math.round(run.netEarned),
        goalId: run.goalId,
        goalMet,
        violations: run.violations,
        boardings: run.boardings,
      });
    },

    dismissDayReport: () => set({ dayReport: null }),

    dismissUpgradeCelebration: () => set({ upgradeCelebration: null }),

    dismissTerminalUnveil: () => set({ terminalUnveil: null }),

    dismissPenaltyCard: () => set({ penaltyCard: null }),

    dismissEventCard: () => set({ eventCardOpen: false }),

    /**
     * Yolcu konforu: hızlı sürüş araçtaki yolcuyu rahatsız eder ve memnuniyeti eritir.
     * Memnuniyetin NEDENİ (`moodReason`) dolmuşun üstündeki emoji balonunda gösterilir —
     * sayaç düşerken oyuncu sebebini görür.
     */
    tickPassengerMood: (deltaSeconds) =>
      set((s) => {
        const speeding = !s.driverActive && s.currentSpeedKmh > ECONOMY.speed.legalLimitKmh;
        const annoyed = speeding && s.passengersOnBoard > 0;

        if (!annoyed) {
          // Sebep bir süre daha görünür kalır, sonra kendiliğinden söner.
          if (s.moodReasonLeft <= 0) return s.moodReason === null ? s : { moodReason: null };
          const left = s.moodReasonLeft - deltaSeconds;
          return left <= 0 ? { moodReasonLeft: 0, moodReason: null } : { moodReasonLeft: left };
        }

        return {
          satisfaction: clampSatisfaction(
            s.satisfaction -
              ECONOMY.satisfaction.speedingPenaltyPerSecond *
                routeSpeedingPenaltyMultiplier(s.activeRouteId) *
                deltaSeconds,
          ),
          moodReason: "speeding" as const,
          moodReasonLeft: MOOD_REASON_VISIBLE_SECONDS,
        };
      }),

    startNextLap: () =>
      set((s) => {
        if (!s.dayRun) return { lapReport: null };
        return {
          lapReport: null,
          lapRun: createLapRun(s.dayRun.routeId, s.gameTimeMinutes, (s.lapReport?.lapIndex ?? 0) + 1),
        };
      }),

    // Gezinti moduna dönmek günü bitirir; oyuncu önce hat raporunu, sonra
    // notlu gün raporunu görür ve serbest sürüşe döner.
    returnToRoam: () => {
      set({ lapReport: null });
      get().endDay();
    },

    // Faz 7 — canlı şehir event yönetmeni: olay tamamen sunucudan gelir (bkz. api.ts).
    fetchCityEvent: async () => {
      const playerId = getPlayerId();
      if (!playerId) return;
      try {
        const event = await fetchTodayEvent(playerId, get().gameDay);
        set({ cityEvent: event, eventPrepared: false });
        track("event_viewed", { primary: event.primary.id, secondary: event.secondary?.id ?? null, affectedRouteId: event.affectedRouteId });
      } catch {
        // Ağ hatasında olay bilinmeden gün devam eder — hazırlık göstermeden risk uygulanmaz.
      }
    },

    prepareForEvent: () =>
      set((s) => {
        if (!s.cityEvent || s.eventPrepared) return s;
        // Faz 9: kupondan gelen bakım kuponu, sonraki hazırlığın ücretini karşılar.
        if (s.freeEventPrepCredits > 0) {
          track("event_prepared", { primary: s.cityEvent.primary.id, cost: 0, freeCoupon: true });
          return { eventPrepared: true, freeEventPrepCredits: s.freeEventPrepCredits - 1 };
        }
        const cost = s.cityEvent.primary.counterCost + (s.cityEvent.secondary?.counterCost ?? 0);
        if (s.money < cost) return s;
        track("event_prepared", { primary: s.cityEvent.primary.id, cost });
        return { money: s.money - cost, eventPrepared: true };
      }),

    // Faz 4 — kontrat motoru: teklif üretimi + kabul/vazgeçme.
    refreshContractOffers: () => {
      const s = get();
      const level = useProgressionStore.getState().bootstrap?.progression.level ?? 1;
      const offers = generateContractOffers(level, s.recentContractFamilyIds);
      track("contract_viewed", { offerIds: offers.map((o) => o.id), familyIds: offers.map((o) => o.familyId) });
      set({ contractOffers: offers });
    },

    acceptContract: (offerId) =>
      set((s) => {
        if (s.activeContracts.length >= ECONOMY.contracts.maxActive) return s;
        const offer = s.contractOffers.find((o) => o.id === offerId);
        if (!offer) return s;
        track("contract_accepted", { contractId: offer.id, familyId: offer.familyId });
        const accepted: ActiveContract = { ...offer, progress: 0, completed: false, acceptedAtGameDay: s.gameDay };
        return {
          activeContracts: [...s.activeContracts, accepted],
          contractOffers: s.contractOffers.filter((o) => o.id !== offerId),
        };
      }),

    abandonContract: (contractId) => {
      const contract = get().activeContracts.find((c) => c.id === contractId);
      if (!contract) return;
      set((s) => ({ activeContracts: s.activeContracts.filter((c) => c.id !== contractId) }));
      track("contract_abandoned", { contractId: contract.id, familyId: contract.familyId });
      const playerId = getPlayerId();
      if (playerId) {
        resolveContract(playerId, {
          idempotencyKey: `contract:${contract.id}`,
          contractId: contract.id,
          familyId: contract.familyId,
          bonusIds: contract.bonusIds,
          outcome: "abandoned",
          gameDay: contract.acceptedAtGameDay,
        }).catch(() => {});
      }
    },

    // Gosterge hizi her karede GameCanvas'tan gelir. Ayni degerde set etmek
    // gereksiz render tetiklemesin diye 1 km/h esigi altinda yok sayilir.
    setCurrentSpeedKmh: (kmh) =>
      set((s) => {
        if (Math.abs(s.currentSpeedKmh - kmh) < 1) return s;
        // Hastane hattı sert freni affetmez: ani yavaşlama arkadakileri savurur.
        // Duraklarda durmak ceza değildir — kural yalnızca seyir hâlinde işler.
        const penalty = harshBrakePenalty(s.activeRouteId, s.currentSpeedKmh, kmh);
        if (penalty === 0) return { currentSpeedKmh: kmh };
        return {
          currentSpeedKmh: kmh,
          satisfaction: clampSatisfaction(s.satisfaction - penalty),
          moodReason: "harshBrake" as const,
          moodReasonLeft: MOOD_REASON_VISIBLE_SECONDS,
        };
      }),

    setDrivingInput: (input) =>
      set((s) => {
        const next = { ...s.driving, ...input };
        if (
          next.throttle === s.driving.throttle &&
          next.steer === s.driving.steer &&
          next.handbrake === s.driving.handbrake &&
          next.doorsOpen === s.driving.doorsOpen
        ) {
          return s;
        }
        return { driving: next };
      }),

    toggleDoors: () => {
      const state = get();
      if (state.driverActive) return;
      if (
        !state.driving.doorsOpen &&
        Math.abs(state.currentSpeedKmh) > MAX_MANUAL_DOOR_OPEN_SPEED_KMH
      ) {
        showFeedback(
          "warning",
          "Kapı kilidi",
          "Kapılar yalnızca araç durduğunda açılabilir.",
        );
        return;
      }
      set((s) => ({
        driving: { ...s.driving, doorsOpen: !s.driving.doorsOpen },
      }));
    },

    unlockRoute: (routeId) =>
      set((s) => {
        if (s.unlockedRouteIds.includes(routeId)) return s;
        const definition = getRouteDefinition(routeId);
        if (definition.id !== routeId) return s;
        if (s.money < definition.unlockCost) {
          showFeedback("warning", "Yetersiz bakiye", `${definition.name} icin ₺${definition.unlockCost.toLocaleString("tr-TR")} lazim.`);
          return s;
        }
        showFeedback("positive", "Yeni hat acildi", definition.name);
        track("route_unlocked", { itemId: routeId, amount: definition.unlockCost });
        return {
          money: s.money - definition.unlockCost,
          unlockedRouteIds: [...s.unlockedRouteIds, routeId],
        };
      }),

    setActiveRoute: (routeId) =>
      set((s) => {
        if (!s.unlockedRouteIds.includes(routeId) || s.activeRouteId === routeId) return s;
        // Geometri isaretcisini de cevir: GameCanvas her karede buradan okur.
        setActiveRouteGeometry(routeId);
        useUiStore.getState().selectRouteOverlay(routeId);
        const definition = getRouteDefinition(routeId);
        showFeedback("info", "Hat degisti", definition.name);
        // Durak kuyruklari yeni hattin durak sayisina gore sifirlanir.
        return {
          activeRouteId: routeId,
          stopsWaiting: Array.from(
            { length: getStopCount() },
            (_, stopIndex) => (stopIndex % 2) + 1,
          ),
          busProgress: 0,
          currentSpeedKmh: 0,
          decision: initialDecision,
          interaction: initialInteraction,
          driving: {
            ...s.driving,
            throttle: 0,
            steer: 0,
            handbrake: false,
            doorsOpen: false,
          },
        };
      }),

    buyCatalogBus: (busId) =>
      set((s) => {
        if (s.ownedBusIds.includes(busId)) return s;
        const entry = getBusCatalogEntry(busId);
        if (!entry) return s;
        if (s.money < entry.price) {
          showFeedback("warning", "Yetersiz bakiye", `${entry.name} icin ₺${entry.price.toLocaleString("tr-TR")} lazim.`);
          return s;
        }
        showFeedback("positive", "Yeni dolmus", `${entry.name} garaja girdi.`);
        track("catalog_bus_purchased", { itemId: busId, amount: entry.price });
        return {
          money: s.money - entry.price,
          ownedBusIds: [...s.ownedBusIds, busId],
          busUpgrades: { ...s.busUpgrades, [busId]: { ...initialUpgrades } },
        };
      }),

    setActiveBus: (busId) =>
      set((s) => {
        if (!s.ownedBusIds.includes(busId) || s.activeBusId === busId) return s;
        const entry = getBusCatalogEntry(busId);
        if (!entry) return s;
        showFeedback("info", "Dolmus degisti", entry.name);
        const upgrades = upgradesForBus(s.busUpgrades, busId);
        return {
          activeBusId: busId,
          upgrades,
          seatCapacity: seatCapacityForBus(busId, upgrades),
          speedMultiplier: speedMultiplierForBus(busId, upgrades),
        };
      }),

    increaseSpeed: () =>
      set((s) => {
        if (s.driverActive || s.policeLevel >= 4 || s.suspensionMinutesLeft > 0) return s;
        return { speedLimitKmh: Math.min(ECONOMY.speed.limiterMaxKmh, s.speedLimitKmh + ECONOMY.speed.limiterStepKmh) };
      }),

    decreaseSpeed: () =>
      set((s) => {
        if (s.driverActive) return s;
        return { speedLimitKmh: Math.max(ECONOMY.speed.limiterMinKmh, s.speedLimitKmh - ECONOMY.speed.limiterStepKmh) };
      }),

    chooseServicePlan: (plan) =>
      set((s) => {
        if (s.servicePlanMinutesLeft > 0) return s;
        return {
          servicePlan: plan,
          servicePlanMinutesLeft: SERVICE_PLAN_DURATION_MINUTES,
        };
      }),

    buyTerminalUpgrade: (id) =>
      set((s) => {
        const upgrade = getTerminalUpgrade(id);
        if (!upgrade || s.terminalUpgrades.includes(id) || s.money < upgrade.cost) return s;
        track("terminal_upgrade_purchased", { itemId: id, amount: upgrade.cost });
        return {
          money: s.money - upgrade.cost,
          terminalUpgrades: [...s.terminalUpgrades, id],
          // Sinematik açılış: kamera yeni binanın etrafında döner (bkz. TerminalUnveilCam).
          terminalUnveil: id,
        };
      }),

    tickTerminal: (deltaSeconds) =>
      set((s) => {
        if (s.terminalUpgrades.length === 0) return s;
        const effects = getTerminalEffects(s.terminalUpgrades);
        const earned = effects.incomePerSecond * deltaSeconds;
        return {
          money: s.money + earned,
          dailyEarnings: s.dailyEarnings + earned,
          satisfaction: clampSatisfaction(
            s.satisfaction + effects.satisfactionPerSecond * deltaSeconds,
          ),
        };
      }),

    tickSpeedRisk: (deltaSeconds) =>
      set((s) => {
        if (s.policeLevel >= 4) return s;

        // Ehliyet cezası: araç kilitliyken hiçbir risk işlemez, sayaç akar.
        if (s.vehicleLockSecondsLeft > 0) {
          return {
            vehicleLockSecondsLeft: Math.max(0, s.vehicleLockSecondsLeft - deltaSeconds),
            policeRisk: Math.max(0, s.policeRisk - ECONOMY.licence.riskDecayPerSecond * deltaSeconds),
          };
        }

        if (s.suspensionMinutesLeft > 0) {
          const remaining = s.suspensionMinutesLeft - ECONOMY.time.gameMinutesPerRealSecond * deltaSeconds;
          const riskDecay = Math.max(0, s.policeRisk - (ECONOMY.police.riskDecayPerSecond as number) * deltaSeconds);
          return { suspensionMinutesLeft: Math.max(0, remaining), policeRisk: riskDecay };
        }

        const globalRisk = ECONOMY.police.globalRisk;
        const positiveSources: Array<{ amount: number; reason: string }> = [];

        const speeding = !s.driverActive && s.currentSpeedKmh > ECONOMY.speed.legalLimitKmh;
        if (speeding) {
          // Hız ihlali riski saniyede %1 birikir; risk eşiği (%15) aşılmışken hâlâ
          // hızlıysan polis seni durdurur ve ehliyetine 5 puan yazar.
          if (s.policeRisk >= ECONOMY.licence.speeding.riskThreshold) {
            return issueLicencePenalty(s, "speeding");
          }
          const nightMultiplier = isNightTime(s.gameTimeMinutes) ? ECONOMY.police.nightCatchMultiplier : 1;
          positiveSources.push({
            amount: ECONOMY.licence.speeding.riskPerSecond * nightMultiplier * deltaSeconds,
            reason: "hiz limiti asimi",
          });
        }

        if (s.detourActive) {
          positiveSources.push({
            amount: (globalRisk.detourPerSecond as number) * deltaSeconds,
            reason: "hat disi sefer",
          });
        }

        const assignments = normalizeDriverAssignments(s.ownedBuses, s.driverAssignments, s.hiredDriverId);
        if (getActiveShiftId(s.gameTimeMinutes) === "night") {
          const nightShiftCount = [MAIN_BUS_ID, ...s.ownedBuses.map((bus) => bus.id)].reduce((count, busId) => {
            return assignments[busId]?.night ? count + 1 : count;
          }, 0);
          if (nightShiftCount > 0) {
            positiveSources.push({
              amount: (globalRisk.illegalNightShiftPerSecond as number) * nightShiftCount * deltaSeconds,
              reason: "gizli gece vardiyasi",
            });
          }
        }

        const { driverFatigue } = ECONOMY;
        let fatigueDelta = 0;
        const allDriverIds = new Set<string>();
        if (s.hiredDriverId) allDriverIds.add(s.hiredDriverId);
        Object.values(assignments).forEach((shifts) => {
          Object.values(shifts).forEach((driverId) => {
            if (driverId) allDriverIds.add(driverId);
          });
        });
        for (const dId of allDriverIds) {
          const worked = s.driverShiftMinutes[dId] ?? 0;
          if (worked > driverFatigue.maxShiftGameMinutes) {
            const extraHours = (worked - driverFatigue.maxShiftGameMinutes) / 60;
            fatigueDelta += extraHours * (driverFatigue.policeRiskPerExtraGameHour as number) * deltaSeconds;
          }
        }
        if (fatigueDelta > 0) {
          positiveSources.push({ amount: fatigueDelta, reason: "yorgun sofor calistirmak" });
        }

        if (positiveSources.length === 0) {
          // PERF: risk zaten 0 ise yeni nesne dondurme — zustand her `set` cagrisinda
          // TUM abonelere (~70 selector) haber verir; degismeyen deger icin bedava yuk.
          if (s.policeRisk === 0) return s;
          return {
            policeRisk: Math.max(0, s.policeRisk - (ECONOMY.police.riskDecayPerSecond as number) * deltaSeconds),
          };
        }

        // Faz 6: hattın denetim riski çarpanı — gelir çarpanı dışında ölçülebilir ikinci fark.
        const routeRisk = getRouteConfig(s.activeRouteId).riskMultiplier;
        // Faz 7: bugünün şehir olayı (hazırlıksızsan tam, hazırlıklıysan yarı) riski de değiştirir.
        const eventRisk = activeEventEffects(s).riskMultiplier;
        // İki çarpan üst üste binince ceza sarmalı oluşturmasın diye birleşik çarpan sınırlanır.
        const combinedRiskMultiplier = Math.min(ECONOMY.police.maxCombinedRiskMultiplier, routeRisk * eventRisk);
        const totalDelta = positiveSources.reduce((sum, source) => sum + source.amount, 0) * combinedRiskMultiplier;
        const strongestSource = positiveSources.reduce((strongest, source) =>
          source.amount > strongest.amount ? source : strongest
        );
        return applyPoliceRiskToState(s, totalDelta, strongestSource.reason);
      }),
    isSuspended: () => get().suspensionMinutesLeft > 0,

    buyNewVehicle: () =>
      set((s) => {
        if (s.policeLevel < 4 || s.money < ECONOMY.police.newVehicleCost) return s;
        return {
          money: s.money - ECONOMY.police.newVehicleCost,
          policeLevel: 2,
          speedLimitKmh: ECONOMY.speed.limiterDefaultKmh,
          policeRisk: 0,
          suspensionMinutesLeft: 0,
          policeAlert: null,
        };
      }),

    dismissPoliceAlert: () => set({ policeAlert: null }),

    unlockSecondLine: () =>
      set((s) => {
        if (s.secondLine.unlocked || s.money < ECONOMY.secondLine.openCost) return s;
        return {
          money: s.money - ECONOMY.secondLine.openCost,
          secondLine: { ...s.secondLine, unlocked: true },
        };
      }),

    hireSecondLineDriver: () =>
      set((s) => {
        if (!s.secondLine.unlocked || s.secondLine.hasDriver || s.money < ECONOMY.secondLine.driverHireCost)
          return s;
        return {
          money: s.money - ECONOMY.secondLine.driverHireCost,
          secondLine: { ...s.secondLine, hasDriver: true },
        };
      }),

    tickSecondLine: (deltaSeconds) => {
      let justCompleted: ActiveContract[] = [];
      set((s) => {
        if (!s.secondLine.unlocked || !s.secondLine.hasDriver) return s;
        const earned = ECONOMY.secondLine.idleIncomePerSecond * deltaSeconds;
        const newDailyEarnings = s.dailyEarnings + earned;
        const { contracts, reward, justCompleted: done } = syncContractEarnProgress(s.activeContracts, newDailyEarnings);
        justCompleted = done;
        return {
          money: s.money + earned + reward,
          dailyEarnings: newDailyEarnings,
          activeContracts: contracts,
          dayRun: addToDayRun(s.dayRun, { contractsCompleted: done.length }),
        };
      });
      settleCompletedContracts(justCompleted);
    },

    // NPC rakip dolmuşlar: yolcuları tüketir, oyuncuyla rekabet eder.
    tickNpcBuses: (deltaSeconds) =>
      set((s) => {
        if (s.npcBuses.length === 0) return s;
        const speedBase = ECONOMY.bus.baseSpeedMetersPerSec;
        const stopsWaiting = s.stopsWaiting.slice();
        const newBuses = s.npcBuses.map((bus) => {
          const progressPerSecond = (speedBase * bus.speedFactor) / getRouteLength();
          const prev = bus.progress;
          const next = (prev + progressPerSecond * deltaSeconds) % 1;

          // Durağa yaklaşma tespiti: önceki frame'den bu frame'e geçişte durağı geçtiyse
          for (let i = 0; i < getStopCount(); i++) {
            const sp = stopProgress(i);
            const crossed = prev <= sp
              ? next > sp && next - prev < 0.1        // normal ilerleme
              : prev > 0.95 && next < 0.05 && sp < 0.05; // rota sonu sarmal
            if (crossed && stopsWaiting[i] > 0) {
              const take = Math.ceil(stopsWaiting[i] * (ECONOMY.npc.passengerTakeRatio as number));
              stopsWaiting[i] = Math.max(0, stopsWaiting[i] - take);
            }
          }
          return { ...bus, progress: next };
        });
        return { npcBuses: newBuses, stopsWaiting };
      }),

    getSnapshot: () => {
      const s = get();
      return {
        saveVersion: SAVE_VERSION,
        money: s.money,
        satisfaction: Math.round(clampSatisfaction(s.satisfaction)),
        stopsWaiting: s.stopsWaiting,
        passengersOnBoard: s.passengersOnBoard,
        nextStopDropoffs: s.nextStopDropoffs,
        seatCapacity: s.seatCapacity,
        upgrades: s.upgrades,
        busUpgrades: s.busUpgrades,
        hiredDriverId: s.hiredDriverId,
        secondLine: s.secondLine,
        hasCheckpoint: s.hasCheckpoint,
        ownedBuses: s.ownedBuses,
        driverAssignments: normalizeDriverAssignments(s.ownedBuses, s.driverAssignments, s.hiredDriverId),
        driverShiftMinutes: s.driverShiftMinutes,
        driverMorale: s.driverMorale,
        routeMastery: s.routeMastery,
        rival: s.rival,
        tutorialStatus: useTutorialStore.getState().packageStatus,
        chanceGames: normalizeChanceGames(s.chanceGames, s.gameDay),
        servicePlan: s.servicePlan,
        servicePlanMinutesLeft: s.servicePlanMinutesLeft,
        terminalUpgrades: s.terminalUpgrades,
        unlockedRoutes: s.unlockedRouteIds,
        activeRouteId: s.activeRouteId,
        ownedBusIds: s.ownedBusIds,
        activeBusId: s.activeBusId,
        gameTimeMinutes: s.gameTimeMinutes,
        gameDay: s.gameDay,
        licencePoints: s.licencePoints,
        policeRisk: s.policeRisk,
        shortChangeStreak: s.shortChangeStreak,
        vehicleLockSecondsLeft: s.vehicleLockSecondsLeft,
      };
    },

    loadSnapshot: (snapshot) => {
      if (snapshot.username !== undefined) setCachedUsername(snapshot.username);
      // Faz 8: paket tamamlanma/atlama durumu sunucudan gelir — tekrar giriş yapınca korunur.
      if (snapshot.tutorialStatus) useTutorialStore.getState().hydrateFromServer(snapshot.tutorialStatus);
      set((s) => {
        const ownedBuses = snapshot.ownedBuses ?? [];
        const loadedRouteId = resolveLoadedRouteId(snapshot);
        const driverAssignments = normalizeDriverAssignments(
          ownedBuses,
          snapshot.driverAssignments,
          snapshot.hiredDriverId
        );
        const ownedBusIds = snapshot.ownedBusIds?.length ? snapshot.ownedBusIds : [BUS_CATALOG[0].id];
        const activeBusId = snapshot.activeBusId && ownedBusIds.includes(snapshot.activeBusId)
          ? snapshot.activeBusId
          : BUS_CATALOG[0].id;
        const busUpgrades = snapshot.busUpgrades ?? { [activeBusId]: snapshot.upgrades };
        const activeUpgrades = upgradesForBus(busUpgrades, activeBusId);
        return {
        money: snapshot.money,
        satisfaction: clampSatisfaction(snapshot.satisfaction),
        stopsWaiting:
          snapshot.stopsWaiting.length === getStopCount()
            ? snapshot.stopsWaiting.map((waiting) =>
                Math.max(0, Math.min(ECONOMY.stopQueue.maxWaiting, waiting)),
              )
            : Array(getStopCount()).fill(0),
        passengersOnBoard: Math.max(
          0,
          Math.min(snapshot.seatCapacity + 1, snapshot.passengersOnBoard ?? 0),
        ),
        nextStopDropoffs: Math.max(
          0,
          Math.min(
            snapshot.passengersOnBoard ?? 0,
            snapshot.nextStopDropoffs ?? 0,
          ),
        ),
        seatCapacity: seatCapacityForBus(activeBusId, activeUpgrades),
        upgrades: activeUpgrades,
        busUpgrades,
        speedMultiplier: speedMultiplierForBus(activeBusId, activeUpgrades),
        hiredDriverId: snapshot.hiredDriverId,
        driverActive: snapshot.hiredDriverId !== null,
        secondLine: snapshot.secondLine ?? initialSecondLine,
        hasCheckpoint: snapshot.hasCheckpoint,
        ownedBuses,
        driverAssignments,
        driverShiftMinutes: snapshot.driverShiftMinutes ?? {},
        driverMorale: snapshot.driverMorale ?? {},
        routeMastery: snapshot.routeMastery ?? {},
        chanceGames: normalizeChanceGames(snapshot.chanceGames, snapshot.gameDay ?? s.gameDay),
        servicePlan: snapshot.servicePlan ?? null,
        servicePlanMinutesLeft: Math.max(0, snapshot.servicePlanMinutesLeft ?? 0),
        terminalUpgrades: snapshot.terminalUpgrades ?? [],
        unlockedRouteIds: snapshot.unlockedRoutes?.length
          ? snapshot.unlockedRoutes
          : [DEFAULT_ROUTE_ID],
        activeRouteId: loadedRouteId,
        ownedBusIds,
        activeBusId,
        gameTimeMinutes: Math.max(0, Math.min(1439.999, snapshot.gameTimeMinutes ?? s.gameTimeMinutes)),
        gameDay: Math.max(1, snapshot.gameDay ?? s.gameDay),
        licencePoints: Math.max(0, Math.min(ECONOMY.licence.maxPoints - 1, snapshot.licencePoints ?? 0)),
        policeRisk: Math.max(0, Math.min(100, snapshot.policeRisk ?? 0)),
        shortChangeStreak: Math.max(0, Math.min(ECONOMY.licence.shortChange.count - 1, snapshot.shortChangeStreak ?? 0)),
        vehicleLockSecondsLeft: Math.max(0, Math.min(ECONOMY.licence.suspensionSeconds, snapshot.vehicleLockSecondsLeft ?? 0)),
        username: snapshot.username !== undefined ? snapshot.username : s.username,
        };
      });
    },
  };
});
