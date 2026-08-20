"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { createCompany, fetchProgression, type CreateCompanyInput } from "./api";
import { IS_DEMO, readDemoBootstrap, writeDemoBootstrap } from "./demo";
import { getPlayerId } from "./playerId";
import { useProgressionStore } from "./progressionStore";
import { LocaleHydrator, t as translateStatic, useLocaleStore, useT } from "./i18n";

import { ECONOMY } from "./economy";
import { CompanyEmblem } from "./CompanyEmblem";
import { StarterBusShowroom } from "./StarterBusShowroom";

const EMBLEMS = ["route", "wheel", "city", "star"] as const;
const STRATEGIES = ["service", "operations", "growth"] as const;
const STARTER_BUSES = ["hurda-mavi", "hurda-sari", "hurda-yesil"] as const;
const COLORS = ["#153448", "#2f5d50", "#674747", "#504b68", "#d1a054", "#f4ead5"];
const TOTAL_STEPS = 4;

/**
 * Sirket kurulum sihirbazi. Giris ekraniyla AYNI kabuk: `.ff-auth-screen` bulanik
 * oyun zemini + `max-w-[390px]` `.ff-login-shell` kart. Adimlar tek sutun akar ki
 * dar kartta okunakli kalsin.
 */
export function CompanyGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);
  const bootstrap = useProgressionStore((state) => state.bootstrap);
  const loading = useProgressionStore((state) => state.loading);
  const error = useProgressionStore((state) => state.error);
  const setBootstrap = useProgressionStore((state) => state.setBootstrap);
  const setLoading = useProgressionStore((state) => state.setLoading);
  const setError = useProgressionStore((state) => state.setError);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<CreateCompanyInput>({
    name: "", emblemId: "route", primaryColor: "#153448", secondaryColor: "#f4ead5",
    strategy: "service", starterBusId: "hurda-mavi",
  });

  // DİKKAT: `t` (useT) locale degisince YENI kimlik alir. Bagimliliga eklenirse dil
  // degistirmek bu effect'i yeniden calistirir, `setLoading(true)` tum oyun agacini
  // (children) unmount eder ve gereksiz bir progression istegi atar. Hata mesaji icin
  // reaktif olmayan `translateStatic` kullanilir; effect yalnizca mount'ta calisir.
  useEffect(() => {
    const playerId = getPlayerId();
    if (!playerId) return;
    setLoading(true);
    // Demoda ilerleme sunucudan degil, bu tarayicinin kendi kaydindan gelir.
    if (IS_DEMO) {
      setBootstrap(readDemoBootstrap());
      return;
    }
    fetchProgression(playerId).then(setBootstrap).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : translateStatic("company.loadError"));
    });
  }, [setBootstrap, setError, setLoading]);

  const canContinue = useMemo(() => step !== 0 || form.name.trim().length >= 3, [form.name, step]);
  const submit = async () => {
    const playerId = getPlayerId();
    if (!playerId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (IS_DEMO) {
        const current = readDemoBootstrap();
        setBootstrap(
          writeDemoBootstrap({
            ...current,
            company: {
              id: "demo-company",
              name: form.name.trim(),
              emblemId: form.emblemId,
              primaryColor: form.primaryColor,
              secondaryColor: form.secondaryColor,
              strategy: form.strategy,
              starterBusId: form.starterBusId,
              reputation: 0,
              skills: {},
            },
          }),
        );
        return;
      }
      setBootstrap(await createCompany(playerId, { ...form, name: form.name.trim() }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translateStatic("company.createError"));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || (!bootstrap && !error)) {
    return (
      <main className="ff-auth-screen grid min-h-dvh w-dvw place-items-center p-3 font-sans sm:p-6">
        <LocaleHydrator />
        <div className="ff-login-shell w-full max-w-[390px] px-6 py-8 text-center">
          <div className="ff-display animate-pulse text-lg text-ff-ink">{t("company.loading")}</div>
        </div>
      </main>
    );
  }
  if (bootstrap?.company) return <>{children}</>;

  return (
    <main className="ff-auth-screen relative flex min-h-dvh w-dvw items-center justify-center overflow-y-auto p-3 font-sans ff-scroll sm:p-6">
      <LocaleHydrator />
      <div className="ff-login-shell my-auto w-full max-w-[390px]">
        <header className="ff-login-header flex items-center gap-3 px-5 py-5 sm:px-6">
          <span className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#071f2f]">
            <Image
              src="/brand/minibus-tycoon-logo.png"
              alt="Minibus Tycoon - All Aboard!"
              width={1456}
              height={816}
              priority
              className="h-full w-full object-cover"
            />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-black leading-tight tracking-[-0.035em]">MINIBUS TYCOON</h1>
            <p className="mt-1 text-[9px] font-black uppercase tracking-[0.18em] text-white/48">
              All Aboard!
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLocale(locale === "tr" ? "en" : "tr")}
            title={t("lang.title")}
            className="shrink-0 rounded-lg border border-white/25 px-2.5 py-1.5 text-[11px] font-black text-white/85 transition hover:bg-white/12"
          >
            {t("lang.switchTo")}
          </button>
        </header>

        <div className="px-5 py-5 sm:px-6 sm:py-6">
          <p className="text-sm font-bold leading-5 text-ff-muted">{t("company.subtitle")}</p>

          {/* Adim gostergesi */}
          <div className="mt-4 flex items-center gap-1.5">
            {Array.from({ length: TOTAL_STEPS }, (_, index) => (
              <span
                key={index}
                className={`h-1.5 rounded-full transition-all ${
                  index === step ? "w-8 bg-[#c98a1c]" : index < step ? "w-4 bg-ff-ink/45" : "w-4 bg-ff-ink/15"
                }`}
              />
            ))}
          </div>

          <p className="mt-4 text-[10px] font-black uppercase tracking-[0.18em] text-ff-muted">
            {t("company.step", { current: step + 1, total: TOTAL_STEPS })}
          </p>
          <h2 className="ff-display mt-1 text-xl leading-tight text-ff-ink">{t(`company.step${step}.title`)}</h2>

          <div className="mt-4">
            {step === 0 && (
              <div>
                <label className="text-[11px] font-black uppercase tracking-wider text-ff-muted">
                  {t("company.nameLabel")}
                </label>
                <input
                  autoFocus
                  maxLength={28}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder={t("company.namePlaceholder")}
                  className="ff-input mt-2 text-base font-bold"
                />
                <p className="mt-2.5 text-[11px] leading-4 font-semibold text-ff-muted">{t("company.nameHint")}</p>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                {/* Amblem artık isim listesi değil: her seçenek kendi şeklini gösterir,
                    ve seçilen renklerle canlı boyanır — seçimin karşılığı anında görünür. */}
                <div>
                  <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-ff-muted">
                    {t("company.emblem")}
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {EMBLEMS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={t(`company.emblem.${value}`)}
                        aria-pressed={form.emblemId === value}
                        onClick={() => setForm({ ...form, emblemId: value })}
                        className={`ff-emblem-option ${form.emblemId === value ? "is-selected" : ""}`}
                      >
                        <CompanyEmblem
                          emblemId={value}
                          primary={form.primaryColor}
                          secondary={form.secondaryColor}
                          className="h-11 w-11"
                        />
                        <span className="ff-emblem-option-name">{t(`company.emblem.${value}`)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-ff-muted">
                    {t("company.colors")}
                  </p>
                  <div className="grid grid-cols-6 gap-2">
                    {COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={color}
                        aria-pressed={form.primaryColor === color}
                        onClick={() => setForm({ ...form, primaryColor: color })}
                        className={`aspect-square rounded-lg border-[3px] transition ${
                          form.primaryColor === color ? "border-ff-ink" : "border-transparent"
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>

                  <p className="mb-2 mt-3 text-[11px] font-black uppercase tracking-wider text-ff-muted">
                    {t("company.secondaryColor")}
                  </p>
                  <div className="grid grid-cols-6 gap-2">
                    {COLORS.map((color) => (
                      <button
                        key={`secondary-${color}`}
                        type="button"
                        aria-label={color}
                        aria-pressed={form.secondaryColor === color}
                        onClick={() => setForm({ ...form, secondaryColor: color })}
                        className={`aspect-square rounded-lg border-[3px] transition ${
                          form.secondaryColor === color ? "border-ff-ink" : "border-transparent"
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>

                {/* Şirket rozeti: amblem + iki renk + ad bir arada — nihai görünüm. */}
                <div className="ff-company-badge" style={{ background: form.primaryColor }}>
                  <CompanyEmblem
                    emblemId={form.emblemId}
                    primary={form.primaryColor}
                    secondary={form.secondaryColor}
                    className="h-12 w-12 shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="ff-company-badge-name ff-display" style={{ color: form.secondaryColor }}>
                      {form.name || t("company.preview")}
                    </div>
                    <div className="ff-company-badge-sub" style={{ color: form.secondaryColor }}>
                      {t("company.badgeSub")}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              /* Her yaklaşımın sayısal etkisi rozet olarak ayrıca gösterilir —
                 oyuncu "ne kazanıyorum" sorusunun cevabını okumadan da görsün. */
              <div className="space-y-2">
                {STRATEGIES.map((value) => {
                  const effect = ECONOMY.progression.strategies[value];
                  const badge =
                    value === "service"
                      ? `+%${Math.round((effect.satisfactionGainMultiplier - 1) * 100)} ${t("company.effect.satisfaction")}`
                      : value === "operations"
                        ? `−%${Math.round((1 - effect.policeRiskMultiplier) * 100)} ${t("company.effect.risk")}`
                        : `+%${Math.round((effect.fleetIncomeMultiplier - 1) * 100)} ${t("company.effect.fleet")}`;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setForm({ ...form, strategy: value })}
                      data-active={form.strategy === value}
                      className="ff-day-option ff-strategy-option w-full px-3.5 py-3 text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <strong className="ff-display block text-sm">{t(`company.strategy.${value}`)}</strong>
                        <span className="ff-strategy-badge">{badge}</span>
                      </div>
                      <span className="mt-1 block text-[11px] leading-4 font-semibold">
                        {t(`company.strategy.${value}.desc`)}
                      </span>
                    </button>
                  );
                })}
                <p className="text-[11px] leading-4 text-ff-muted">{t("company.strategyNote")}</p>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-3">
                {/* Showroom: seçili minibüs döner tablada canlı 3B olarak sergilenir. */}
                <StarterBusShowroom busId={form.starterBusId} />
                <div className="grid grid-cols-3 gap-2">
                  {STARTER_BUSES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={form.starterBusId === value}
                      onClick={() => setForm({ ...form, starterBusId: value })}
                      className={`ff-showroom-tab ${form.starterBusId === value ? "is-selected" : ""}`}
                    >
                      {t(`company.bus.${value}`)}
                    </button>
                  ))}
                </div>
                <p className="ff-showroom-desc">{t(`company.bus.${form.starterBusId}.desc`)}</p>
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-4 rounded-xl border border-ff-ink/18 bg-ff-ink px-3 py-2 text-xs font-bold text-ff-paper">
              {error}
            </p>
          )}

          <div className="mt-5 grid grid-cols-2 gap-2.5 border-t border-ff-ink/10 pt-4">
            <button
              type="button"
              disabled={step === 0}
              onClick={() => setStep((value) => Math.max(0, value - 1))}
              className="ff-button w-full disabled:opacity-0"
            >
              {t("company.back")}
            </button>
            {step < TOTAL_STEPS - 1 ? (
              <button
                type="button"
                disabled={!canContinue}
                onClick={() => setStep((value) => value + 1)}
                className="ff-button ff-button-primary w-full"
              >
                {t("company.continue")}
              </button>
            ) : (
              <button
                type="button"
                disabled={submitting}
                onClick={submit}
                className="ff-button ff-button-primary w-full"
              >
                {submitting ? t("company.creating") : t("company.create")}
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

