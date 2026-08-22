"use client";

import { useEffect, useMemo, useState } from "react";
import { pushSave, spinWheel } from "./api";
import { ECONOMY } from "./economy";
import { CoinsIcon, DiceIcon, XIcon } from "./GameIcon";
import { getPlayerId } from "./playerId";
import { useGameStore, type ChanceGameResult, type ChanceGamesState } from "./store";
import { useUiStore } from "./uiStore";
import { useT } from "./i18n";

type Tone = "muted" | "blue" | "green" | "gold" | "red" | "amber";

type WeightedItem = {
  id: string;
  label: string;
  multiplier?: number;
  amount?: number;
  payout?: number;
  weight: number;
  tone: Tone;
};

const TONE_COLORS: Record<Tone, string> = {
  muted: "#475569",
  blue: "#38bdf8",
  green: "#34d399",
  gold: "#facc15",
  red: "#f87171",
  amber: "#fb923c",
};

export function ChanceGamesPanel() {
  const open = useUiStore((s) => s.chanceGamesOpen);
  return open ? <ChanceGamesContent /> : null;
}

function ChanceGamesContent() {
  const t = useT();
  const close = useUiStore((s) => s.closeChanceGames);
  const money = useGameStore((s) => s.money);
  const gameDay = useGameStore((s) => s.gameDay);
  const chanceGames = useGameStore((s) => s.chanceGames);
  const isLeader = useGameStore((s) => s.isLeader);

  const [busyGame, setBusyGame] = useState<ChanceGameResult["gameId"] | null>(null);
  const [rotation, setRotation] = useState(18);
  const [lastResult, setLastResult] = useState<ChanceGameResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const chanceConfig = ECONOMY.chanceGames;
  const wheel = chanceConfig.wheel;
  const segments = wheel.segments as WeightedItem[];
  const dailyLimit = chanceConfig.dailyBudgetLimit as number;
  const remainingLimit = Math.max(0, dailyLimit - chanceGames.dailyLimitUsed);

  const wheelStake = wheel.stake as number;
  const wheelLeft = Math.max(0, (wheel.maxSpinsPerDay as number) - chanceGames.wheelSpinsToday);

  const conicGradient = useMemo(() => {
    const slice = 100 / segments.length;
    return `conic-gradient(${segments
      .map((segment, index) => `${TONE_COLORS[segment.tone]} ${index * slice}% ${(index + 1) * slice}%`)
      .join(", ")})`;
  }, [segments]);

  async function runGame(
    gameId: ChanceGameResult["gameId"],
    action: (playerId: string) => Promise<{ money: number; chanceGames: ChanceGamesState; result: ChanceGameResult }>
  ) {
    if (!isLeader || busyGame) return;
    const playerId = getPlayerId();
    if (!playerId) {
      setError(t("chance.loginRequired"));
      return;
    }

    setBusyGame(gameId);
    setError(null);
    setLastResult(null);

    try {
      await pushSave(playerId, useGameStore.getState().getSnapshot());
      const response = await action(playerId);
      useGameStore.getState().applyChanceGameResult(response.money, response.chanceGames, response.result);
      setLastResult(response.result);

      if (gameId === "wheel") {
        const resultIndex = Math.max(0, segments.findIndex((s) => s.label === response.result.label));
        const sliceAngle = 360 / segments.length;
        setRotation((value) => value + 720 + (360 - (resultIndex + 0.5) * sliceAngle));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chance.error"));
    } finally {
      window.setTimeout(() => setBusyGame(null), 350);
    }
  }

  return (
    <div className="ff-chance-overlay pointer-events-auto fixed inset-0 z-60 font-sans">
      <main data-tutorial="chance-panel" className="ff-chance-page absolute flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label={t("chance.title")}>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3.5 sm:px-7">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <DiceIcon className="h-5 w-5" />
              <h2 className="ff-display text-xl leading-none">{t("chance.title")}</h2>
            </div>
            <p className="mt-1 hidden text-xs font-semibold text-ff-muted sm:block">{t("chance.subtitle")}</p>
          </div>
          <button onClick={close} className="ff-button ff-button-ghost h-9 min-h-9 w-9 p-0" title="Kapat">
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="grid shrink-0 grid-cols-2 gap-px border-b bg-ff-ink/10 sm:grid-cols-4">
          <InfoPill label={t("chance.cash")} value={formatMoney(money)} />
          <InfoPill label={t("chance.dailyLimit")} value={`${formatMoney(chanceGames.dailyLimitUsed)} / ${formatMoney(dailyLimit)}`} />
          <InfoPill label={t("chance.remaining")} value={formatMoney(remainingLimit)} />
          <InfoPill label={t("chance.result")} value={lastResult ? `${lastResult.label}` : t("chance.waiting")} />
        </div>

        <div className="ff-scroll min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          <section className="ff-chance-grid grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="ff-card ff-chance-card rounded-xl p-3">
              <GameHeader title={t("chance.wheel")} subtitle={t("chance.stakeRights", { stake: formatMoney(wheelStake), count: wheelLeft })} />
              <div className="relative mx-auto mb-3 aspect-square w-full max-w-[128px]">
                <div className="absolute left-1/2 top-0 z-10 h-0 w-0 -translate-x-1/2 border-x-[8px] border-t-[14px] border-x-transparent border-t-ff-ink" />
                <div
                  className="h-full w-full rounded-full border-[6px] border-ff-ink/15 transition-transform duration-700 ease-out"
                  style={{ background: conicGradient, transform: `rotate(${rotation}deg)` }}
                >
                  <div className="absolute inset-[24%] flex items-center justify-center rounded-full border border-ff-ink/20 bg-ff-paper text-center">
                    <div>
                      <div className="ff-display text-sm">{t("chance.spin")}</div>
                      <div className="mt-0.5 text-[10px] font-bold text-ff-muted">{formatMoney(wheelStake)}</div>
                    </div>
                  </div>
                </div>
              </div>
              <GameButton disabled={!canPlay(isLeader, busyGame, money, remainingLimit, wheelStake, wheelLeft)} busy={busyGame === "wheel"} label={t("chance.spinWheel")} onClick={() => runGame("wheel", (playerId) => spinWheel(playerId, gameDay))} />
            </div>

            {!isLeader && <PanelNotice tone="amber" text={t("chance.spectator")} />}
            {error && <PanelNotice tone="red" text={error} />}
            {lastResult && <ResultBanner result={lastResult} />}
          </section>

          <section className="mt-3 flex min-w-0 items-center gap-2 overflow-x-auto rounded-xl border border-ff-ink/10 bg-white/35 p-2">
            <span className="shrink-0 px-2 text-[10px] font-bold uppercase tracking-[0.12em] text-ff-muted">{t("chance.recent")}</span>
            {chanceGames.recentResults.length === 0
              ? <span className="text-xs text-ff-muted">{t("chance.noResults")}</span>
              : chanceGames.recentResults.slice(0, 6).map((result) => <ResultRow key={result.id} result={result} />)}
          </section>
        </div>
      </main>
    </div>
  );
}

function GameHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const t = useT();
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <div>
        <h3 className="ff-display text-sm">{title}</h3>
        <p className="text-xs font-semibold text-white/45">{subtitle}</p>
      </div>
      <span className="rounded-md bg-ff-ink/7 px-2 py-1 text-[9px] font-bold text-ff-muted">{t("chance.legal")}</span>
    </div>
  );
}

