import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ShareCompletion, SharePayload } from "./ui/ShareComposer";
import { usePrivateLinks } from "../privateLinks/hooks/usePrivateLinks";
import { describeExpiration } from "../../shared/utils/format";

type ExpirationOption = "never" | "24h" | "7d" | "30d" | "custom";

type ExpirationOptionPreset = Exclude<ExpirationOption, "never" | "custom">;

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
};

export const PrivateLinkPanel: React.FC<PrivateLinkPanelProps> = ({ payload, onShareComplete }) => {
  const { error, create, creating, serviceConfigured, serviceHost, generateAlias } = usePrivateLinks({ enabled: true });

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

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pr-1">
      <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
        <header className="mb-4 space-y-1">
          <h2 className="text-lg font-semibold text-slate-100">Create private link</h2>
          <p className="text-sm text-slate-400">
            Generate a shareable link served via <span className="font-mono text-emerald-300">{serviceHost}</span>. The underlying Blossom URL stays hidden.
          </p>
        </header>
        {!serviceConfigured && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            Configure <code className="font-mono text-xs text-amber-100">VITE_PRIVATE_LINK_SERVICE_PUBKEY</code> to enable private links.
          </div>
        )}
        <form className="space-y-4" onSubmit={handleCreate}>
          <div className="space-y-2">
            <label htmlFor="private-link-alias" className="text-xs font-semibold uppercase tracking-wide text-slate-400">
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
                className="flex-1 rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 font-mono text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={handleRandomize}
                className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-600 hover:text-white"
                disabled={busy}
              >
                Randomize
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {linkCreated ? "You private link is" : "The final link will be"} <span className="font-mono text-emerald-300">{shareUrl}</span>.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="private-link-label" className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Optional label
            </label>
            <input
              id="private-link-label"
              value={label}
              onChange={event => setLabel(event.target.value)}
              placeholder="Name to help you remember this link"
              className="w-full rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          <div className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Expiration</span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setExpirationOption("never")}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                  expirationOption === "never"
                    ? "border-emerald-400 bg-emerald-500/10 text-emerald-200"
                    : "border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-100"
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
                    expirationOption === preset.key
                      ? "border-emerald-400 bg-emerald-500/10 text-emerald-200"
                      : "border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-100"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setExpirationOption("custom")}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                  expirationOption === "custom"
                    ? "border-emerald-400 bg-emerald-500/10 text-emerald-200"
                    : "border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-100"
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
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
                <p className="text-xs text-slate-500">Times shown in {resolvedTimeZone}.</p>
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
            <div className="text-xs text-slate-500">
              Target: <span className="font-mono text-slate-300">{payload.name ?? payload.url}</span>
            </div>
            <button
              type="submit"
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-600/60"
              disabled={
                busy ||
                !serviceConfigured ||
                (expirationOption === "custom" && Boolean(customExpirationError))
              }
            >
              {creating ? "Publishing…" : "Create link"}
            </button>
          </div>
        </form>
        {(localError || error) && (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {localError || (error ? error.message : "")}
          </div>
        )}
        {localMessage && (
          <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            {localMessage}
          </div>
        )}
      </section>
    </div>
  );
};
