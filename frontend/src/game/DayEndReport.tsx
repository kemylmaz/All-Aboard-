"use client";

import { useEffect, useRef, useState } from "react";
import { useGameStore } from "./store";
import { dispatchGameAction } from "./useTabSync";
import { submitShiftResult } from "./api";
import { getPlayerId } from "./playerId";
import { useProgressionStore } from "./progressionStore";
import { useT } from "./i18n";
import { getCachedUsername } from "./username";

// Açık (beyaz) panel zeminine göre kontrastı doğrulanmış renkler — C rengi eski koyu-tema
// grisi (#a3a3a3) krem zeminde soluk kalıyordu, --ff-ink-muted eşdeğerine çekildi.
const GRADE_COLORS: Record<string, string> = {
  "S+": "#d69a12", S: "#d69a12", "A+": "#1f9d6e", A: "#1f9d6e",
  "B+": "#1c86c9", B: "#1c86c9", C: "#71757c", D: "#c2620f", F: "#c8493f",
};

// Ertelenen boyutlar (Faz 5-7) — raporda "yakında" olarak yer tutar. Faz 4'te kontrat
// hedefleri aktif boyuta taşındığı için bu liste artık boş; hat mastery/şoför XP kırılımı
// ve risk bonusu gibi sonraki faz kalemleri geldiğinde buraya eklenir.
const DEFERRED_DIMS: string[] = [];

