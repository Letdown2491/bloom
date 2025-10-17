import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CancelIcon, CopyIcon, RefreshIcon, SaveIcon } from "../../shared/ui/icons";
import { useNdk } from "../../app/context/NdkContext";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { isImageBlob } from "../../shared/utils/blobClassification";
import { getBlobMetadataName } from "../../shared/utils/blobMetadataStore";
import type { BlossomBlob } from "../../shared/api/blossomClient";
import { PRIVATE_SERVER_NAME } from "../../shared/constants/private";
import type { StatusMessageTone } from "../../shared/types/status";
import { loadNdkModule } from "../../shared/api/ndkModule";

export type ProfileMetadataPayload = {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
};

type ProfileFormState = {
  displayName: string;
  name: string;
  about: string;
  picture: string;
  banner: string;
  website: string;
  nip05: string;
  lud16: string;
};

type ImageOption = {
  sha: string;
  url: string;
  previewUrl: string;
  displayName: string;
  folderPath: string | null;
  serverNames: string[];
  searchText: string;
};

type ProfilePanelProps = {
  onProfileUpdated?: (metadata: ProfileMetadataPayload) => void;
  showStatusMessage?: (message: string, tone?: StatusMessageTone, duration?: number) => void;
};

const EMPTY_FORM: ProfileFormState = {
  displayName: "",
  name: "",
  about: "",
  picture: "",
  banner: "",
  website: "",
  nip05: "",
  lud16: "",
};

const FORM_KEYS = [
  "displayName",
  "name",
  "about",
  "picture",
  "banner",
  "nip05",
  "lud16",
  "website",
] as const;

type FieldKey = (typeof FORM_KEYS)[number];

const FIELD_CONFIG: Array<{
  key: FieldKey;
  label: string;
  placeholder?: string;
  type?: "text" | "textarea";
  fullWidth?: boolean;
}> = [
  {
    key: "displayName",
    label: "Display name",
    placeholder: "Jane Doe",
  },
  {
    key: "name",
    label: "Username",
    placeholder: "janedoe",
  },
  {
    key: "picture",
    label: "Avatar URL",
    placeholder: "https://example.com/avatar.png",
  },
  {
    key: "banner",
    label: "Banner URL",
    placeholder: "https://example.com/banner.jpg",
  },
  {
    key: "nip05",
    label: "NIP-05 identifier",
    placeholder: "name@example.com",
  },
  {
    key: "lud16",
    label: "Lightning address",
    placeholder: "name@lightning.example.com",
  },
  {
    key: "website",
    label: "Website",
    placeholder: "https://example.com",
  },
  {
    key: "about",
    label: "About",
    placeholder: "Tell people what you do…",
    type: "textarea",
    fullWidth: true,
  },
];

const toFormState = (metadata: ProfileMetadataPayload | null): ProfileFormState => ({
  displayName: typeof metadata?.display_name === "string" ? metadata.display_name : "",
  name: typeof metadata?.name === "string" ? metadata.name : "",
  about: typeof metadata?.about === "string" ? metadata.about : "",
  picture: typeof metadata?.picture === "string" ? metadata.picture : "",
  banner: typeof metadata?.banner === "string" ? metadata.banner : "",
  website: typeof metadata?.website === "string" ? metadata.website : "",
  nip05: typeof metadata?.nip05 === "string" ? metadata.nip05 : "",
  lud16: typeof metadata?.lud16 === "string" ? metadata.lud16 : "",
});

const trimFormValues = (form: ProfileFormState): ProfileFormState => ({
  displayName: form.displayName.trim(),
  name: form.name.trim(),
  about: form.about.trim(),
  picture: form.picture.trim(),
  banner: form.banner.trim(),
  website: form.website.trim(),
  nip05: form.nip05.trim(),
  lud16: form.lud16.trim(),
});

const normalizeForComparison = (form: ProfileFormState): Record<FieldKey, string> => {
  const trimmed = trimFormValues(form);
  const result = {} as Record<FieldKey, string>;
  for (const key of FORM_KEYS) {
    result[key] = trimmed[key];
  }
  return result;
};

