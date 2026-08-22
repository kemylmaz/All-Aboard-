"use client";

import { useGameStore } from "./store";
import { useUiStore } from "./uiStore";
import { ECONOMY } from "./economy";
import { useT } from "./i18n";

// Polis riski göstergesi: bir bar + ucunda yıldız.
// Bar dolduğunda (veya ceza eşiği aşıldığında) yıldız sarı yanıp söner —
// "polis peşinde" sinyali. Altında ehliyet ceza puanı görünür.
export function RiskMeter() {
  const risk = useGameStore((s) => s.policeRisk);
  const licencePoints = useGameStore((s) => s.licencePoints);
  const lockLeft = useGameStore((s) => s.vehicleLockSecondsLeft);
  const speedKmh = useGameStore((s) => s.currentSpeedKmh);
  const stripMode = useUiStore((s) => s.stripMode);
  const t = useT();

  if (stripMode) return null;

  const speeding = speedKmh > ECONOMY.speed.legalLimitKmh;
  // Yıldız, ceza eşiğine ulaşıldığında alarma geçer.
  const alarm = risk >= ECONOMY.licence.speeding.riskThreshold && speeding;
  const full = risk >= 99;
  const maxPoints = ECONOMY.licence.maxPoints;

  return (
    <aside className="ff-risk-meter" aria-label={t("risk.title")}>
      <div className="ff-risk-head">
        <span className="ff-risk-label">{t("risk.title")}</span>
        <span
          className="ff-risk-star"
          data-alarm={alarm || full}
          aria-hidden="true"
        >
          ★
        </span>
      </div>

      <div className="ff-risk-track">
        <div
          className="ff-risk-fill"
          data-danger={risk >= ECONOMY.licence.overflow.riskThreshold}
          style={{ width: `${Math.min(100, risk)}%` }}
        />
      </div>

      {/* Ehliyet puanı yalnızca gerçekten puan yendiğinde görünür. İki sayı aynı
          ihlalleri sayıyordu: risk anlık baskı, puan onun kalıcı izi. Ortada iz
          yokken ekranda durması, oyuncuya izlemesi gereken ikinci bir ölçü
          olduğunu düşündürüyordu. */}
      {licencePoints > 0 && (
        <div className="ff-risk-licence">
          <span>{t("risk.licence")}</span>
          <span className="tabular-nums" data-warn={licencePoints >= maxPoints * 0.6}>
            {Math.round(licencePoints)}/{maxPoints}
          </span>
        </div>
      )}

      {lockLeft > 0 && (
        <div className="ff-risk-lock">{t("risk.locked", { seconds: Math.ceil(lockLeft) })}</div>
      )}
    </aside>
  );
}