export function DayEndReport() {
  const t = useT();
  const report = useGameStore((s) => s.dayReport);
  const cityEvent = useGameStore((s) => s.cityEvent);
  const eventPrepared = useGameStore((s) => s.eventPrepared);
  const setBootstrap = useProgressionStore((s) => s.setBootstrap);
  const companyName = useProgressionStore((s) => s.bootstrap?.company?.name ?? null);
  const [awardedXp, setAwardedXp] = useState<{ reportKey: string; value: number } | null>(null);
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const submittedKey = useRef<string | null>(null);

  /**
   * Adim 2: gun sonu raporunu paylas. Once native paylasim (mobilde asil hedef bu),
   * yoksa panoya kopyala. Metin her zaman oyuncunun sehir URL'ini icerir — paylasim
   * boylece tiklanabilir bir davete donusur (Adim 1 ile birlikte viral dongu).
   */
  async function shareDay() {
    if (!report) return;
    const username = getCachedUsername();
    const url = username && typeof window !== "undefined"
      ? `${window.location.origin}/${username}`
      : typeof window !== "undefined" ? window.location.origin : "";
    const text = t("share.text", {
      day: report.gameDay,
      grade: report.grade,
      score: Math.round(report.score),
      company: companyName ?? username ?? "",
    });
    const payload = `${text}\n${url}`;
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "Minibus Tycoon", text, url });
        return;
      }
      await navigator.clipboard.writeText(payload);
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 2000);
    } catch {
      // Kullanici paylasimi iptal edebilir veya pano izni olmayabilir — sessiz gec.
    }
  }

  useEffect(() => {
    if (!report) return;
    // Aynı rapor iki kez gönderilmez; çok sekmede yalnız lider gönderir (backend zaten idempotent).
    if (submittedKey.current === report.idempotencyKey) return;
    if (!useGameStore.getState().isLeader) return;
    const playerId = getPlayerId();
    if (!playerId) return;
    submittedKey.current = report.idempotencyKey;
    submitShiftResult(playerId, {
      idempotencyKey: report.idempotencyKey,
      gameDay: report.gameDay,
      grade: report.grade,
      score: report.score,
      moneyEarned: report.netEarned,
      goalId: report.goalId,
      metricsJson: JSON.stringify({ breakdown: report.breakdown, netEarned: report.netEarned }),
    })
      .then((res) => {
        setBootstrap(res.bootstrap);
        setAwardedXp({ reportKey: report.idempotencyKey, value: res.experienceAwarded });
      })
      .catch(() => setAwardedXp({ reportKey: report.idempotencyKey, value: report.xp })); // ağ hatasında en azından önizleme XP'sini göster
  }, [report, setBootstrap]);

  if (!report) return null;

  const gradeColor = GRADE_COLORS[report.grade] ?? "#a3a3a3";

  return (
    <div className="fixed inset-0 z-[105] grid place-items-center overflow-y-auto bg-black/45 p-4 backdrop-blur-sm ff-scroll" role="dialog" aria-modal="true" aria-label={t("day.reportTitle")}>
      <div className="ff-panel-strong my-auto max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto p-5 ff-scroll">
        <div className="flex items-center justify-between">
          <div>
            <div className="ff-section-title">{t("day.reportTitle")}</div>
            <div className="text-xs text-white/50">{t("day.dayNumber", { day: report.gameDay })}</div>
          </div>
          <div className="text-right">
            <div className="ff-display text-5xl leading-none" style={{ color: gradeColor }}>{report.grade}</div>
            <div className="text-xs text-white/50">{t("day.score", { score: report.score })}</div>
          </div>
        </div>

        {/* Boyut kırılımı */}
        <div className="mt-4 space-y-2">
          {report.breakdown.map((dim) => (
            <div key={dim.key}>
              <div className="flex justify-between text-xs">
                <span className="text-white/70">{t(`day.dim.${dim.key}`)}</span>
                <span className="font-bold">{dim.value}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-white/10">
                <div className="h-full rounded-full bg-amber-400" style={{ width: `${dim.value}%` }} />
              </div>
            </div>
          ))}
          {DEFERRED_DIMS.map((key) => (
            <div key={key} className="flex justify-between text-xs text-white/30">
              <span>{t(`day.dim.${key}`)}</span>
              <span>{t("day.soon")}</span>
            </div>
          ))}
        </div>

        {/* Para + XP */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-white/5 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-white/40">{t("day.netEarned")}</div>
            <div className="text-lg font-bold text-emerald-300">₺{report.netEarned.toLocaleString("tr-TR")}</div>
          </div>
          <div className="rounded-lg bg-white/5 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-white/40">{t("day.xpEarned")}</div>
            <div className="text-lg font-bold text-amber-300">+{awardedXp?.reportKey === report.idempotencyKey ? awardedXp.value : report.xp} XP</div>
          </div>
        </div>

        {/* İşletme gideri kalem kalem. Tek satırda "gider" yazsak oyuncu parasının
            nereye gittiğini öğrenemez ve filo kararını körlemesine verirdi. */}
        {report.upkeep && report.upkeep.total > 0 && (
          <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-white/40">
              <span>{t("day.upkeep")}</span>
              <span className="tabular-nums font-bold text-red-300">
                −₺{report.upkeep.total.toLocaleString("tr-TR")}
              </span>
            </div>
            <div className="mt-1.5 grid gap-0.5 text-[11px]">
              {(
                [
                  ["fleet", report.upkeep.fleet],
                  ["salaries", report.upkeep.salaries],
                  ["rent", report.upkeep.rent],
                  ["inspection", report.upkeep.inspection],
                ] as const
              )
                .filter(([, amount]) => amount > 0)
                .map(([key, amount]) => (
                  <div key={key} className="flex items-center justify-between text-white/55">
                    <span>{t(`day.upkeep.${key}`)}</span>
                    <span className="tabular-nums">−₺{amount.toLocaleString("tr-TR")}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Rakip firma: bugun bir durak kaybedildi mi, geri mi alindi. */}
        {(report.rivalLostStop || report.rivalRecoveredStop) && (
          <div
            data-lost={report.rivalLostStop}
            className="mt-3 rounded-lg px-3 py-2 text-[11px] font-bold data-[lost=true]:bg-red-400/10 data-[lost=true]:text-red-200 data-[lost=false]:bg-emerald-400/10 data-[lost=false]:text-emerald-200"
          >
            {report.rivalLostStop ? t("rival.lostToday") : t("rival.recoveredToday")}
          </div>
        )}

        {/* Günün hedefi: tutturuldu mu, hedef neydi, prim ne kadar oldu. */}
        <div className="ff-goal-result mt-3" data-met={report.goalMet}>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide opacity-55">
              {t("day.mainGoal")} · {t(`day.goal.${report.goalId}`)}
            </div>
            <div className="text-xs font-bold">
              {t(report.goalMet ? "day.goalMet" : "day.goalMissed", {
                actual: Math.round(report.goalActual),
                target: Math.round(report.goalTarget),
              })}
            </div>
          </div>
          {report.goalBonus > 0 && (
            <span className="ff-goal-bonus tabular-nums">+₺{Math.round(report.goalBonus)}</span>
          )}
        </div>

        {/* Faz 7: bugünün şehir olayının bu hatta etkisi — kararın sonucu görünür kalır. */}
        {cityEvent && cityEvent.affectedRouteId === report.routeId && (
          <div className="mt-3 rounded-lg bg-white/5 p-2.5 text-[11px] text-white/60">
            <span className="font-bold text-amber-200">⚠ {t(`event.${cityEvent.primary.id}`)}</span>{" "}
            {eventPrepared ? t("event.reportPrepared") : t("event.reportUnprepared")}
          </div>
        )}

        <p className="mt-3 text-[11px] text-white/35">{t("day.deferredNote")}</p>

        {/* Adim 2: paylasilabilir an. Paylasilan metin oyuncunun KENDI sehir URL'ini
            tasir (link=sehir), boylece her paylasim tiklanabilir bir davete donusur. */}
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <button onClick={shareDay} className="ff-button w-full">
            {shareState === "copied" ? t("share.copied") : t("share.button")}
          </button>
          <button onClick={() => dispatchGameAction("dismissDayReport")} className="ff-button ff-button-primary w-full">
            {t("day.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}