const toMetadataPayload = (form: ProfileFormState): ProfileMetadataPayload => ({
  display_name: form.displayName.trim(),
  name: form.name.trim(),
  about: form.about.trim(),
  picture: form.picture.trim(),
  banner: form.banner.trim(),
  website: form.website.trim(),
  nip05: form.nip05.trim(),
  lud16: form.lud16.trim(),
});

const parseMetadataContent = (content: string | undefined): ProfileMetadataPayload | null => {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ProfileMetadataPayload;
  } catch (_error) {
    return null;
  }
};

const buildBlobUrl = (blob: BlossomBlob): string | null => {
  if (blob.url) return blob.url;
  if (blob.serverUrl) {
    return `${blob.serverUrl.replace(/\/$/, "")}/${blob.sha256}`;
  }
  return null;
};

const chooseDisplayName = (blob: BlossomBlob): string => {
  const metadataName = getBlobMetadataName(blob);
  if (metadataName) return metadataName;
  return blob.sha256;
};

const toImageOption = (
  blob: BlossomBlob,
  serverNames: string[]
): ImageOption | null => {
  const previewUrl = buildBlobUrl(blob);
  if (!previewUrl) return null;
  const displayName = chooseDisplayName(blob);
  const folderPath = blob.folderPath ?? null;
  const searchParts = [displayName, folderPath ?? "", ...serverNames, blob.sha256, previewUrl];
  const searchText = searchParts
    .map(part => part.toLowerCase())
    .join(" ");
  return {
    sha: blob.sha256,
    url: previewUrl,
    previewUrl,
    displayName,
    folderPath,
    serverNames,
    searchText,
  };
};

