"use client";

import { useEffect, useState } from "react";
import { useGameStore, type ShiftAssignments, type ShiftSlotId } from "./store";
import { useUiStore, type ManagementTab } from "./uiStore";
import { ECONOMY } from "./economy";
import { dispatchGameAction } from "./useTabSync";
import { getPlayerId } from "./playerId";
import { fetchCityEvents, raidCity, type CityEvent } from "./api";
import { ROUTE_DEFINITIONS, getRouteDefinition, getRouteGeometry } from "./route";
import { GaragePanel } from "./GaragePanel";
import { FriendsPanel } from "./FriendsPanel";
import { BusIcon, CityIcon, DriverIcon, GarageIcon, RouteIcon, WrenchIcon, XIcon } from "./GameIcon";
import { getTerminalEffects, TERMINAL_UPGRADES } from "./terminal";
import { useT } from "./i18n";
import { pushToast } from "./toastStore";
import { BUS_CATALOG } from "./content/busCatalog";
import {
  MAIN_BUS_ID,
  getBusDailyGross,
  getDriverDailySalary,
  estimateShiftNet,
  extraBusPaybackShifts,
  secondLinePaybackShifts,
} from "./paybackEconomy";
import { estimateAssignment, scenarioTags, type RiskLevel } from "./driverProfile";

const SHIFT_SLOTS = ECONOMY.shifts.slots as {
  id: ShiftSlotId;
  label: string;
  startHour: number;
  endHour: number;
  legal: boolean;
}[];

function formatHour(hour: number) {
  return `${String(hour % 24).padStart(2, "0")}:00`;
}

const RISK_COLOR: Record<RiskLevel, string> = { low: "text-emerald-300", medium: "text-amber-300", high: "text-red-300" };

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const t = useT();
  return <span className={`font-bold ${RISK_COLOR[risk]}`}>{t(`management.risk.${risk}`)}</span>;
}

// Faz 2: kritik yatırımın tahmini amortisman süresi (kaç vardiyada kendini öder).
function PaybackHint({ shifts }: { shifts: number | null }) {
  const t = useT();
  return (
    <div className="mb-2 text-[11px] font-semibold text-emerald-300/90">
      {shifts === null
        ? t("management.paybackNever")
        : t("management.paybackShifts", { shifts })}
    </div>
  );
}

