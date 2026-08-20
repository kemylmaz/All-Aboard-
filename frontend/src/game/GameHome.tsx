"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useUiStore } from "./uiStore";
import { EditorHotkeys } from "./editor/EditorHotkeys";
import { IS_DEMO } from "./demo";
import { InteractionHud } from "./InteractionHud";
import { StopPayoutFx } from "./StopPayoutFx";
import { DetourPayoutOverlay } from "./DetourPayoutOverlay";
import { ManagementHotkeys } from "./ManagementHotkeys";
import { ManagementHud } from "./ManagementHud";
import { AutoSave } from "./AutoSave";
import { FunnelTelemetry } from "./FunnelTelemetry";
import { TabSync } from "./TabSync";
import { SpeedLimiterWidget } from "./SpeedLimiterWidget";
import { DrivingControls } from "./DrivingControls";
import { PoliceAlert } from "./PoliceAlert";
import { TopNav } from "./TopNav";
import { ChanceGamesPanel } from "./ChanceGamesPanel";
import { StripBar } from "./StripBar";
import { StripModeHotkeys } from "./StripModeHotkeys";
import { ToastHub } from "./ToastHub";
import { CornerControls } from "./CornerControls";
import { LocaleHydrator } from "./i18n";
import { useGameStore } from "./store";
import { RadioPlayer } from "./RadioPlayer";
import { StopApproachHud } from "./StopApproachHud";
import { ProfilePanel, ProfileTracker } from "./ProfilePanel";
import { SettingsHydrator, SettingsPanel } from "./SettingsPanel";
import { GameBottomNav } from "./GameBottomNav";
import { MobileDrivingControls } from "./MobileDrivingControls";
import { TutorialOverlay } from "./TutorialOverlay";
import { TutorialTriggers } from "./TutorialTriggers";
import { LevelUpModal } from "./ProgressionUi";
import { DayStartModal } from "./DayStartModal";
import { DayEndReport } from "./DayEndReport";
import { LapReport } from "./LapReport";
import { UpgradeCelebrationCard } from "./UpgradeCelebrationCard";
import { SfxBinder } from "./SfxBinder";
import { RiskMeter } from "./RiskMeter";
import { PenaltyCard } from "./PenaltyCard";
import { DailyEventCard } from "./DailyEventCard";
import { TerminalUnveil } from "./TerminalUnveil";
import { GameBootSplash } from "./GameBootSplash";

const GameCanvas = dynamic(() => import("./GameCanvas"), { ssr: false });
const EditorPanel = dynamic(() => import("./editor/EditorPanel").then((m) => m.EditorPanel), {
  ssr: false,
});

// Oyuncunun KENDİ şehri — hem "/" hem de kendi "/[username]"'i bu bileşeni gösterir
// (bkz. app/[username]/page.tsx — kullanıcı adı eşleşmezse VisitorCity gösterilir).
export function GameHome() {
  const toggleChaseMode = useUiStore((s) => s.toggleChaseMode);
  const stripMode = useUiStore((s) => s.stripMode);

  // C tuşu: takip kamerasını aç/kapat
  useEffect(() => {
    // The old shift-desk/service-order mechanic has been retired.
    useGameStore.setState({
      servicePlan: null,
      servicePlanMinutesLeft: 0,
    });
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "c" || e.key === "C") toggleChaseMode();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleChaseMode]);

  return (
    <main
      className={
        stripMode
          ? "fixed inset-0 h-dvh w-dvw overflow-hidden bg-black"
          : "relative h-dvh w-dvw overflow-hidden"
      }
    >
      <LocaleHydrator />
      <ProfileTracker />
      <SettingsHydrator />
      <AutoSave />
      <FunnelTelemetry />
      <TabSync />
      {/* Demoda seviye editoru hic yuklenmez: leva paneli kendini otomatik acar. */}
      {!IS_DEMO && <EditorHotkeys />}
      <ManagementHotkeys />
      <StripModeHotkeys />
      <DrivingControls />
      <GameCanvas />
      {/* Logo TopNav içinde sol ve sağ HUD gruplarının doğal akışında yer alır. */}
      <TopNav />
      <GameBottomNav />
      <MobileDrivingControls />
      {!stripMode && <RadioPlayer />}
      {!stripMode && <ChanceGamesPanel />}
      <StripBar />
      {!IS_DEMO && !stripMode && <EditorPanel />}
      <StopApproachHud />
      <StopPayoutFx />
      <DetourPayoutOverlay />
      <InteractionHud />
      <ProfilePanel />
      <SettingsPanel />
      {!stripMode && <ManagementHud />}
      {!stripMode && <SpeedLimiterWidget />}
      <ToastHub />
      <CornerControls />
      <PoliceAlert />
      <TutorialOverlay />
      <TutorialTriggers />
      <LevelUpModal />
      <DayStartModal />
      <LapReport />
      <SfxBinder />
      <RiskMeter />
      <PenaltyCard />
      <DailyEventCard />
      <UpgradeCelebrationCard />
      <TerminalUnveil />
      <DayEndReport />
      {/* En ustte: harita yuklenene kadar "Oyun hazirlaniyor" perdesi. */}
      <GameBootSplash />
    </main>
  );
}