export const ProfilePanel: React.FC<ProfilePanelProps> = ({ onProfileUpdated, showStatusMessage }) => {
  const { ndk, signer, user, connect, ensureConnection } = useNdk();
  const activeSigner = ndk?.signer ?? signer ?? null;
  const { aggregated, distribution, serverNameByUrl } = useWorkspace();

  const [form, setForm] = useState<ProfileFormState>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<ProfileFormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const imageOptions = useMemo(() => {
    const blobs = aggregated?.blobs ?? [];
    const map = new Map<string, ImageOption>();

    const normalizeServerName = (url: string) => {
      const name = serverNameByUrl.get(url);
      if (name) return name;
      return url.replace(/^https?:\/\//i, "");
    };

    blobs.forEach(blob => {
      if (!blob || typeof blob.sha256 !== "string") return;
      if (blob.privateData) return;
      if (blob.label === PRIVATE_SERVER_NAME) return;
      if (blob.__bloomFolderPlaceholder) return;
      if (!isImageBlob(blob)) return;

      const servers = distribution?.[blob.sha256]?.servers ?? (blob.serverUrl ? [blob.serverUrl] : []);
      const serverNames = servers.map(normalizeServerName);
      const option = toImageOption(blob, serverNames);
      if (!option) return;

      const existing = map.get(blob.sha256);
      if (!existing) {
        map.set(blob.sha256, option);
        return;
      }

      const existingGeneric = existing.displayName.startsWith(existing.sha.slice(0, 6));
      const candidateGeneric = option.displayName.startsWith(option.sha.slice(0, 6));

      if (existingGeneric && !candidateGeneric) {
        map.set(blob.sha256, option);
        return;
      }

      if (!existing.previewUrl && option.previewUrl) {
        map.set(blob.sha256, option);
      }
    });

    const sorted = Array.from(map.values());
    sorted.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
    return sorted;
  }, [aggregated, distribution, serverNameByUrl]);

  const notify = useCallback(
    (message: string, tone: StatusMessageTone = "info", duration = 5000) => {
      if (showStatusMessage) {
        showStatusMessage(message, tone, duration);
      } else if (tone === "error") {
        console.error(message);
      } else {
        console.info(message);
      }
    },
    [showStatusMessage]
  );

  const hasChanges = useMemo(() => {
    const current = normalizeForComparison(form);
    const original = normalizeForComparison(baseline);
    return FORM_KEYS.some(key => current[key] !== original[key]);
  }, [form, baseline]);

  const loadProfile = useCallback(
    async (state?: { cancelled: boolean }) => {
      if (!ndk || !user?.pubkey) {
        if (state?.cancelled) return;
        setBaseline(EMPTY_FORM);
        setForm(EMPTY_FORM);
        setLoading(false);
        notify("Connect your Nostr signer to load and edit your profile.");
        return;
      }

      if (state?.cancelled) return;
      setLoading(true);

      try {
        await ensureConnection().catch(() => undefined);
        const evt = await ndk.fetchEvent({ kinds: [0], authors: [user.pubkey] });
        if (state?.cancelled) return;
        const metadata = parseMetadataContent(evt?.content);
        const nextForm = trimFormValues(toFormState(metadata));
        setBaseline(nextForm);
        setForm(nextForm);
      } catch (error) {
        if (state?.cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load profile metadata.";
        notify(message, "error");
      } finally {
        if (!state?.cancelled) {
          setLoading(false);
        }
      }
    },
    [ensureConnection, ndk, notify, user?.pubkey]
  );

  useEffect(() => {
    const state = { cancelled: false };
    void loadProfile(state);
    return () => {
      state.cancelled = true;
    };
  }, [loadProfile]);

  const handleChange = useCallback((key: FieldKey, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleReset = useCallback(() => {
    setForm(baseline);
  }, [baseline]);

  const handleConnectSigner = useCallback(async () => {
    try {
      await connect();
      await loadProfile();
      notify("Signer connected. Ready to edit your profile.", "success", 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect signer.";
      notify(message, "error");
    }
  }, [connect, loadProfile, notify]);

  const handleRefresh = useCallback(async () => {
    await loadProfile();
  }, [loadProfile]);

  const handleCopyNpub = useCallback(async () => {
    const npub = user?.npub?.trim();
    if (!npub) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      notify("Clipboard not available.", "error", 2500);
      return;
    }
    try {
      await navigator.clipboard.writeText(npub);
      notify("npub copied to clipboard.", "success", 2000);
    } catch (_error) {
      notify("Failed to copy npub.", "error");
    }
  }, [notify, user?.npub]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!ndk || !user?.pubkey) {
        notify("Connect your Nostr signer before publishing.", "error");
        return;
      }
      if (!activeSigner) {
        notify("A signer is required to publish profile updates.", "error");
        return;
      }
      if (!hasChanges) {
        notify("No changes to publish.", "info", 2500);
        return;
      }

      setSaving(true);

      try {
        const trimmedForm = trimFormValues(form);
        const payload = toMetadataPayload(trimmedForm);
        const { NDKEvent } = await loadNdkModule();
        const event = new NDKEvent(ndk, {
          kind: 0,
          content: JSON.stringify(payload),
          tags: [],
          pubkey: user.pubkey,
        });
        if (!event.created_at) {
          event.created_at = Math.floor(Date.now() / 1000);
        }
        await event.sign();
        await event.publish();

        setBaseline(trimmedForm);
        setForm(trimmedForm);
        notify("Profile updated.", "success");
        onProfileUpdated?.(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to publish profile.";
        notify(message, "error");
      } finally {
        setSaving(false);
      }
    },
    [activeSigner, form, hasChanges, ndk, notify, onProfileUpdated, user?.pubkey]
  );

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow">
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">Loading profile…</div>
      ) : !ndk || !user?.pubkey ? (
        <div className="flex flex-1 flex-col justify-center gap-3 text-sm text-slate-300">
          <p>Bloom could not detect an active Nostr session.</p>
          <button
            type="button"
            onClick={handleConnectSigner}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/50 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:border-emerald-400 hover:text-emerald-100 focus:outline-none focus:ring-1 focus:ring-emerald-400"
          >
            Connect signer
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-1 min-h-0 flex-col gap-6">
          <div className="flex-1 min-h-0 space-y-4 overflow-y-auto pr-1">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-100">Edit Nostr Profile</h3>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {FIELD_CONFIG.map(field => {
                const value = form[field.key];
                const inputId = `profile-${field.key}`;
                const isTextarea = field.type === "textarea";
                const isImageField = field.key === "picture" || field.key === "banner";
                const isWebsiteField = field.key === "website";
                const containerClassName = field.fullWidth
                  ? "flex flex-col gap-2 md:col-span-2"
                  : "flex flex-col gap-2";

                if (isWebsiteField) {
                  const websiteField = (
                    <div key={field.key} className={containerClassName}>
                      <label htmlFor={inputId} className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                        {field.label}
                      </label>
                      <input
                        id={inputId}
                        type="text"
                        value={value}
                        onChange={event => handleChange(field.key, event.target.value)}
                        placeholder={field.placeholder}
                        className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </div>
                  );

                  if (user?.npub) {
                    const npubField = (
                      <div key="npub" className="flex flex-col gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">NPUB (Public Key)</span>
                        <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-slate-200">{user.npub}</span>
                          <button
                            type="button"
                            onClick={handleCopyNpub}
                            className="rounded-md p-1 text-slate-300 transition hover:text-emerald-300"
                            aria-label="Copy npub to clipboard"
                            title="Copy npub"
                          >
                            <CopyIcon size={16} />
                          </button>
                        </div>
                      </div>
                    );

                    return [websiteField, npubField];
                  }

                  return websiteField;
                }

                return (
                  <div key={field.key} className={containerClassName}>
                    {isTextarea ? (
                      <>
                        <label htmlFor={inputId} className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                          {field.label}
                        </label>
                        <textarea
                          id={inputId}
                          value={value}
                          onChange={event => handleChange(field.key, event.target.value)}
                          placeholder={field.placeholder}
                          className="min-h-[120px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        />
                      </>
                    ) : isImageField ? (
                      <>
                        <label htmlFor={inputId} className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                          {field.label}
                        </label>
                        <ImagePickerInput
                          id={inputId}
                          value={value}
                          placeholder={field.placeholder}
                          onChange={next => handleChange(field.key, next)}
                          options={imageOptions}
                        />
                      </>
                    ) : (
                      <>
                        <label htmlFor={inputId} className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                          {field.label}
                        </label>
                        <input
                          id={inputId}
                          type="text"
                          value={value}
                          onChange={event => handleChange(field.key, event.target.value)}
                          placeholder={field.placeholder}
                          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          spellCheck={field.key === "name" ? false : undefined}
                          autoComplete="off"
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-shrink-0 flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving || !hasChanges || !activeSigner}
              className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition ${
                saving
                  ? "border-slate-700 bg-slate-800/70 text-slate-500"
                  : !hasChanges || !activeSigner
                    ? "border-slate-700 text-slate-500"
                    : "border-emerald-500/60 bg-emerald-500/10 text-emerald-200 hover:border-emerald-400 hover:text-emerald-100"
              }`}
            >
              <SaveIcon size={18} />
              {saving ? "Publishing…" : "Save changes"}
            </button>

            <button
              type="button"
              onClick={handleReset}
              disabled={saving || !hasChanges}
              className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition ${
                saving || !hasChanges
                  ? "border-slate-700 text-slate-500"
                  : "border-slate-600 text-slate-300 hover:border-slate-500 hover:text-slate-200"
              }`}
            >
              <CancelIcon size={16} />
              Reset
            </button>

            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading || saving}
              className={`hidden sm:inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition ${
                loading || saving
                  ? "border-slate-700 text-slate-500"
                  : "border-slate-500 text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
              }`}
            >
              <RefreshIcon size={16} />
              Refresh Data
            </button>

            {!activeSigner && (
              <button
                type="button"
                onClick={handleConnectSigner}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/50 px-4 py-2 text-sm font-medium text-emerald-200 transition hover:border-emerald-400 hover:text-emerald-100 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              >
                Connect signer
              </button>
            )}
          </div>
          <p className="text-xs text-slate-400">
            If you'd like to back up your Nostr profile, head on over to{" "}
            <a
              href="https://metadata.nostr.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-300 transition hover:text-emerald-200"
            >
              Nostr Profile Manager
            </a>{" "}
            to create a back up.
          </p>
        </form>
      )}
    </div>
  );
};