export function ManagementHud() {
  const t = useT();
  const open = useUiStore((s) => s.managementOpen);
  const activeTab = useUiStore((s) => s.managementTab);
  const openTab = useUiStore((s) => s.openManagementTab);
  const toggleManagement = useUiStore((s) => s.toggleManagement);
  const closeManagement = useUiStore((s) => s.closeManagement);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeManagement();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeManagement, open]);

  if (!open) return null;

  const TABS = [
    { id: "garage" as ManagementTab, label: t("management.garage"), icon: GarageIcon },
    { id: "drivers" as ManagementTab, label: t("management.drivers"), icon: DriverIcon },
    { id: "upgrades" as ManagementTab, label: t("management.upgrades"), icon: WrenchIcon },
    { id: "routes" as ManagementTab, label: t("management.routes"), icon: RouteIcon },
    { id: "city" as ManagementTab, label: t("management.city"), icon: CityIcon },
    { id: "friends" as ManagementTab, label: t("management.friends"), icon: DriverIcon },
  ];

  return (
    <div data-tutorial="management-panel" className="ff-management-shell pointer-events-auto fixed inset-x-2 bottom-2 top-[6.5rem] z-20 flex flex-col overflow-hidden rounded-2xl font-sans text-white min-[760px]:inset-x-auto min-[760px]:bottom-3 min-[760px]:right-3 min-[760px]:top-[4.4rem] min-[760px]:w-[min(35rem,calc(100vw-1.5rem))]" role="dialog" aria-modal="true" aria-label={t("management.title")}>
      {/* Başlık */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="ff-stat-icon flex h-10 w-10 items-center justify-center bg-amber-300/12 text-amber-200">
            <BusIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="ff-section-title">{t("management.business")}</p>
            <h2 className="ff-display mt-1 text-xl leading-none text-white">{t("management.title")}</h2>
          </div>
        </div>
        <button
          onClick={toggleManagement}
          className="ff-button ff-button-ghost h-9 min-h-9 w-9 p-0"
          title={t("nav.close")}
          aria-label={t("nav.close")}
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Sekme çubuğu */}
      <div className="shrink-0 border-b border-white/8 px-3 py-2.5">
        <div className="grid grid-cols-6 gap-1.5">
          {TABS.map((t) => {
            const TabIcon = t.icon;
            return (
              <button
                key={t.id}
                data-tutorial={`management-${t.id}`}
                onClick={() => openTab(t.id)}
                data-active={activeTab === t.id}
                className="ff-management-tab flex min-w-0 flex-col items-center justify-center gap-1.5 border border-transparent px-1 py-2 text-[9px] font-black uppercase tracking-[0.05em] text-white/46 transition-all"
              >
                <TabIcon className="h-[18px] w-[18px]" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* İçerik */}
      <div className="ff-management-content flex-1 overflow-y-auto ff-scroll p-4 sm:p-5">
        {activeTab === "garage"   && <GarageTab />}
        {activeTab === "drivers"  && <DriversTab />}
        {activeTab === "upgrades" && <UpgradesTab />}
        {activeTab === "routes"   && <RoutesTab />}
        {activeTab === "city"     && <CityTab />}
        {activeTab === "friends"  && <FriendsPanel />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GARAJ SEKMESİ — sahip olunan dolmuşlar + yeni satın alma
// ─────────────────────────────────────────────────────────────────────────────
function GarageTab() {
  const t = useT();
  const money = useGameStore((s) => s.money);
  const ownedBuses = useGameStore((s) => s.ownedBuses);
  const hiredDriverId = useGameStore((s) => s.hiredDriverId);
  const driverActive = useGameStore((s) => s.driverActive);
  const driverAssignments = useGameStore((s) => s.driverAssignments);
  const driverShiftMinutes = useGameStore((s) => s.driverShiftMinutes);

  const costs = ECONOMY.extraBuses.purchaseCosts as number[];
  const nextCost = costs[ownedBuses.length];
  const maxBuses = costs.length;

  return (
    <div className="space-y-3">
      {/* Katalog: hangi dolmusu suruyoruz + 3B onizleme (Faz 4) */}
      <GaragePanel />

      {/* Ana dolmuş */}
      <BusCard
        name={t("management.myBus")}
        color="#f59e0b"
        driverLabel={hiredDriverId
          ? `${ECONOMY.drivers.find((d) => d.id === hiredDriverId)?.name ?? hiredDriverId} (${driverActive ? t("management.driving") : t("management.waiting")})`
          : t("management.selfDriving")}
        busId={MAIN_BUS_ID}
        assignments={driverAssignments[MAIN_BUS_ID]}
        shiftMinutes={hiredDriverId ? (driverShiftMinutes[hiredDriverId] ?? 0) : 0}
        isMainBus
      />

      {/* Satın alınan ek dolmuşlar */}
      {ownedBuses.map((bus) => {
        const driver = ECONOMY.drivers.find((d) => d.id === bus.driverAssignedId);
        return (
          <BusCard
            key={bus.id}
            name={bus.name}
            color={bus.color}
            driverLabel={driver ? `${driver.name} (${t("management.passiveRate", { amount: ECONOMY.extraBuses.idleIncomePerSecond })})` : t("management.driverUnassigned")}
            busId={bus.id}
            assignments={driverAssignments[bus.id]}
            shiftMinutes={bus.driverAssignedId ? (driverShiftMinutes[bus.driverAssignedId] ?? 0) : 0}
          />
        );
      })}

      {/* Yeni dolmuş satın al */}
      {ownedBuses.length < maxBuses ? (
        <div className="rounded-lg border border-dashed border-white/20 p-3">
          <div className="mb-2 text-sm font-bold">+ {t("management.buyNewBus")}</div>
          <div className="mb-2 text-xs text-white/50">
            {ECONOMY.extraBuses.names[ownedBuses.length] ?? `${t("management.bus")} #${ownedBuses.length + 2}`}
            {" · "}{t("management.assignForPassive")}
          </div>
          <PaybackHint shifts={extraBusPaybackShifts()} />
          <button
            onClick={() => dispatchGameAction("buyBus")}
            disabled={money < nextCost}
            className="ff-button ff-button-primary w-full"
          >
            {t("garage.buy")} — ₺{nextCost.toLocaleString()}
          </button>
        </div>
      ) : (
        <p className="text-center text-xs text-white/30">{t("management.maxBuses")}</p>
      )}
    </div>
  );
}

function BusCard({
  name,
  color,
  driverLabel,
  busId,
  assignments,
  shiftMinutes,
  isMainBus = false,
}: {
  name: string;
  color: string;
  driverLabel: string;
  busId: string;
  assignments?: ShiftAssignments;
  shiftMinutes: number;
  isMainBus?: boolean;
}) {
  const maxShift = ECONOMY.driverFatigue.maxShiftGameMinutes as number;
  const warnShift = ECONOMY.driverFatigue.warningShiftGameMinutes as number;
  const shiftHours = Math.floor(shiftMinutes / 60);
  const shiftMins = Math.floor(shiftMinutes % 60);
  const isTired = shiftMinutes >= maxShift;
  const isWarning = shiftMinutes >= warnShift;

  return (
    <div className="rounded-lg bg-white/5 p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-lg">🚐</span>
        <div
          className="h-3 w-3 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="font-bold text-sm">{name}</span>
        {isMainBus && <span className="ml-auto text-[10px] text-amber-300 font-bold">ANA ARAÇ</span>}
      </div>
      <div className="text-xs text-white/60">{driverLabel}</div>
      <div className="mt-2 grid grid-cols-1 gap-1.5 min-[420px]:grid-cols-3">
        {SHIFT_SLOTS.map((slot) => {
          const driverId = assignments?.[slot.id] ?? null;
          const driver = ECONOMY.drivers.find((d) => d.id === driverId);
          const net = estimateShiftNet(busId, slot.id, driverId);
          return (
            <div key={slot.id} className="rounded-md bg-black/20 px-2 py-1">
              <div className="text-[10px] font-black text-white/70">
                {slot.label} {!slot.legal && <span className="text-red-300">Gizli</span>}
              </div>
              <div className="truncate text-[10px] text-white/45">
                {formatHour(slot.startHour)}-{formatHour(slot.endHour)}
              </div>
              <div className="truncate text-[11px] font-bold text-amber-200">
                {driver ? driver.name : "Bos"}
              </div>
              {driver && <div className="text-[10px] text-emerald-300">Net ~₺{net.toFixed(0)}</div>}
            </div>
          );
        })}
      </div>
      {shiftMinutes > 0 && (
        <div className={`mt-1.5 text-[10px] font-bold ${isTired ? "text-red-300" : isWarning ? "text-amber-300" : "text-white/40"}`}>
          {isTired ? "⚠️ Yorgun! " : isWarning ? "🟡 " : ""}
          Vardiya: {shiftHours}s {shiftMins}d / {maxShift / 60}s
          {isTired && " — polis riski artıyor"}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ŞOFÖRLER SEKMESİ — tüm şoförler, atama/çıkarma
// ─────────────────────────────────────────────────────────────────────────────
function DriversTab() {
  const t = useT();
  const money = useGameStore((s) => s.money);
  const hiredDriverId = useGameStore((s) => s.hiredDriverId);
  const driverActive = useGameStore((s) => s.driverActive);
  const ownedBuses = useGameStore((s) => s.ownedBuses);
  const driverAssignments = useGameStore((s) => s.driverAssignments);
  const driverShiftMinutes = useGameStore((s) => s.driverShiftMinutes);
  const driverMorale = useGameStore((s) => s.driverMorale);
  const [selectedBusForAssign, setSelectedBusForAssign] = useState<string | null>(null);

  // Hangi şoförler nerede?
  function driverLocation(driverId: string): string {
    if (hiredDriverId === driverId) return driverActive ? t("management.driving") : t("management.waiting");
    const bus = ownedBuses.find((b) => b.driverAssignedId === driverId);
    if (bus) return bus.name;
    return "";
  }

  function isDriverBusy(driverId: string): boolean {
    return hiredDriverId === driverId || ownedBuses.some((b) => b.driverAssignedId === driverId);
  }

  const maxShift = ECONOMY.driverFatigue.maxShiftGameMinutes as number;

  return (
    <div className="space-y-2">
      <ShiftAssignmentBoard ownedBuses={ownedBuses} assignments={driverAssignments} />

      {/* Ana araç sürücüsü */}
      <div className="ff-section-title mb-2">{t("management.mainDriver")}</div>
      {hiredDriverId ? (
        <div className="rounded-lg bg-white/6 p-3">
          <DriverRow
            driver={ECONOMY.drivers.find((d) => d.id === hiredDriverId)!}
            shiftMinutes={driverShiftMinutes[hiredDriverId] ?? 0}
            maxShift={maxShift}
            locationLabel={driverActive ? t("management.driving") : t("management.waiting")}
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => dispatchGameAction("toggleDriverActive")}
              className={`ff-button flex-1 text-xs ${driverActive ? "ff-button-red" : "ff-button-green"}`}
            >
              {driverActive ? t("management.driveYourself") : t("management.leaveToDriver")}
            </button>
            <button
              onClick={() => dispatchGameAction("fireDriver")}
              className="ff-button ff-button-ghost text-xs px-2"
              title="Şoförü işten çıkar"
            >
              ✕
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-white/40 mb-3">{t("management.noMainDriver")}</p>
      )}

      {/* Ek araç atamaları */}
      {ownedBuses.length > 0 && (
        <>
          <div className="ff-section-title mt-3 mb-2">{t("management.extraAssignments")}</div>
          {ownedBuses.map((bus) => (
            <div key={bus.id} className="rounded-lg bg-white/5 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: bus.color }} />
                <span className="text-sm font-bold">{bus.name}</span>
                {bus.driverAssignedId && (
                  <button
                    onClick={() => dispatchGameAction("unassignDriverFromBus", bus.id)}
                    className="ml-auto ff-button ff-button-ghost text-[10px] px-1.5 py-0.5 min-h-0 h-5"
                  >
                    {t("management.remove")}
                  </button>
                )}
              </div>
              {bus.driverAssignedId ? (
                <DriverRow
                  driver={ECONOMY.drivers.find((d) => d.id === bus.driverAssignedId)!}
                  shiftMinutes={driverShiftMinutes[bus.driverAssignedId] ?? 0}
                  maxShift={maxShift}
                  locationLabel={t("management.driving")}
                />
              ) : (
                <button
                  onClick={() => setSelectedBusForAssign(selectedBusForAssign === bus.id ? null : bus.id)}
                  className="ff-button ff-button-primary w-full text-xs"
                >
                  {t("management.assignDriver")}
                </button>
              )}
              {selectedBusForAssign === bus.id && (
                <DriverPickerInline
                  busId={bus.id}
                  excludeIds={[
                    hiredDriverId ?? "",
                    ...ownedBuses.filter((b) => b.id !== bus.id && b.driverAssignedId).map((b) => b.driverAssignedId!),
                  ]}
                  onPick={() => setSelectedBusForAssign(null)}
                />
              )}
            </div>
          ))}
        </>
      )}

      {/* Tüm şoförler listesi */}
      <div className="ff-section-title mt-3 mb-2">{t("management.allDrivers")}</div>
      <div className="space-y-1">
        {ECONOMY.drivers.map((d) => {
          const busy = isDriverBusy(d.id);
          const loc = driverLocation(d.id);
          const shift = driverShiftMinutes[d.id] ?? 0;
          const morale = driverMorale[d.id] ?? ECONOMY.driverMorale.initial;
          const tags = scenarioTags(d);
          return (
            <div
              key={d.id}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${busy ? "bg-amber-500/10" : "bg-white/5"}`}
            >
              <DriverPortrait portraitPath={d.portraitPath} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 font-bold">
                  {d.name}
                  <span className="text-white/40">&quot;{d.nickname}&quot;</span>
                  <span className="text-[10px] font-normal text-sky-300">{t(`management.personality.${d.personality}`)}</span>
                </div>
                <div className="text-white/50">
                  {t("management.speedEfficiency", { speed: Math.round(d.speedMultiplier * 100), efficiency: Math.round(d.efficiency * 100) })}
                  {loc && <span className="ml-1 text-amber-300">· {loc}</span>}
                  {shift > 0 && <span className={`ml-1 ${shift >= maxShift ? "text-red-300" : "text-white/40"}`}>
                    · {Math.floor(shift / 60)}s {Math.floor(shift % 60)}d
                  </span>}
                  {busy && <span className="ml-1 text-white/40">· {t("management.morale", { value: Math.round(morale) })}</span>}
                </div>
                <div className="mt-0.5 text-[10px] text-white/35">
                  {t("management.strongAt")}: {tags.strong.map((tag) => t(`management.tag.${tag}`)).join(", ")}
                  {" · "}
                  {t("management.weakAt")}: {tags.weak.map((tag) => t(`management.tag.${tag}`)).join(", ")}
                </div>
              </div>
              {!busy && !hiredDriverId && (
                <button
                  onClick={() => dispatchGameAction("hireDriver", d.id)}
                  disabled={money < d.hireCost}
                  className="ff-button ff-button-green shrink-0 min-h-7 px-2 py-1 text-[11px]"
                >
                  ₺{d.hireCost.toLocaleString("tr-TR")}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DriverPickerInline({
  busId,
  excludeIds,
  onPick,
}: {
  busId: string;
  excludeIds: string[];
  onPick: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-2 max-h-48 overflow-y-auto ff-scroll space-y-1 rounded-lg bg-white/5 p-2">
      {ECONOMY.drivers
        .filter((d) => !excludeIds.includes(d.id))
        .map((d) => (
          <button
            key={d.id}
            onClick={() => {
              dispatchGameAction("assignDriverToBus", busId, d.id);
              onPick();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-white/10"
          >
            <DriverPortrait portraitPath={d.portraitPath} size={24} />
            <div className="min-w-0 flex-1">
              <span className="font-bold">{d.name}</span>
              <span className="ml-1 text-white/40">&quot;{d.nickname}&quot;</span>
              <div className="text-white/50">{t("management.speedEfficiency", { speed: Math.round(d.speedMultiplier * 100), efficiency: Math.round(d.efficiency * 100) })}</div>
            </div>
            <span className="shrink-0 font-bold text-amber-300">{t("management.free")}</span>
          </button>
        ))}
    </div>
  );
}

function ShiftAssignmentBoard({
  ownedBuses,
  assignments,
}: {
  ownedBuses: { id: string; name: string; color: string }[];
  assignments: Record<string, ShiftAssignments>;
}) {
  const t = useT();
  const driverShiftMinutes = useGameStore((s) => s.driverShiftMinutes);
  const driverMorale = useGameStore((s) => s.driverMorale);
  const activeContractFamilyId = useGameStore((s) => s.activeContracts[0]?.familyId ?? null);
  const buses = [{ id: MAIN_BUS_ID, name: "Benim Dolmuşum", color: "#f59e0b" }, ...ownedBuses];

  function isDriverAssigned(driverId: string) {
    return Object.values(assignments).some((shiftMap) =>
      Object.values(shiftMap).some((assignedDriverId) => assignedDriverId === driverId)
    );
  }

  return (
    <div className="rounded-lg bg-sky-500/10 p-3">
      <div className="mb-2">
        <div className="ff-section-title">{t("management.shiftAssignments")}</div>
        <div className="text-[11px] text-white/45">
          {t("management.shiftHint")}
        </div>
      </div>
      <div className="space-y-3">
        {buses.map((bus) => (
          <div key={bus.id} className="rounded-lg bg-black/20 p-2">
            <div className="mb-2 flex items-center gap-2 text-xs font-black">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: bus.color }} />
              {bus.name}
              <span className="ml-auto text-[10px] text-emerald-300">
                {t("management.dailyGross", { amount: getBusDailyGross(bus.id).toLocaleString("tr-TR") })}
              </span>
            </div>
            <div className="space-y-1.5">
              {SHIFT_SLOTS.map((slot) => {
                const driverId = assignments[bus.id]?.[slot.id] ?? null;
                const driver = ECONOMY.drivers.find((d) => d.id === driverId);
                const availableDrivers = ECONOMY.drivers.filter((d) => d.id === driverId || !isDriverAssigned(d.id));
                const estimate = driver
                  ? estimateAssignment(driver, {
                      shiftId: slot.id,
                      contractFamilyId: activeContractFamilyId,
                      fatigueMinutesAfterShift: (driverShiftMinutes[driver.id] ?? 0) + Math.abs(slot.endHour - slot.startHour) * 60,
                      morale: driverMorale[driver.id] ?? ECONOMY.driverMorale.initial,
                    })
                  : null;
                return (
                  <div key={slot.id} className="grid grid-cols-[74px_1fr_auto] items-center gap-2 text-xs">
                    <div>
                      <div className="font-bold text-white/80">{slot.label}</div>
                      <div className="text-[10px] text-white/35">
                        {formatHour(slot.startHour)}-{formatHour(slot.endHour)}
                      </div>
                    </div>
                    <div>
                      <select
                        value={driverId ?? ""}
                        onChange={(event) => {
                          const nextDriverId = event.target.value;
                          if (nextDriverId) dispatchGameAction("assignDriverShift", bus.id, slot.id, nextDriverId);
                          else dispatchGameAction("unassignDriverShift", bus.id, slot.id);
                        }}
                        className="h-8 w-full min-w-0 rounded-md border border-white/10 bg-slate-900 px-2 text-xs text-white"
                      >
                        <option value="">{t("management.empty")}</option>
                        {availableDrivers.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} - net ~₺{estimateShiftNet(bus.id, slot.id, d.id).toFixed(0)}
                          </option>
                        ))}
                      </select>
                      {estimate && (
                        <div className="mt-0.5 text-[10px] text-white/50">
                          {t("management.estimatedGrade", { grade: estimate.grade })} ·{" "}
                          {t("management.estimatedRisk")} <RiskBadge risk={estimate.risk} />
                          {estimate.matchedTag === "strong" && <span className="ml-1 text-emerald-300">✓ {t("management.strongMatch")}</span>}
                          {estimate.matchedTag === "weak" && <span className="ml-1 text-red-300">⚠ {t("management.weakMatch")}</span>}
                        </div>
                      )}
                    </div>
                    <div className={`text-right text-[10px] ${slot.legal ? "text-white/45" : "text-red-300"}`}>
                      {driver ? t("management.dailySalary", { amount: getDriverDailySalary(driver) }) : slot.legal ? t("management.legal") : t("management.hidden")}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DriverRow({
  driver,
  shiftMinutes,
  maxShift,
  locationLabel,
}: {
  driver: { name: string; nickname: string; speedMultiplier: number; efficiency: number; salaryShare: number; portraitPath: string };
  shiftMinutes: number;
  maxShift: number;
  locationLabel: string;
}) {
  if (!driver) return null;
  const isTired = shiftMinutes >= maxShift;
  const shiftH = Math.floor(shiftMinutes / 60);
  const shiftM = Math.floor(shiftMinutes % 60);
  return (
    <div className="flex items-center gap-2 text-sm">
      <DriverPortrait portraitPath={driver.portraitPath} size={32} />
      <div className="min-w-0 flex-1">
        <div className="font-bold">{driver.name} <span className="text-white/40 text-xs">&quot;{driver.nickname}&quot;</span></div>
        <div className="text-xs text-white/50">
          {locationLabel} · Hız {Math.round(driver.speedMultiplier * 100)}% · Verim {Math.round(driver.efficiency * 100)}%
        </div>
        <div className={`text-[10px] ${isTired ? "text-red-300 font-bold" : "text-white/30"}`}>
          {isTired && "⚠️ "}Vardiya {shiftH}s {shiftM}d / {maxShift / 60}s
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// YÜKSELTMELERi SEKMESİ
// ─────────────────────────────────────────────────────────────────────────────
function UpgradesTab() {
  const t = useT();
  const money = useGameStore((s) => s.money);
  const upgrades = useGameStore((s) => s.upgrades);
  const activeBusId = useGameStore((s) => s.activeBusId);
  const activeBusName = BUS_CATALOG.find((bus) => bus.id === activeBusId)?.name ?? activeBusId;

  const motorCost = ECONOMY.upgrades.motorCosts[upgrades.motorLevel];
  const seatCost = ECONOMY.upgrades.seatCosts[upgrades.seatLevel];
  const soundCost = ECONOMY.upgrades.soundCosts[upgrades.soundLevel];
  const currentCapacity = ECONOMY.upgrades.seatCapacityLevels[upgrades.seatLevel];
  const nextCapacity = ECONOMY.upgrades.seatCapacityLevels[upgrades.seatLevel + 1];

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-ff-ink/10 bg-white/45 px-3 py-2">
        <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-ff-muted">{t("management.upgradingVehicle")}</div>
        <div className="mt-0.5 text-sm font-bold text-ff-ink">{activeBusName}</div>
      </div>
      <UpgradeCard
        icon="🔧"
        label={t("management.motor")}
        description={`+${Math.round(ECONOMY.upgrades.motorSpeedBonusPerLevel * 100)}% hız her seviyede`}
        level={upgrades.motorLevel}
        maxLevel={ECONOMY.upgrades.motorCosts.length}
        cost={motorCost}
        money={money}
        effect={`Mevcut: ×${(1 + ECONOMY.upgrades.motorSpeedBonusPerLevel * upgrades.motorLevel).toFixed(2)} hız`}
        onBuy={() => dispatchGameAction("buyMotorUpgrade")}
      />
      <UpgradeCard
        icon="💺"
        label={t("management.seat")}
        description="Daha fazla yolcu = daha fazla kazanç"
        level={upgrades.seatLevel}
        maxLevel={ECONOMY.upgrades.seatCosts.length}
        cost={seatCost}
        money={money}
        effect={nextCapacity
          ? `${currentCapacity} → ${nextCapacity} koltuk`
          : `Mevcut: ${currentCapacity} koltuk (MAX)`}
        onBuy={() => dispatchGameAction("buySeatUpgrade")}
      />
      <UpgradeCard
        icon="🔊"
        label={t("management.sound")}
        description="Yolcu memnuniyetini pasif artırır"
        level={upgrades.soundLevel}
        maxLevel={ECONOMY.upgrades.soundCosts.length}
        cost={soundCost}
        money={money}
        effect={`+${(ECONOMY.upgrades.soundSatisfactionPerSecondPerLevel * upgrades.soundLevel).toFixed(2)} memn/sn`}
        onBuy={() => dispatchGameAction("buySoundUpgrade")}
      />

      <div className="rounded-lg bg-white/5 p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 font-bold text-sm">
              <span>🧾</span>
              <span>{t("management.cashRegister")}</span>
              {upgrades.hasCashRegister && <span className="text-emerald-400 text-xs">✓ {t("management.purchased")}</span>}
            </div>
            <p className="text-xs text-white/50 mt-1">Para üstü meydan okumalarını otomatik geçer</p>
          </div>
          {!upgrades.hasCashRegister && (
            <button
              onClick={() => dispatchGameAction("buyCashRegister")}
              disabled={money < ECONOMY.upgrades.cashRegisterCost}
              className="ff-button ff-button-green shrink-0 min-h-8 px-3 text-xs"
            >
              ₺{ECONOMY.upgrades.cashRegisterCost.toLocaleString("tr-TR")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function UpgradeCard({
  icon,
  label,
  description,
  level,
  maxLevel,
  cost,
  money,
  effect,
  onBuy,
}: {
  icon: string;
  label: string;
  description: string;
  level: number;
  maxLevel: number;
  cost: number | undefined;
  money: number;
  effect: string;
  onBuy: () => void;
}) {
  const maxed = level >= maxLevel;
  return (
    <div className="rounded-lg bg-white/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-bold text-sm">
            <span>{icon}</span>
            <span>{label}</span>
            <span className="text-xs font-normal text-white/40">Lv{level}{maxed ? " (MAX)" : ""}</span>
          </div>
          <p className="text-xs text-white/50 mt-0.5">{description}</p>
          <p className="text-xs text-amber-300/80 mt-0.5">{effect}</p>
        </div>
        {maxed ? (
          <span className="text-xs text-white/30 shrink-0">MAX</span>
        ) : (
          <button
            onClick={onBuy}
            disabled={cost === undefined || money < cost}
            className="ff-button ff-button-green shrink-0 min-h-8 px-3 text-xs"
          >
            ₺{cost?.toLocaleString("tr-TR")}
          </button>
        )}
      </div>
      {/* Seviye çubuğu */}
      <div className="mt-2 flex gap-1">
        {Array.from({ length: maxLevel }, (_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full ${i < level ? "bg-amber-400" : "bg-white/10"}`}
          />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HATLAR SEKMESİ
// ─────────────────────────────────────────────────────────────────────────────
function RoutesTab() {
  const t = useT();
  const money = useGameStore((s) => s.money);
  const secondLine = useGameStore((s) => s.secondLine);
  const ownedBuses = useGameStore((s) => s.ownedBuses);
  const stopsWaiting = useGameStore((s) => s.stopsWaiting);
  const passengersOnBoard = useGameStore((s) => s.passengersOnBoard);
  const dailyEarnings = useGameStore((s) => s.dailyEarnings);

  return (
    <div className="space-y-3">
      <RoutePlanSummary />
      {/* Hat 1 — Ana hat */}
      <div className="rounded-lg bg-white/5 p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-bold text-sm flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shrink-0" />
            {t("management.mainRoute")}
          </div>
          <span className="text-xs text-emerald-400 font-bold">{t("management.active")}</span>
        </div>
        <div className="grid grid-cols-1 gap-2 text-xs min-[420px]:grid-cols-2">
          <StatMini label={t("management.onBoard")} value={String(passengersOnBoard)} />
          <StatMini label={t("management.earnedToday")} value={`₺${Math.round(dailyEarnings)}`} />
          {[0, 1, 2, 3].map((index) => <StatMini key={index} label={t("management.stopQueue", { index: index + 1 })} value={String(Math.floor(stopsWaiting[index] ?? 0))} />)}
        </div>
      </div>

      {/* Ek araç hatları */}
      {ownedBuses.map((bus, i) => (
        <div key={bus.id} className="rounded-lg bg-white/5 p-3">
          <div className="flex items-center justify-between mb-1">
            <div className="font-bold text-sm flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: bus.color }} />
              Hat {i + 2} — {bus.name}
            </div>
            <span className={`text-xs font-bold ${bus.driverAssignedId ? "text-emerald-400" : "text-white/30"}`}>
              {bus.driverAssignedId ? t("management.working") : t("management.noDriver")}
            </span>
          </div>
          {bus.driverAssignedId ? (
            <p className="text-xs text-white/50">
              ₺{ECONOMY.extraBuses.idleIncomePerSecond}/sn pasif gelir
              {" · Şoför: "}
              {ECONOMY.drivers.find((d) => d.id === bus.driverAssignedId)?.name}
            </p>
          ) : (
            <p className="text-xs text-white/30">{t("management.assignFromDrivers")}</p>
          )}
        </div>
      ))}

      {/* İkinci hat (sayısal/pasif) */}
      <div className="rounded-lg border border-dashed border-white/15 p-3">
        <div className="font-bold text-sm mb-1">{t("management.secondLine")}</div>
        {!secondLine.unlocked ? (
          <>
            <p className="text-xs text-white/50 mb-2">{t("management.secondLineDescription")}</p>
            <PaybackHint shifts={secondLinePaybackShifts()} />
            <button
              onClick={() => dispatchGameAction("unlockSecondLine")}
              disabled={money < ECONOMY.secondLine.openCost}
              className="ff-button ff-button-primary w-full text-xs"
            >
              {t("management.openRoute")} — ₺{ECONOMY.secondLine.openCost.toLocaleString()}
            </button>
          </>
        ) : !secondLine.hasDriver ? (
          <>
            <p className="text-xs text-white/50 mb-2">{t("management.routeReady")}</p>
            <button
              onClick={() => dispatchGameAction("hireSecondLineDriver")}
              disabled={money < ECONOMY.secondLine.driverHireCost}
              className="ff-button ff-button-primary w-full text-xs"
            >
              {t("management.hireDriver")} — ₺{ECONOMY.secondLine.driverHireCost.toLocaleString()}
            </button>
          </>
        ) : (
          <p className="rounded bg-emerald-500/15 px-2 py-1.5 text-xs font-bold text-emerald-300">
            ✅ Çalışıyor — ₺{ECONOMY.secondLine.idleIncomePerSecond}/sn pasif gelir
          </p>
        )}
      </div>
    </div>
  );
}

function RoutePlanSummary() {
  const t = useT();
  const activeRouteId = useGameStore((s) => s.activeRouteId);
  const unlockedRouteIds = useGameStore((s) => s.unlockedRouteIds);
  const money = useGameStore((s) => s.money);
  const activeRoute = getRouteDefinition(activeRouteId);
  const routeOverlayVisible = useUiStore((s) => s.routeOverlayVisible);
  const selectedRouteId = useUiStore((s) => s.selectedRouteId);
  const toggleRouteOverlay = useUiStore((s) => s.toggleRouteOverlay);
  const selectRouteOverlay = useUiStore((s) => s.selectRouteOverlay);

  return (
    <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-amber-200/80">
            {t("management.activeRoute")}
          </p>
          <div className="text-sm font-black text-amber-100">{activeRoute.name}</div>
        </div>
        <span className="rounded bg-black/20 px-2 py-1 text-xs font-bold text-amber-100">
          x{activeRoute.wealthMultiplier}
        </span>
      </div>
      <p className="mt-1 text-xs text-white/55">{activeRoute.note}</p>
      <div className="mt-2 flex items-center justify-between gap-2 rounded bg-black/15 px-2 py-1.5">
        <span className="text-[11px] font-bold text-white/65">{t("management.mapRoute")}</span>
        <button
          type="button"
          onClick={toggleRouteOverlay}
          className={`rounded px-2 py-1 text-[11px] font-black ${
            routeOverlayVisible ? "bg-cyan-400 text-slate-950" : "bg-white/10 text-white/55"
          }`}
        >
          {routeOverlayVisible ? t("management.open") : t("management.closed")}
        </button>
      </div>

      <div className="mt-3 space-y-2">
        {ROUTE_DEFINITIONS.map((route, index) => (
          <div
            key={route.id}
            className={`rounded px-2 py-2 ${
              selectedRouteId === route.id ? "bg-cyan-400/15 ring-1 ring-cyan-300/40" : "bg-black/15"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-bold text-white">
                Hat {index + 1} - {route.name}
              </div>
              <span className="text-[11px] font-bold text-white/60">
                TL {route.unlockCost.toLocaleString("tr-TR")}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] font-bold text-white/55">
              <span className="rounded bg-white/8 px-1.5 py-0.5">{t("management.stops", { count: getRouteGeometry(route.id).stopCount })}</span>
              <span className="rounded bg-white/8 px-1.5 py-0.5">{t("management.incomeMultiplier", { value: route.wealthMultiplier })}</span>
              <span className="rounded bg-white/8 px-1.5 py-0.5">{route.tier}</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-white/55">{routePathSummary(route.id)}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => selectRouteOverlay(route.id)}
                className="rounded bg-white/10 px-2 py-1 text-[11px] font-bold text-cyan-100 hover:bg-cyan-400/20"
              >
                {t("management.showOnMap")}
              </button>
              {activeRouteId === route.id ? (
                <span className="rounded bg-emerald-400/20 px-2 py-1 text-[11px] font-black text-emerald-200">
                  {t("management.activeRoute")}
                </span>
              ) : unlockedRouteIds.includes(route.id) ? (
                <button
                  type="button"
                  onClick={() => dispatchGameAction("setActiveRoute", route.id)}
                  className="rounded bg-emerald-400/20 px-2 py-1 text-[11px] font-black text-emerald-200 hover:bg-emerald-400/30"
                >
                  {t("management.switchRoute")}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={money < route.unlockCost}
                  onClick={() => dispatchGameAction("unlockRoute", route.id)}
                  className="rounded bg-amber-400/20 px-2 py-1 text-[11px] font-black text-amber-100 hover:bg-amber-400/30 disabled:opacity-40"
                >
                  {t("management.unlock")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function routePathSummary(routeId: string) {
  switch (routeId) {
    case "starter-center":
      return "Meydan kuzey ici serit -> dogu inis -> meydan guney serit -> bati cikis.";
    case "main-city":
      return "Merkez meydan -> dogu sokaklari -> guney aks -> bati mahalle -> kuzey donus.";
    case "premium-outer":
      return "Dogu hat -> kuzey baglanti -> dis ring -> bati donus -> guney merkez.";
    case "north-loop":
      return "Kuzey bloklar arasi kisa halka; sik durak, dusuk acilis bedeli.";
    default:
      return "Secili hat yolu haritada cyan serit ile gosterilir.";
  }
}

function StatMini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-white/5 px-2 py-1.5">
      <div className="text-[10px] text-white/40">{label}</div>
      <div className="font-bold text-white">{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ŞEHİR SEKMESİ — Link, denetim noktası, ziyaretçi kaydı
// ─────────────────────────────────────────────────────────────────────────────
function CityTab() {
  const t = useT();
  const money = useGameStore((s) => s.money);
  const username = useGameStore((s) => s.username);
  const hasCheckpoint = useGameStore((s) => s.hasCheckpoint);
  const terminalUpgrades = useGameStore((s) => s.terminalUpgrades);
  const terminalEffects = getTerminalEffects(terminalUpgrades);

  return (
    <div className="space-y-3">
      <section className="overflow-hidden rounded-xl border border-ff-ink/12 bg-white/45">
        <div className="border-b border-ff-ink/10 bg-ff-ink/[0.025] px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-ff-muted">
                {t("management.cityKicker")}
              </div>
              <div className="mt-0.5 text-base font-black text-ff-ink">{t("management.cityTerminal")}</div>
              <p className="mt-1 max-w-sm text-[11px] leading-4 text-ff-muted">
                {t("management.cityDescription")}
              </p>
            </div>
            <div className="shrink-0 rounded-lg border border-ff-ink/12 bg-white/55 px-2.5 py-1.5 text-right">
              <div className="ff-display text-lg leading-none text-ff-ink">
                {terminalUpgrades.length}/{TERMINAL_UPGRADES.length}
              </div>
              <div className="mt-1 text-[8px] font-black uppercase tracking-[0.15em] text-ff-muted">
                {t("management.facilities")}
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-1.5">
            <TerminalStat label={t("management.passiveIncome")} value={`₺${terminalEffects.incomePerSecond.toFixed(2)}/sn`} />
            <TerminalStat label={t("management.demand")} value={`+%${Math.round((terminalEffects.demandMultiplier - 1) * 100)}`} />
            <TerminalStat
              label={t("management.satisfaction")}
              value={`+${(terminalEffects.satisfactionPerSecond * 60).toFixed(2)}/dk`}
            />
          </div>
        </div>

        <div className="grid gap-1.5 p-2 sm:grid-cols-2">
          {TERMINAL_UPGRADES.map((upgrade) => {
            const owned = terminalUpgrades.includes(upgrade.id);
            const affordable = money >= upgrade.cost;
            return (
              <div
                key={upgrade.id}
                className={`relative overflow-hidden rounded-lg border p-2.5 ${
                  owned
                    ? "border-ff-ink/18 bg-ff-ink/[0.055]"
                    : "border-ff-ink/10 bg-white/35"
                }`}
              >
                <span
                  className="absolute inset-y-0 left-0 w-0.5"
                  style={{ backgroundColor: upgrade.accent }}
                />
                <div className="flex items-start gap-2 pl-1">
                  <span
                    className="grid h-8 min-w-8 place-items-center rounded-md px-1 text-[8px] font-black text-[#101820]"
                    style={{ backgroundColor: upgrade.accent }}
                  >
                    {upgrade.shortName}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-black text-white">{upgrade.name}</span>
                      {owned && (
                        <span className="text-[9px] font-black uppercase tracking-wide text-emerald-300">
                          {t("management.installed")}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[9px] leading-3.5 text-white/42">
                      {upgrade.description}
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[9px] font-bold text-white/48">
                        {upgrade.incomePerSecond > 0 && `₺${upgrade.incomePerSecond.toFixed(2)}/sn`}
                        {upgrade.incomePerSecond > 0 && upgrade.demandBonus > 0 && " · "}
                        {upgrade.demandBonus > 0 && `+%${Math.round(upgrade.demandBonus * 100)} talep`}
                      </span>
                      {!owned && (
                        <button
                          type="button"
                          onClick={() => dispatchGameAction("buyTerminalUpgrade", upgrade.id)}
                          disabled={!affordable}
                          className="ff-button ff-button-amber min-h-7 shrink-0 px-2.5 text-[10px]"
                        >
                          ₺{upgrade.cost.toLocaleString("tr-TR")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {username && (
        <div className="rounded-lg bg-white/6 px-3 py-2 text-sm">
          <div className="text-white/50 text-xs mb-0.5">{t("management.cityLink")}:</div>
          <div className="font-bold text-amber-300">/{username}</div>
          <p className="mt-1 text-xs text-white/50">
            {t("management.cityLinkHint")}
          </p>
        </div>
      )}

      <div className="rounded-lg bg-white/5 p-3">
        <div className="flex items-center justify-between mb-1">
          <div className="font-bold text-sm">🚧 {t("management.checkpoint")}</div>
          {hasCheckpoint
            ? <span className="text-emerald-400 text-xs font-bold">{t("management.installed")}</span>
            : (
              <button
                onClick={() => dispatchGameAction("buyCheckpoint")}
                disabled={money < ECONOMY.social.checkpointCost}
                className="ff-button ff-button-green min-h-7 px-3 text-xs"
              >
                ₺{ECONOMY.social.checkpointCost.toLocaleString("tr-TR")}
              </button>
            )}
        </div>
        <p className="text-xs text-white/50">
          {t("management.checkpointHint", { chance: Math.round(ECONOMY.social.checkpointCatchChance * 100) })}
        </p>
      </div>

      {username && <VisitorLog username={username} />}
    </div>
  );
}

function TerminalStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-ff-ink/10 bg-white/50 px-2 py-1.5">
      <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-ff-muted">{label}</div>
      <div className="mt-0.5 text-[11px] font-black text-ff-ink">{value}</div>
    </div>
  );
}

function VisitorLog({ username }: { username: string }) {
  const t = useT();
  const [events, setEvents] = useState<CityEvent[]>([]);
  const [busyRetaliate, setBusyRetaliate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCityEvents(username).then((evts) => {
      if (!cancelled) setEvents(evts);
    });
    return () => { cancelled = true; };
  }, [username]);

  async function retaliate(actorUsername: string) {
    setBusyRetaliate(actorUsername);
    try {
      const result = await raidCity(actorUsername, getPlayerId()!, username);
      // Backend anahtar doner; ToastHub `messageKey` + `params` ile cevirir.
      pushToast({
        tone: result.success ? "success" : "warning",
        messageKey: result.messageKey,
        params: { amount: result.amount.toFixed(2) },
      });
    } catch {
      pushToast({ tone: "danger", messageKey: "feedback.error" });
    } finally {
      setBusyRetaliate(null);
    }
  }

  if (events.length === 0) {
    return <p className="text-xs text-white/40">{t("management.noVisitors")}</p>;
  }

  return (
    <div className="max-h-40 space-y-1 overflow-y-auto ff-scroll pr-1">
      {events.map((e, i) => (
        <div key={i} className="flex items-center justify-between rounded-lg bg-white/6 px-2 py-1.5 text-xs">
          <span>
            {e.type === "tip" && `💸 ${e.actorUsername ?? "biri"} ₺${e.amount} bahşiş bıraktı`}
            {e.type === "raid" && `🏴‍☠️ ${e.actorUsername ?? "biri"} ₺${e.amount} çaldı`}
            {e.type === "raid-caught" && `🚧 ${e.actorUsername ?? "biri"} yakalandı, ₺${e.amount} ceza ödedi`}
          </span>
          {e.type === "raid" && e.actorUsername && (
            <button
              onClick={() => retaliate(e.actorUsername!)}
              disabled={busyRetaliate === e.actorUsername}
              className="ff-button ff-button-red ml-2 min-h-6 shrink-0 px-1.5 py-0.5 text-[10px]"
            >
              {t("management.retaliate")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Yardımcı bileşenler
// ─────────────────────────────────────────────────────────────────────────────
function DriverPortrait({ portraitPath, size = 28 }: { portraitPath: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-white/10"
        style={{ width: size, height: size, fontSize: size * 0.55 }}
      >
        🧑‍✈️
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={portraitPath}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full bg-white/10 object-cover"
      style={{ width: size, height: size }}
    />
  );
}
