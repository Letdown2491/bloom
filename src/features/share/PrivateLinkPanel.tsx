import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ShareCompletion, SharePayload } from "./ui/ShareComposer";
import { usePrivateLinks } from "../privateLinks/hooks/usePrivateLinks";
import { describeExpiration } from "../../shared/utils/format";

import { LinkIcon } from "../../shared/ui/icons";

type ExpirationOption = "never" | "24h" | "7d" | "30d" | "custom";

type ExpirationOptionPreset = Exclude<ExpirationOption, "never" | "custom">;

type PrivateLinksState = ReturnType<typeof usePrivateLinks>;

const EXPIRATION_PRESETS: Array<{ key: ExpirationOptionPreset; label: string; seconds: number }> = [
  { key: "24h", label: "24 hours", seconds: 24 * 60 * 60 },
  { key: "7d", label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { key: "30d", label: "30 days", seconds: 30 * 24 * 60 * 60 },
];

const formatDateTimeLocal = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
};

const MAX_CUSTOM_EXPIRATION_SECONDS = 365 * 24 * 60 * 60; // 1 year

const evaluateExpiration = (
  option: ExpirationOption,
  customValue: string
): { value: number | null; error: string | null } => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (option === "never") {
    return { value: null, error: null };
  }
  const preset = EXPIRATION_PRESETS.find(entry => entry.key === option);
  if (preset) {
    return { value: nowSeconds + preset.seconds, error: null };
  }
  if (!customValue) {
    return { value: null, error: "Select an expiration date and time." };
  }
  const ms = Date.parse(customValue);
  if (Number.isNaN(ms)) {
    return { value: null, error: "Invalid date or time." };
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds <= nowSeconds) {
    return { value: null, error: "Expiration must be in the future." };
  }
  if (seconds - nowSeconds > MAX_CUSTOM_EXPIRATION_SECONDS) {
    return { value: null, error: "Expiration can be at most 1 year from now." };
  }
  return { value: seconds, error: null };
};

type PrivateLinkPanelProps = {
  payload: SharePayload;
  onShareComplete?: (result: ShareCompletion) => void;
  className?: string;
  links?: PrivateLinksState;
  tone?: "light" | "dark";
};