type ImagePickerInputProps = {
  id: string;
  value: string;
  placeholder?: string;
  options: ImageOption[];
  onChange: (value: string) => void;
};

const ImagePickerInput: React.FC<ImagePickerInputProps> = ({ id, value, placeholder, options, onChange }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);

  const trimmedValue = value.trim();
  const query = trimmedValue.toLowerCase();

  const suggestions = useMemo(() => {
    if (!options.length) return [] as ImageOption[];
    if (!query) return options.slice(0, Math.min(8, options.length));

    const ranked = options
      .map(option => ({ option, index: option.searchText.indexOf(query) }))
      .filter(entry => entry.index >= 0)
      .sort((a, b) => {
        if (a.index !== b.index) return a.index - b.index;
        return a.option.displayName.localeCompare(b.option.displayName, undefined, { sensitivity: "base" });
      })
      .map(entry => entry.option);

    return ranked.slice(0, 8);
  }, [options, query]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [suggestions]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isOpen]);

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.value);
      setIsOpen(true);
    },
    [onChange]
  );

  const handleSelect = useCallback(
    (option: ImageOption) => {
      onChange(option.url);
      setIsOpen(false);
    },
    [onChange]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!isOpen || suggestions.length === 0) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex(index => (index + 1) % suggestions.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex(index => (index - 1 + suggestions.length) % suggestions.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const choice = suggestions[highlightIndex];
        if (choice) handleSelect(choice);
      } else if (event.key === "Escape") {
        setIsOpen(false);
      }
    },
    [handleSelect, highlightIndex, isOpen, suggestions]
  );

  const selectedOption = useMemo(() => options.find(option => option.url === trimmedValue) ?? null, [options, trimmedValue]);
  const previewSrc = selectedOption?.previewUrl || (trimmedValue.startsWith("http") ? trimmedValue : "");

  const showSuggestions = isOpen && suggestions.length > 0;

  return (
    <div ref={containerRef} className="relative flex items-stretch gap-3">
      <div
        className={`flex-none self-stretch w-16 overflow-hidden rounded-lg border ${
          previewSrc ? "border-slate-800 bg-slate-950" : "border-dashed border-slate-800/60 bg-slate-950/40"
        }`}
      >
        {previewSrc ? (
          <img src={previewSrc} alt="Selected preview" className="h-full w-full object-cover" loading="lazy" />
        ) : null}
      </div>
      <div className="relative flex-1">
        <input
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          onBlur={() => {
            if (!showSuggestions) setIsOpen(false);
          }}
          onKeyDown={handleKeyDown}
          className="h-16 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          autoComplete="off"
          spellCheck={false}
        />
        {showSuggestions && (
          <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-700/80 bg-slate-900/95 p-1 text-sm shadow-lg">
            {suggestions.map((option, index) => {
              const isActive = index === highlightIndex;
              return (
                <li key={`${option.sha}-${option.url}`}>
                  <button
                    type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => handleSelect(option)}
                    className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition ${
                      isActive ? "bg-emerald-500/15 text-emerald-100" : "text-slate-200 hover:bg-slate-800/80"
                    }`}
                  >
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-slate-800 bg-slate-950">
                      <img src={option.previewUrl} alt="Preview" className="h-full w-full object-cover" loading="lazy" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{option.displayName}</div>
                      <div className="truncate text-xs text-slate-400">
                        {[option.folderPath ?? "", option.serverNames.join(", ")]
                          .filter(Boolean)
                          .join(" • ") || option.url}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
