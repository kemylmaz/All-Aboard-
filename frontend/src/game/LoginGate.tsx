"use client";

import Image from "next/image";
import { useState } from "react";
import { login } from "./api";
import { getAuthToken, getPlayerId, setAuthToken, setPlayerId } from "./playerId";
import { setCachedUsername } from "./username";
import { markTutorialRequired } from "./tutorialStore";
import { LocaleHydrator, useLocaleStore, useT } from "./i18n";
import { IS_DEMO, seedDemoSession } from "./demo";

export function LoginGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);
  // Demoda hesap yok: oturum yerelde açılır ve giriş ekranı hiç görünmez.
  const [loggedIn, setLoggedIn] = useState(() => {
    if (IS_DEMO) {
      seedDemoSession();
      return true;
    }
    return getPlayerId() !== null && getAuthToken() !== null;
  });
  const [username, setUsernameInput] = useState("");
  const [password, setPasswordInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loggedIn) return <>{children}</>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (username.trim().length < 3 || password.length < 4) {
      setError(t("auth.validation"));
      return;
    }

    setBusy(true);
    setError(null);
    const response = await login(username.trim(), password);
    setBusy(false);

    if (!response.ok) {
      setError(t(response.messageKey));
      return;
    }

    setPlayerId(response.result.playerId);
    setAuthToken(response.result.authToken);
    setCachedUsername(response.result.username);
    if (response.result.isNewAccount) markTutorialRequired(response.result.playerId);
    setLoggedIn(true);
  }

  return (
    <main className="ff-auth-screen relative flex min-h-dvh w-dvw items-center justify-center overflow-y-auto p-3 font-sans ff-scroll sm:p-6">
      <LocaleHydrator />
      <form onSubmit={submit} className="ff-login-shell my-auto w-full max-w-[390px]">
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
          <p className="text-sm font-bold leading-5 text-ff-muted">{t("auth.tagline")}</p>

          <div className="mt-4 rounded-[var(--ff-radius-md)] border border-ff-ink/20 bg-ff-paper-strong px-4 py-3 text-center">
            <strong className="block text-sm font-black text-ff-ink">{t("auth.welcomeTitle")}</strong>
            <span className="mt-1 block text-[11px] font-bold text-ff-muted">
              {t("auth.welcomeSubtitle")}
            </span>
          </div>

          <div className="ff-login-divider my-5">{t("auth.divider")}</div>

          <label className="block">
            <span className="sr-only">{t("auth.usernameLabel")}</span>
            <input
              value={username}
              onChange={(event) => setUsernameInput(event.target.value)}
              placeholder={t("auth.usernamePlaceholder")}
              autoComplete="username"
              className="ff-input text-sm font-bold"
            />
          </label>

          <label className="mt-2.5 block">
            <span className="sr-only">{t("auth.passwordLabel")}</span>
            <input
              value={password}
              onChange={(event) => setPasswordInput(event.target.value)}
              placeholder={t("auth.passwordPlaceholder")}
              type="password"
              autoComplete="current-password"
              className="ff-input text-sm font-bold"
            />
          </label>

          {error && (
            <p role="alert" className="mt-3 rounded-xl border border-ff-ink/18 bg-ff-ink px-3 py-2 text-xs font-bold text-ff-paper">
              {error}
            </p>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <button type="submit" disabled={busy} className="ff-button ff-button-primary w-full">
              {busy ? t("auth.busy") : t("auth.login")}
            </button>
            <button type="submit" disabled={busy} className="ff-button w-full">
              {t("auth.register")}
            </button>
          </div>

          <p className="mt-5 text-center text-[10px] font-bold leading-4 text-ff-muted">
            {t("auth.hint")}
          </p>
        </div>
      </form>
    </main>
  );
}
