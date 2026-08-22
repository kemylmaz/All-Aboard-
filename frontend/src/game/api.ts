import { ChanceGameResult, ChanceGamesState, GameSnapshot } from "./store";

import { getAuthToken } from "./playerId";

import { DemoOfflineError, IS_DEMO } from "./demo";

// Backend'in adresi — .env.local'de NEXT_PUBLIC_API_BASE_URL ile ezilebilir.
const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
if (!configuredApiBaseUrl && !IS_DEMO && process.env.NODE_ENV === "production") {
  throw new Error("Production build requires NEXT_PUBLIC_API_BASE_URL.");
}
const API_BASE_URL = (configuredApiBaseUrl || "http://localhost:5000").replace(/\/+$/, "");

/**
 * Demo modunda hicbir istek aga cikmaz; cagrilar aninda reddedilir. Kayit ve
 * ilerleme yollari bu hatayi zaten yakalayip yerel duruma dusuyor, agi
 * beklemek yalnizca oyunu yavaslatirdi.
 */
const apiFetch: typeof fetch = IS_DEMO
  ? (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.reject(new DemoOfflineError(url.replace(API_BASE_URL, "") || url));
    }
  : (...args) => fetch(...args);

export interface SaveResponse extends GameSnapshot {
  savedAtUtc: string;
  clamped: boolean;
  offlineIncome: number;
}

