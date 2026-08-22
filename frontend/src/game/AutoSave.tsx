"use client";

import { useEffect } from "react";
import { fetchSave, pushSave } from "./api";
import { ECONOMY } from "./economy";
import { getPlayerId } from "./playerId";
import { useGameStore, type GameSnapshot } from "./store";
import { useUiStore } from "./uiStore";

const LOCAL_SAVE_PREFIX = "fullfilled:save:";
const LOCAL_SAVE_INTERVAL_MS = 2_000;

function readLocalSave(playerId: string): GameSnapshot | null {
  try {
    const value = localStorage.getItem(`${LOCAL_SAVE_PREFIX}${playerId}`);
    return value ? (JSON.parse(value) as GameSnapshot) : null;
  } catch {
    return null;
  }
}

function writeLocalSave(playerId: string) {
  try {
    localStorage.setItem(
      `${LOCAL_SAVE_PREFIX}${playerId}`,
      JSON.stringify(useGameStore.getState().getSnapshot()),
    );
  } catch {
    // Storage failures must not block gameplay or the backend save.
  }
}

export function AutoSave() {
  const loadSnapshot = useGameStore((state) => state.loadSnapshot);
  const applyExternalGain = useGameStore((state) => state.applyExternalGain);
  const showMoneyToast = useUiStore((state) => state.showMoneyToast);

  useEffect(() => {
    const storedPlayerId = getPlayerId();
    if (!storedPlayerId) return;
    const playerId: string = storedPlayerId;

    let cancelled = false;
    let hydrated = false;
    let saveInFlight: Promise<void> | null = null;
    /**
     * Sunucuya en son yazdığımız bakiye. Ziyaretçi bahşişi bunun ÜSTÜNE gelen
     * fark demektir. Kıyas yerel bakiyeyle yapılırsa, bir kayıt gönderimi
     * kaçtığında sunucudaki eski (kesinti öncesi) tutar bahşiş sanılır ve
     * oyuncu ödediği gideri geri alır — para azalabildiği için artık mümkün.
     */
    let lastSyncedMoney: number | null = null;
    const localSave = readLocalSave(playerId);
    if (localSave) loadSnapshot(localSave);

    fetchSave(playerId)
      .then((save) => {
        if (cancelled || !save) return;
        loadSnapshot(save);
        lastSyncedMoney = save.money;
        writeLocalSave(playerId);
        if (save.offlineIncome > 0) {
          showMoneyToast(save.offlineIncome, "Şoförün sen yokken");
        }
      })
      .catch((error) => {
        console.warn("FullFilled: kayıt yüklenemedi, yerel kayıt kullanılacak", error);
      })
      .finally(() => {
        // Never upload the default store before the server snapshot finishes loading.
        hydrated = true;
      });

    function save(): Promise<void> {
      if (!hydrated || cancelled) return Promise.resolve();
      if (saveInFlight) return saveInFlight;

      const task = (async () => {
        writeLocalSave(playerId);
        try {
          // Online synchronization must not generate offline-driver income.
          const server = await fetchSave(playerId, false);
          const baseline = lastSyncedMoney ?? useGameStore.getState().money;
          if (server && server.money > baseline) {
            const gained = server.money - baseline;
            applyExternalGain(gained);
            showMoneyToast(gained, "Ziyaretçilerin sana");
            lastSyncedMoney = server.money;
          }
        } catch {
          // The local snapshot protects the session if the API is offline.
        }

        try {
          const snapshot = useGameStore.getState().getSnapshot();
          await pushSave(playerId, snapshot);
          // Yalnızca gönderim başarılıysa kıyas noktası ilerler.
          lastSyncedMoney = snapshot.money;
        } catch (error) {
          console.warn("FullFilled: kayıt gönderilemedi", error);
        }
      })();

      saveInFlight = task.finally(() => {
        saveInFlight = null;
      });
      return saveInFlight;
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") void save();
    }

    function onPageHide() {
      writeLocalSave(playerId);
      void save();
    }

    const localSaveInterval = window.setInterval(
      () => writeLocalSave(playerId),
      LOCAL_SAVE_INTERVAL_MS,
    );
    const backendSaveInterval = window.setInterval(
      () => void save(),
      ECONOMY.save.autosaveIntervalSeconds * 1000,
    );
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      writeLocalSave(playerId);
      window.clearInterval(localSaveInterval);
      window.clearInterval(backendSaveInterval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [loadSnapshot, applyExternalGain, showMoneyToast]);

  return null;
}
