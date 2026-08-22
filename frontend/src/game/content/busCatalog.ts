// Garajdaki minibüs kataloğu. Fiyatlar backend EconomyConstants.BusCatalogPrices
// ile senkron tutulmalıdır.

export type BusCatalogTier = 1 | 2 | 3;
export type BusModelId =
  | "classic"
  | "starter-02"
  | "starter-03"
  | "midibus"
  | "premium";

export interface BusCatalogEntry {
  id: string;
  name: string;
  tier: BusCatalogTier;
  /** Garaj ve oyun dünyasında kullanılacak gerçek 3B varlık. */
  modelId: BusModelId;
  seats: number;
  speedMultiplier: number;
  /** 0 = başlangıç aracı (tutorial sonunda seçilir), >0 = garajdan satın alınır. */
  price: number;
  note: string;
}

export const BUS_CATALOG: readonly BusCatalogEntry[] = [
  {
    id: "hurda-mavi",
    name: "Klasik Mavi",
    tier: 1,
    modelId: "classic",
    seats: 8,
    speedMultiplier: 0.95,
    price: 0,
    note: "Yorgun ama sadık. Yavaş ve dar; ilk seferler için yeterli.",
  },
  {
    id: "hurda-sari",
    name: "Mercan Mini",
    tier: 1,
    modelId: "starter-02",
    seats: 9,
    speedMultiplier: 1,
    price: 0,
    note: "Dengeli başlangıç aracı: bir koltuk fazla, standart hız.",
  },
  {
    id: "hurda-yesil",
    name: "Lavanta Ekspres",
    tier: 1,
    modelId: "starter-03",
    seats: 8,
    speedMultiplier: 1.08,
    price: 0,
    note: "Koltuk sayısı az ama motoru daha canlı; hızlı tur atmak için.",
  },
  {
    id: "midibus",
    name: "Midibüs",
    tier: 2,
    modelId: "midibus",
    seats: 14,
    speedMultiplier: 1.05,
    price: 22000,
    note: "İlk ciddi yükseltme: belirgin koltuk artışı, dengeli hız.",
  },
  {
    id: "premium",
    name: "Şehir Premium",
    tier: 3,
    modelId: "premium",
    seats: 20,
    speedMultiplier: 1.15,
    price: 60000,
    note: "Geniş, hızlı ve prestijli; yoğun hatlarda kazancı katlar.",
  },
] as const;

/** Tutorial sonunda sunulacak üç ücretsiz başlangıç aracı. */
export const STARTER_BUS_IDS = BUS_CATALOG.filter((bus) => bus.price === 0).map(
  (bus) => bus.id,
);

export function getBusCatalogEntry(id: string): BusCatalogEntry | undefined {
  return BUS_CATALOG.find((bus) => bus.id === id);
}