export async function fetchSave(
  playerId: string,
  includeOfflineIncome = true,
): Promise<SaveResponse | null> {
  const query = includeOfflineIncome ? "" : "?includeOfflineIncome=false";
  const res = await apiFetch(`${API_BASE_URL}/api/saves/${playerId}${query}`, {
    headers: authHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Kayıt getirilemedi: ${res.status}`);
  return res.json();
}

export async function pushSave(playerId: string, snapshot: GameSnapshot): Promise<SaveResponse> {
  const res = await apiFetch(`${API_BASE_URL}/api/saves/${playerId}`, {
    method: "PUT",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(snapshot),
    keepalive: true, // sekme kapanırken de isteği tamamlamayı dener
  });
  if (!res.ok) throw new Error(`Kayıt gönderilemedi: ${res.status}`);
  return res.json();
}

/**
 * Oyunu sıfırlar: hesap kalır, ilerlemenin tamamı (kayıt, şirket, level/XP, başarımlar,
 * kontrat/vardiya kayıtları) sunucuda silinir. Geri alınamaz.
 */
export async function resetGame(playerId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE_URL}/api/saves/${playerId}/reset`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Oyun sıfırlanamadı: ${res.status}`);
}

export interface SpinWheelResponse {
  money: number;
  chanceGames: ChanceGamesState;
  result: ChanceGameResult;
}

export async function spinWheel(playerId: string, gameDay: number): Promise<SpinWheelResponse> {
  const res = await apiFetch(`${API_BASE_URL}/api/chance/wheel/spin/${playerId}`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ gameDay, clientRequestId: createClientRequestId() }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ?? `Çark çevrilemedi: ${res.status}`);
  return data;
}

function createClientRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function authHeaders(): Record<string, string> {
  const authToken = getAuthToken();
  return authToken ? { "X-FullFilled-Auth": authToken } : {};
}

function jsonAuthHeaders(): HeadersInit {
  return { "Content-Type": "application/json", ...authHeaders() };
}

// ---- Login: kullanıcı adı + şifre, yoksa otomatik kayıt (bkz. LoginGate.tsx) ----

export interface LoginResult {
  playerId: string;
  username: string;
  isNewAccount: boolean;
  authToken: string;
}

export async function login(
  username: string,
  password: string
): Promise<{ ok: true; result: LoginResult } | { ok: false; messageKey: string }> {
  const res = await apiFetch(`${API_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  // Backend metin degil ANAHTAR doner; cumleyi LoginGate `t()` ile kurar.
  if (!res.ok) return { ok: false, messageKey: data.messageKey ?? "auth.error.generic" };
  return { ok: true, result: data };
}

export interface CompanyProfile {
  id: string;
  name: string;
  emblemId: string;
  primaryColor: string;
  secondaryColor: string;
  strategy: "service" | "operations" | "growth";
  starterBusId: string;
  reputation: number;
  skills: Record<string, number>;
}

export interface ProgressionSnapshot {
  level: number;
  experience: number;
  currentLevelExperience: number;
  nextLevelExperience: number;
  skillPoints: number;
  lastAcknowledgedLevel: number;
  maxLevel: number;
}

export interface UnlockStatus {
  id: string;
  available: boolean;
  requiredLevel: number;
  missingMilestones: string[];
}

export interface PlayerBootstrap {
  company: CompanyProfile | null;
  progression: ProgressionSnapshot;
  unlocks: Record<string, UnlockStatus>;
  achievements: string[];
}

export interface CreateCompanyInput {
  name: string;
  emblemId: string;
  primaryColor: string;
  secondaryColor: string;
  strategy: CompanyProfile["strategy"];
  starterBusId: string;
}

async function progressionRequest(playerId: string, path = "", init?: RequestInit): Promise<PlayerBootstrap> {
  const response = await apiFetch(`${API_BASE_URL}/api/progression/${playerId}${path}`, {
    ...init,
    headers: init?.body ? jsonAuthHeaders() : authHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `Progression request failed: ${response.status}`);
  return data;
}

export function fetchProgression(playerId: string) {
  return progressionRequest(playerId);
}

export async function createCompany(playerId: string, input: CreateCompanyInput): Promise<PlayerBootstrap> {
  const response = await apiFetch(`${API_BASE_URL}/api/companies/${playerId}`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `Company could not be created: ${response.status}`);
  return data;
}

export function upgradeCompanySkill(playerId: string, skillId: string) {
  return progressionRequest(playerId, `/skills/${skillId}`, { method: "POST", body: "{}" });
}

export function resetCompanySkills(playerId: string) {
  return progressionRequest(playerId, "/skills/reset", { method: "POST", body: "{}" });
}

export function acknowledgeLevel(playerId: string) {
  return progressionRequest(playerId, "/acknowledge-level", { method: "POST", body: "{}" });
}

// ---- Faz 3: gün sonu vardiya sonucu (idempotent, sunucu XP'yi grade'den doğrular) ----

export interface SubmitShiftInput {
  idempotencyKey: string;
  gameDay: number;
  grade: string;
  score: number;
  moneyEarned: number;
  goalId: string;
  metricsJson?: string;
}

export interface SubmitShiftResponse {
  bootstrap: PlayerBootstrap;
  experienceAwarded: number;
  duplicate: boolean;
}

export async function submitShiftResult(playerId: string, input: SubmitShiftInput): Promise<SubmitShiftResponse> {
  const res = await apiFetch(`${API_BASE_URL}/api/shifts/${playerId}`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `Vardiya kaydedilemedi: ${res.status}`);
  return data;
}

// ---- Faz 4: kontrat sonucu (idempotent, sunucu XP/itibarı şablondan doğrular) ----

export interface ResolveContractInput {
  idempotencyKey: string;
  contractId: string;
  familyId: string;
  bonusIds: string[];
  outcome: "completed" | "failed" | "abandoned";
  gameDay: number;
  metricsJson?: string;
}

export interface ResolveContractResponse {
  bootstrap: PlayerBootstrap;
  experienceAwarded: number;
  reputationAwarded: number;
  duplicate: boolean;
}

export async function resolveContract(playerId: string, input: ResolveContractInput): Promise<ResolveContractResponse> {
  const res = await apiFetch(`${API_BASE_URL}/api/contracts/${playerId}/resolve`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `Kontrat sonucu gönderilemedi: ${res.status}`);
  return data;
}

// ---- Faz 7: günlük şehir olayı (sunucu üretir, deterministik) ----

export interface CityEventTemplate {
  id: string;
  severity: "low" | "medium" | "high";
  demandDelta: number;
  riskDelta: number;
  fareDelta: number;
  satisfactionDrift: number;
  counterCost: number;
}

export interface DailyEvent {
  primary: CityEventTemplate;
  affectedRouteId: string;
  secondary: CityEventTemplate | null;
  counterEffectRatio: number;
}

export async function fetchTodayEvent(playerId: string, gameDay: number): Promise<DailyEvent> {
  const res = await apiFetch(`${API_BASE_URL}/api/events/${playerId}/today?gameDay=${gameDay}`, {
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `Şehir olayı alınamadı: ${res.status}`);
  return data;
}

export async function logout(playerId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE_URL}/api/auth/logout/${encodeURIComponent(playerId)}`, {
    method: "POST",
    headers: authHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok && res.status !== 401) throw new Error("Oturum kapatılamadı");
}

// ---- Aşama 5: link=şehir, misafir yolcu, korsan sefer ----

export interface CityPublic {
  username: string;
  money: number;
  satisfaction: number;
  hasDriver: boolean;
  hasCheckpoint: boolean;
  lastSeenUtc: string;
  // Adim 1 (link=sehir): paylasilan link tiklanabilir bir KIMLIK gostermeli —
  // yalnizca sayilar degil, sirket adi/amblemi/rengi ve seviye.
  companyName: string | null;
  emblemId: string | null;
  primaryColor: string | null;
  level: number;
  experience: number;
}

/** Adim 3: arkadas listesi satiri. */
export interface Friend {
  username: string;
  companyName: string | null;
  emblemId: string | null;
  primaryColor: string | null;
  level: number;
  satisfaction: number;
  lastSeenUtc: string;
}

export interface CityEvent {
  type: "tip" | "raid" | "raid-caught";
  actorUsername: string | null;
  amount: number;
  createdAtUtc: string;
}

/**
 * Backend metin DEGIL, i18n ANAHTARI doner (`social.raid.success` gibi). Cumleyi
 * arayuz `t(messageKey, { amount })` ile kurar — TR/EN tek sozlukten yonetilir.
 */
export interface ActionResult {
  success: boolean;
  amount: number;
  messageKey: string;
  caught?: boolean;
}

export async function fetchCityPublic(username: string): Promise<CityPublic | null> {
  const res = await apiFetch(`${API_BASE_URL}/api/cities/${username}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Şehir getirilemedi: ${res.status}`);
  return res.json();
}

export async function fetchCityEvents(username: string): Promise<CityEvent[]> {
  const res = await apiFetch(`${API_BASE_URL}/api/cities/${username}/events`);
  if (!res.ok) return [];
  return res.json();
}

export async function tipCity(
  username: string,
  actorPlayerId: string,
  actorUsername: string | null
): Promise<ActionResult> {
  const res = await apiFetch(`${API_BASE_URL}/api/cities/${username}/tip`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ actorPlayerId, actorUsername }),
  });
  return res.json();
}

export async function raidCity(
  username: string,
  actorPlayerId: string,
  actorUsername: string | null
): Promise<ActionResult> {
  const res = await apiFetch(`${API_BASE_URL}/api/cities/${username}/raid`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ actorPlayerId, actorUsername }),
  });
  return res.json();
}

// ---- Adim 3: arkadas listesi ----

export async function fetchFriends(playerId: string): Promise<Friend[]> {
  const res = await apiFetch(`${API_BASE_URL}/api/friends/${playerId}`, {
    headers: jsonAuthHeaders(),
  });
  if (!res.ok) return [];
  return res.json();
}

/** Kullanici adiyla arkadas ekler. Basarisizsa okunabilir bir sebep doner. */
export async function addFriend(
  playerId: string,
  username: string
): Promise<{ ok: true; friend: Friend } | { ok: false; reason: "notFound" | "self" | "duplicate" | "error" }> {
  const res = await apiFetch(`${API_BASE_URL}/api/friends/${playerId}`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ username: username.trim() }),
  });
  if (res.ok) return { ok: true, friend: await res.json() };
  if (res.status === 404) return { ok: false, reason: "notFound" };
  if (res.status === 400) return { ok: false, reason: "self" };
  if (res.status === 409) return { ok: false, reason: "duplicate" };
  return { ok: false, reason: "error" };
}

export async function removeFriend(playerId: string, username: string): Promise<boolean> {
  const res = await apiFetch(`${API_BASE_URL}/api/friends/${playerId}/${encodeURIComponent(username)}`, {
    method: "DELETE",
    headers: jsonAuthHeaders(),
  });
  return res.ok;
}

// ---- Telemetri + geri bildirim (monitoring backend) ----

export interface TelemetryEventPayload {
  eventId: string;
  eventVersion: number;
  type: string;
  dataJson: string;
  clientAtUtc: string;
}

export interface TelemetryBatchPayload {
  sessionId: string;
  clientBuild: string;
  deviceClass: "mobile" | "tablet" | "desktop";
  locale: "tr" | "en";
  playerLevel: number;
  companyId?: string;
  events: TelemetryEventPayload[];
}

export async function sendTelemetry(
  playerId: string,
  payload: TelemetryBatchPayload
): Promise<{ accepted: number; duplicates: number; sessionId: string | null; bootstrap: PlayerBootstrap | null }> {
  const res = await apiFetch(`${API_BASE_URL}/api/telemetry/${playerId}`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(payload),
    keepalive: true,
  });
  if (!res.ok) throw new Error(`Telemetri gönderilemedi: ${res.status}`);
  return res.json();
}

export async function sendFeedback(
  playerId: string,
  payload: { category: string; message: string; contextJson: string }
): Promise<void> {
  const res = await apiFetch(`${API_BASE_URL}/api/feedback/${playerId}`, {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message ?? `Geri bildirim gönderilemedi: ${res.status}`);
  }
}

export interface AnalyticsOverview {
  generatedAtUtc: string;
  activity: { dailyActiveUsers: number; weeklyActiveUsers: number; monthlyActiveUsers: number };
  retention: { day1: number; day7: number; day30: number };
  sessions: { totalSessions: number; averageSeconds: number; medianSeconds: number; p90Seconds: number };
  funnel: { name: string; count: number }[];
  levelDistribution: { level: number; players: number }[];
  currency: { type: string; source: string; amount: number; events: number }[];
  performance: { fpsBuckets: { name: string; count: number }[]; javascriptErrors: number };
  playerState: {
    totalPlayers: number;
    companies: number;
    averageSatisfaction: number;
    averageMoney: number;
    averageGameDay: number;
    playersWithDrivers: number;
    ownedVehicles: number;
    unlockedRoutes: number;
    terminalUpgrades: number;
    playersWithLicencePoints: number;
    lockedVehicles: number;
  };
  criticalEvents: { name: string; events: number; players: number }[];
}

export interface AnalyticsPlayer {
  playerId: string;
  username: string | null;
  companyName: string | null;
  level: number;
  experience: number;
  money: number;
  gameDay: number;
  lastSavedAtUtc: string;
  sessions: { id: string; deviceClass: string; locale: string; clientBuild: string; startedAtUtc: string; endedAtUtc: string | null; durationSeconds: number }[];
  recentEvents: { id: number; type: string; category: string; dataJson: string; createdAtUtc: string }[];
}

export async function fetchAdminAccess(): Promise<boolean> {
  const res = await apiFetch(`${API_BASE_URL}/api/admin/access`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`Admin yetkisi doğrulanamadı: ${res.status}`);
  return true;
}

export async function fetchAnalyticsOverview(): Promise<AnalyticsOverview> {
  const res = await apiFetch(`${API_BASE_URL}/api/admin/analytics/overview`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(res.status === 401 ? "Yetkisiz" : `Dashboard yüklenemedi: ${res.status}`);
  return res.json();
}

export async function fetchAnalyticsPlayer(playerId: string): Promise<AnalyticsPlayer | null> {
  const res = await apiFetch(`${API_BASE_URL}/api/admin/analytics/players/${encodeURIComponent(playerId)}`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 401 ? "Yetkisiz" : `Oyuncu yüklenemedi: ${res.status}`);
  return res.json();
}
