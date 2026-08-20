/**
 * Demo modu — poppanda.net üzerinde backend olmadan yayınlanan sürüm.
 *
 * Oyunun tamamı zaten istemcide simüle ediliyor; backend hesap, sunucu kaydı,
 * şans oyunu kilitleri ve telemetri için var. Demo modunda o katman hiç yok:
 * oyuncu misafir olarak girer ve ilerlemesi yalnızca kendi tarayıcısında,
 * localStorage'da durur.
 *
 * Tam sürüme geçerken `NEXT_PUBLIC_DEMO_MODE` değişkenini kaldırmak yeterli;
 * bu dosyaya dokunan her yer eski davranışına döner.
 */

// Yalnizca tip: derlemede silinir, api.ts ile dongu olusturmaz.
import type { PlayerBootstrap } from "./api";

export const IS_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

/** Demo oyuncusunun kimliği — hesabı yok, tarayıcıya bağlı sabit bir kimlik. */
export const DEMO_PLAYER_ID = "demo-guest";
export const DEMO_AUTH_TOKEN = "demo";

/** Sunucuya çıkan her çağrı demo modunda bununla reddedilir. */
export class DemoOfflineError extends Error {
  constructor(endpoint: string) {
    super(`Demo modu: ${endpoint} sunucusuz çalışıyor.`);
    this.name = "DemoOfflineError";
  }
}

/** Giriş ekranını atlayabilmek için oturum anahtarlarını yerelde oluşturur. */
export function seedDemoSession(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem("fullfilled-player-id", DEMO_PLAYER_ID);
  localStorage.setItem("fullfilled-auth-token", DEMO_AUTH_TOKEN);
}

const BOOTSTRAP_KEY = "fullfilled:demo:bootstrap";

/**
 * Seviye/kilit tablosu normalde sunucuda hesaplanıyor. Demoda böyle bir hesap
 * yok, o yüzden bütün kilitler açık başlar: amaç ilerlemeyi ölçmek değil, oyunu
 * gösterebilmek.
 */
const UNLOCK_IDS = ["upgrades", "drivers", "routes", "terminal", "midibus", "premium", "contracts"];

function openUnlocks() {
  return Object.fromEntries(
    UNLOCK_IDS.map((id) => [id, { id, available: true, requiredLevel: 1, missingMilestones: [] }]),
  );
}

function emptyBootstrap(): PlayerBootstrap {
  return {
    company: null,
    progression: {
      level: 1,
      experience: 0,
      currentLevelExperience: 0,
      nextLevelExperience: 100,
      skillPoints: 0,
      lastAcknowledgedLevel: 1,
      maxLevel: 50,
    },
    unlocks: openUnlocks(),
    achievements: [] as string[],
  };
}

export type DemoBootstrap = PlayerBootstrap;

export function readDemoBootstrap(): DemoBootstrap {
  if (typeof window === "undefined") return emptyBootstrap();
  try {
    const raw = localStorage.getItem(BOOTSTRAP_KEY);
    if (!raw) return emptyBootstrap();
    // Kilitler her açılışta yeniden üretilir; kaydedilmiş olan yalnızca şirket.
    return { ...emptyBootstrap(), ...(JSON.parse(raw) as DemoBootstrap), unlocks: openUnlocks() };
  } catch {
    return emptyBootstrap();
  }
}

export function writeDemoBootstrap(bootstrap: DemoBootstrap): DemoBootstrap {
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(BOOTSTRAP_KEY, JSON.stringify(bootstrap));
    } catch {
      // Depolama dolu ya da kapalıysa oyun yine çalışır, yalnız şirket kalıcı olmaz.
    }
  }
  return bootstrap;
}