export const PrivateLinkPanel: React.FC<PrivateLinkPanelProps> = ({ payload, onShareComplete, className, links, tone }) => {

  const fallbackLinks = usePrivateLinks({ enabled: !links });
  const { error, create, creating, serviceConfigured, serviceHost, generateAlias } = links ?? fallbackLinks;
  const resolvedTone = tone ?? (className && className.includes("bg-white") ? "light" : "dark");

  const initialAliasRef = useRef<string>();
  if (!initialAliasRef.current) {
    initialAliasRef.current = generateAlias(22);
  }
  const initialAlias = initialAliasRef.current!;

  const [alias, setAlias] = useState(initialAlias);
  const [displayAlias, setDisplayAlias] = useState(initialAlias);
  const [linkCreated, setLinkCreated] = useState(false);
  const [label, setLabel] = useState(() => payload.name ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [expirationOption, setExpirationOption] = useState<ExpirationOption>("never");
  const [customExpiration, setCustomExpiration] = useState(() =>
    formatDateTimeLocal(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
  );
  const [customExpirationError, setCustomExpirationError] = useState<string | null>(null);

  const resolvedTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local time", []);
  const expirationResult = useMemo(
    () => evaluateExpiration(expirationOption, customExpiration),
    [expirationOption, customExpiration]
  );
  const previewExpiresAt =
    expirationOption === "custom" && expirationResult.error ? null : expirationResult.value;
  const expirationSummary = describeExpiration(previewExpiresAt);

  useEffect(() => {
    setLabel(payload.name ?? "");
  }, [payload.name]);

  useEffect(() => {
    if (!localMessage) return;
    const timer = setTimeout(() => {
      setLocalMessage(null);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [localMessage]);

  useEffect(() => {
    if (expirationOption === "custom") {
      setCustomExpirationError(expirationResult.error);
    } else {
      setCustomExpirationError(null);
    }
  }, [expirationOption, expirationResult.error]);

  const shareUrl = `${serviceHost}/${displayAlias}`;

  const handleRandomize = () => {
    const nextAlias = generateAlias(22);
    setAlias(nextAlias);
    setDisplayAlias(nextAlias);
    setLinkCreated(false);
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    setLocalMessage(null);
    if (!serviceConfigured) {
      setLocalError("Private link service is not configured.");
      onShareComplete?.({ mode: "private-link", success: false, message: "Private link service unavailable." });
      return;
    }
    if (!payload.url) {
      setLocalError("Selected file does not have a Blossom URL.");
      onShareComplete?.({ mode: "private-link", success: false, message: "File does not have a Blossom URL." });
      return;
    }
    const trimmedAlias = alias.trim().toLowerCase();
    if (trimmedAlias.length < 6) {
      setLocalError("Alias should be at least 6 characters.");
      return;
    }
    const expirationCheck = evaluateExpiration(expirationOption, customExpiration);
    if (expirationCheck.error) {
      setCustomExpirationError(expirationCheck.error);
      return;
    }
    try {
      const record = await create({
        alias: trimmedAlias,
        url: payload.url,
        serverUrl: payload.serverUrl ?? null,
        sha256: payload.sha256 ?? null,
        displayName: label.trim() || null,
        expiresAt: expirationCheck.value ?? null,
      });
      const link = `${serviceHost}/${record.alias}`;
      const creationSummary = describeExpiration(expirationCheck.value ?? null);
      setLocalMessage(`Private link created successfully. ${creationSummary.summary}.`);
      setDisplayAlias(record.alias);
      setLinkCreated(true);
      const nextAlias = generateAlias(22);
      setAlias(nextAlias);
      onShareComplete?.({ mode: "private-link", success: true, message: "Private link ready", alias: record.alias, link });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create private link.";
      setLocalError(message);
      onShareComplete?.({ mode: "private-link", success: false, message });
    }
  };

  const busy = creating;

  const defaultContainerClass = "rounded-2xl border border-slate-800 bg-slate-950/70 p-5";
  const headingClass = resolvedTone === "light" ? "text-lg font-semibold text-slate-900" : "text-lg font-semibold text-slate-100";
  const descriptionClass = resolvedTone === "light" ? "text-sm text-slate-600" : "text-sm text-slate-400";
  const labelClass = resolvedTone === "light" ? "text-xs font-semibold uppercase tracking-wide text-slate-600" : "text-xs font-semibold uppercase tracking-wide text-slate-400";
  const inputClass = resolvedTone === "light"
    ? "rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
    : "rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
  const secondaryButtonClass = resolvedTone === "light"
    ? "rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
    : "rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-600 hover:text-white";
  const chipActiveClass = resolvedTone === "light"
    ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
    : "border-emerald-400 bg-emerald-500/10 text-emerald-200";
  const chipInactiveClass = resolvedTone === "light"
    ? "border-slate-300 text-slate-600 hover:border-slate-400 hover:text-slate-900"
    : "border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-100";
  const mutedTextClass = resolvedTone === "light" ? "text-xs text-slate-500" : "text-xs text-slate-500";
  const targetValueClass = resolvedTone === "light" ? "font-mono text-slate-700" : "font-mono text-slate-300";
  const errorBoxClass = resolvedTone === "light"
    ? "mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700"
    : "mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200";
  const successBoxClass = resolvedTone === "light"
    ? "mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700"
    : "mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200";
  const sectionClass = className ?? defaultContainerClass;
  const wrapperClass = className ? "flex h-full flex-col gap-6" : "flex h-full flex-col gap-6 overflow-y-auto pr-1";

  return (
    <div className={wrapperClass}>
      <section className={sectionClass}>
        <header className="mb-4 space-y-2">
          <h2 className={headingClass}>Create Private Link</h2>
          <p className={descriptionClass}>
            Generate a shareable link served via <span className="font-mono text-emerald-500">{serviceHost}</span>. Recipients only see this proxy link. Masking the link allows you to stop sharing the file without ever revealing the origin URL.
          </p>
        </header>
        <form className="space-y-4" onSubmit={handleCreate}>
          <div className="space-y-2">
            <label htmlFor="private-link-alias" className={labelClass}>
              Alias
            </label>
            <div className="flex gap-3">
              <input
                id="private-link-alias"
                value={alias}
                onChange={event => {
                  const nextAlias = event.target.value;
                  setAlias(nextAlias);
                  setDisplayAlias(nextAlias);
                  setLinkCreated(false);
                }}
                className={`flex-1 font-mono ${inputClass}`}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={handleRandomize}
                className={secondaryButtonClass}
                disabled={busy}
              >
                Randomize
              </button>
            </div>
            <p className={mutedTextClass}>
              {linkCreated ? "Your private link is" : "The final link will be"} <span className="font-mono text-emerald-300">{shareUrl}</span>.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="private-link-label" className={labelClass}>
              Optional label
            </label>
            <input
              id="private-link-label"
              value={label}
              onChange={event => setLabel(event.target.value)}
              placeholder="Name to help you remember this link"
              className={inputClass}
            />
          </div>

          <div className="space-y-2">
            <span className={labelClass}>Expiration</span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setExpirationOption("never")}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                  expirationOption === "never" ? chipActiveClass : chipInactiveClass
                }`}
              >
                Never
              </button>
              {EXPIRATION_PRESETS.map(preset => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => setExpirationOption(preset.key)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                    expirationOption === preset.key ? chipActiveClass : chipInactiveClass
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setExpirationOption("custom")}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                  expirationOption === "custom" ? chipActiveClass : chipInactiveClass
                }`}
              >
                Custom…
              </button>
            </div>
            {expirationOption === "custom" && (
              <div className="space-y-2">
                <input
                  type="datetime-local"
                  value={customExpiration}
                  onChange={event => setCustomExpiration(event.target.value)}
                  className={inputClass}
                />
                <p className={mutedTextClass}>Times shown in {resolvedTimeZone}.</p>
                {customExpirationError && (
                  <p className="text-xs text-red-300">{customExpirationError}</p>
                )}
              </div>
            )}
            {(!customExpirationError || expirationOption !== "custom") && (
              <p
                className={`text-xs ${
                  expirationSummary.isExpired
                    ? "text-red-300"
                    : expirationSummary.isExpiringSoon
                      ? "text-amber-300"
                      : "text-slate-500"
                }`}
              >
                {expirationSummary.summary}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className={mutedTextClass}>
              Target: <span className={targetValueClass}>{payload.name ?? payload.url}</span>
            </div>
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-600/60"
              disabled={
                busy ||
                !serviceConfigured ||
                (expirationOption === "custom" && Boolean(customExpirationError))
              }
            >
              <LinkIcon size={16} className="shrink-0" />
              <span>{creating ? "Publishing…" : "Create link"}</span>
            </button>
          </div>
        </form>
        {(localError || error) && (
          <div className={errorBoxClass}>
            {localError || (error ? error.message : "")}
          </div>
        )}
        {localMessage && (
          <div className={successBoxClass}>
            {localMessage}
          </div>
        )}
      </section>
    </div>
  );
};