function MiniCard({
  title,
  subtitle,
  body,
  actionLabel,
  secondActionLabel,
  disabled,
  busy,
  onAction,
  onSecondAction,
}: {
  title: string;
  subtitle: string;
  body: string;
  actionLabel: string;
  secondActionLabel?: string;
  disabled: boolean;
  busy: boolean;
  onAction: () => void;
  onSecondAction?: () => void;
}) {
  return (
    <div className="ff-card ff-chance-card rounded-xl p-3">
      <GameHeader title={title} subtitle={subtitle} />
      <div className="mb-3 rounded-lg bg-ff-ink/5 px-3 py-3 text-center">
        <div className="ff-display text-lg">{body}</div>
      </div>
      <div className={secondActionLabel ? "grid grid-cols-2 gap-2" : ""}>
        <GameButton disabled={disabled} busy={busy} label={actionLabel} onClick={onAction} />
        {secondActionLabel && onSecondAction && (
          <GameButton disabled={disabled} busy={busy} label={secondActionLabel} onClick={onSecondAction} />
        )}
      </div>
    </div>
  );
}

function GameButton({ disabled, busy, label, onClick }: { disabled: boolean; busy: boolean; label: string; onClick: () => void }) {
  const t = useT();
  return (
    <button onClick={onClick} disabled={disabled} className="ff-button ff-button-primary w-full min-h-11 text-sm">
      {busy ? t("chance.processing") : label}
    </button>
  );
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ff-paper px-4 py-2.5">
      <div className="text-[10px] font-black uppercase text-white/42">{label}</div>
      <div className="ff-display mt-1 flex min-w-0 items-center gap-1 truncate text-xs text-white sm:text-sm">
        <CoinsIcon className="h-3.5 w-3.5 text-amber-200" />
        {value}
      </div>
    </div>
  );
}

function ResultBanner({ result }: { result: ChanceGameResult }) {
  const won = result.net > 0;
  return (
    <div className={`col-span-full rounded-lg px-3 py-3 text-center font-black ${won ? "bg-emerald-400/14 text-emerald-100" : "bg-red-400/14 text-red-100"}`}>
      {result.label}: {result.net > 0 ? "+" : ""}{formatMoney(result.net)}
    </div>
  );
}

function ResultRow({ result }: { result: ChanceGameResult }) {
  const t = useT();
  const won = result.net > 0;
  return (
    <div className="flex min-w-[150px] items-center justify-between gap-3 rounded-lg bg-ff-ink/5 px-2.5 py-1.5 text-xs">
      <div className="min-w-0">
        <div className="truncate font-black">{result.label}</div>
        <div className="text-xs font-semibold text-white/38">{t("chance.stake")} {formatMoney(result.stake)} - {result.gameId}</div>
      </div>
      <div className={`ff-display shrink-0 ${won ? "text-emerald-200" : result.net < 0 ? "text-red-200" : "text-white/60"}`}>
        {result.net > 0 ? "+" : ""}{formatMoney(result.net)}
      </div>
    </div>
  );
}

function PanelNotice({ tone, text }: { tone: "amber" | "red"; text: string }) {
  return (
    <div className={`col-span-full rounded-md px-3 py-2 text-center text-xs font-black ${tone === "red" ? "bg-red-400/14 text-red-100" : "bg-amber-300/14 text-amber-100"}`}>
      {text}
    </div>
  );
}

function canPlay(
  isLeader: boolean,
  busyGame: ChanceGameResult["gameId"] | null,
  money: number,
  remainingLimit: number,
  stake: number,
  playsLeft: number
) {
  return isLeader && !busyGame && money >= stake && remainingLimit >= stake && playsLeft > 0;
}

function formatMoney(value: number) {
  return `TL ${Math.round(value).toLocaleString("tr-TR")}`;
}
