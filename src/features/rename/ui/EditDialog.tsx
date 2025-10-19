import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BlossomBlob } from "../../../shared/api/blossomClient";
import { useUserPreferences } from "../../../app/context/UserPreferencesContext";
import { prettyDate } from "../../../shared/utils/format";
import { CancelIcon, SaveIcon } from "../../../shared/ui/icons";

type FolderOption = {
  value: string | null;
  label: string;
};

const HOME_FOLDER_VALUE = "__edit_details_folder_home__";
const CUSTOM_FOLDER_VALUE = "__edit_details_folder_custom__";

export type EditDialogAudioFields = {
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  trackNumber: string;
  trackTotal: string;
  durationSeconds: string;
  genre: string;
  year: string;
};

export type EditDialogProps = {
  blob: BlossomBlob;
  alias: string;
  busy?: boolean;
  error?: string | null;
  isMusic: boolean;
  onAliasChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  audioFields?: EditDialogAudioFields;
  onAudioFieldChange?: (field: keyof EditDialogAudioFields, value: string) => void;
  folder: string;
  onFolderChange: (value: string) => void;
  folderInvalid?: boolean;
  folderOptions: FolderOption[];
  folderPlaceholder?: string;
  folderCustomDefaultPath?: string;
  privateLink?: {
    url?: string | null;
    alias?: string | null;
    expiresAt?: number | null;
  };
  onRevokePrivateLink?: () => void;
  revokingPrivateLink?: boolean;
  revokePrivateLinkError?: string | null;
  disablePrivateLinkRevoke?: boolean;
};

export const EditDialog: React.FC<EditDialogProps> = ({
  blob,
  alias,
  busy = false,
  error,
  isMusic,
  onAliasChange,
  onSubmit,
  onCancel,
  audioFields,
  onAudioFieldChange,
  folder,
  onFolderChange,
  folderInvalid = false,
  folderOptions,
  folderPlaceholder,
  folderCustomDefaultPath,
  privateLink,
  onRevokePrivateLink,
  revokingPrivateLink = false,
  revokePrivateLinkError,
  disablePrivateLinkRevoke = false,
}) => {
  const aliasInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";

  const overlayClass = isLightTheme
    ? "fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    : "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4";
  const dialogClass = isLightTheme
    ? "w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-xl"
    : "w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl";
  const headingClass = isLightTheme ? "text-lg font-semibold text-slate-900" : "text-lg font-semibold text-slate-100";
  const descriptionClass = isLightTheme ? "mt-2 text-sm text-slate-600" : "mt-2 text-sm text-slate-400";
  const labelClass = isLightTheme ? "block text-sm text-slate-700" : "block text-sm text-slate-300";
  const helperTextClass = isLightTheme ? "mt-2 text-xs text-red-500" : "mt-2 text-xs text-red-400";
  const infoTextClass = isLightTheme ? "text-sm text-slate-600" : "text-sm text-slate-400";
  const infoPanelClass = isLightTheme
    ? "rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
    : "rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-300";
  const infoPanelHeadingClass = isLightTheme ? "font-medium text-slate-900" : "font-medium text-slate-100";
  const infoPanelAliasClass = isLightTheme ? "mt-1 font-mono text-emerald-600" : "mt-1 font-mono text-emerald-300";
  const errorTextClass = isLightTheme ? "mt-2 text-sm text-red-500" : "mt-2 text-sm text-red-400";
  const cancelButtonClass = isLightTheme
    ? "rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-400"
    : "rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-600";
  const saveButtonClass = isLightTheme
    ? "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
    : "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-500 disabled:opacity-50";
  const shaHighlightClass = isLightTheme ? "font-mono text-emerald-600" : "font-mono text-emerald-300";
  const panelNoteClass = isLightTheme ? "mt-2 text-xs text-slate-500" : "mt-2 text-xs text-slate-400";

  const baseInputClass = isLightTheme
    ? "mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
    : "mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none";
  const invalidInputClass = isLightTheme
    ? "mt-2 w-full rounded-xl border border-red-400 bg-white px-3 py-2 text-slate-800 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-400"
    : "mt-2 w-full rounded-xl border border-red-500 bg-slate-950 px-3 py-2 text-slate-100 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500";
  const musicInputClass = baseInputClass;
  const privateLinkButtonClass = isLightTheme
    ? "inline-flex items-center gap-2 rounded-lg border border-red-400/70 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
    : "inline-flex items-center gap-2 rounded-lg border border-red-500/50 px-3 py-1.5 text-sm font-medium text-red-200 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500";
  const privateLinkExpirationText =
    privateLink && privateLink.expiresAt ? prettyDate(privateLink.expiresAt) || "No expiration" : "No expiration";

  type FolderSelectProps = {
    value: string;
    onChange: (value: string) => void;
    options: FolderOption[];
    invalid?: boolean;
    disabled?: boolean;
    placeholder?: string;
    customDefaultPath?: string;
    customOptionLabel?: string;
  };

  const FolderSelect: React.FC<FolderSelectProps> = ({
    value,
    onChange,
    options,
    invalid = false,
    disabled = false,
    placeholder = "e.g. Pictures/2024",
    customDefaultPath = "",
    customOptionLabel = "Custom folder…",
  }) => {
    const normalizedValue = value?.trim() ?? "";
    const normalizedOptions = useMemo(
      () =>
        options.map(option => ({
          id: option.value === null ? HOME_FOLDER_VALUE : option.value,
          label: option.label,
        })),
      [options]
    );

    const optionIds = useMemo(() => new Set(normalizedOptions.map(option => option.id)), [normalizedOptions]);

    const selectValue =
      normalizedValue === ""
        ? HOME_FOLDER_VALUE
        : optionIds.has(normalizedValue)
          ? normalizedValue
          : CUSTOM_FOLDER_VALUE;

    const [customValue, setCustomValue] = useState<string>(
      selectValue === CUSTOM_FOLDER_VALUE ? normalizedValue || customDefaultPath || "" : customDefaultPath || ""
    );

    useEffect(() => {
      if (selectValue === CUSTOM_FOLDER_VALUE) {
        setCustomValue(normalizedValue || customDefaultPath || "");
      }
    }, [customDefaultPath, normalizedValue, selectValue]);

    const selectClassName = invalid ? invalidInputClass : baseInputClass;
    const inputClassName = invalid ? invalidInputClass : baseInputClass;

    const handleSelectChange: React.ChangeEventHandler<HTMLSelectElement> = event => {
      const next = event.target.value;
      if (next === HOME_FOLDER_VALUE) {
        onChange("");
        return;
      }
      if (next === CUSTOM_FOLDER_VALUE) {
        const fallback =
          normalizedValue && !optionIds.has(normalizedValue)
            ? normalizedValue
            : customDefaultPath || normalizedValue || "";
        setCustomValue(fallback);
        onChange(fallback);
        return;
      }
      onChange(next);
    };

    const handleCustomChange: React.ChangeEventHandler<HTMLInputElement> = event => {
      const next = event.target.value;
      setCustomValue(next);
      onChange(next);
    };

    return (
      <div className="space-y-2">
        <select
          value={selectValue}
          onChange={handleSelectChange}
          disabled={disabled}
          className={selectClassName}
        >
          {normalizedOptions.map(option => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          <option value={CUSTOM_FOLDER_VALUE}>{customOptionLabel}</option>
        </select>
        {selectValue === CUSTOM_FOLDER_VALUE ? (
          <input
            type="text"
            value={customValue}
            onChange={handleCustomChange}
            disabled={disabled}
            placeholder={placeholder}
            className={inputClassName}
          />
        ) : null}
      </div>
    );
  };

  useEffect(() => {
    const target = isMusic ? titleInputRef.current : aliasInputRef.current;
    if (target) {
      target.focus();
      if (!isMusic) target.select();
    }
  }, [isMusic]);

  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  const renderMusicFields = () => {
    if (!isMusic) return null;
    const fields = audioFields ?? {
      title: "",
      artist: "",
      album: "",
      coverUrl: "",
      trackNumber: "",
      trackTotal: "",
      durationSeconds: "",
      genre: "",
      year: "",
    };

    const handleAudioChange = (field: keyof EditDialogAudioFields) => (event: React.ChangeEvent<HTMLInputElement>) => {
      onAudioFieldChange?.(field, event.target.value);
    };

    return (
      <div className="mt-4 space-y-4">
        <p className={infoTextClass}>
          Update the track metadata for <span className={shaHighlightClass}>{blob.sha256.slice(0, 12)}…</span>. Title is required.
        </p>
        <label className={labelClass}>
          Title
          <input
            ref={titleInputRef}
            type="text"
            value={fields.title}
            onChange={handleAudioChange("title")}
            disabled={busy}
            className={musicInputClass}
            placeholder="Track title"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>
            Artist
            <input
              type="text"
              value={fields.artist}
              onChange={handleAudioChange("artist")}
              disabled={busy}
              className={musicInputClass}
              placeholder="Primary artist"
            />
          </label>
          <div className={labelClass}>
            <span>File location</span>
            <FolderSelect
              value={folder}
              onChange={value => onFolderChange(value)}
              options={folderOptions}
              invalid={folderInvalid}
              disabled={busy}
              placeholder={folderPlaceholder}
              customDefaultPath={folderCustomDefaultPath}
            />
            {folderInvalid && (
              <p className={helperTextClass}>Folder names cannot include the word "private".</p>
            )}
          </div>
          <label className={labelClass}>
            Album
            <input
              type="text"
              value={fields.album}
              onChange={handleAudioChange("album")}
              disabled={busy}
              className={musicInputClass}
              placeholder="Album name"
            />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>
            Cover URL
            <input
              type="url"
              value={fields.coverUrl}
              onChange={handleAudioChange("coverUrl")}
              disabled={busy}
              className={musicInputClass}
              placeholder="https://example.com/cover.jpg"
              inputMode="url"
              pattern="https?://.*"
            />
          </label>
          <label className={labelClass}>
            Track number
            <input
              type="number"
              min={1}
              value={fields.trackNumber}
              onChange={handleAudioChange("trackNumber")}
              disabled={busy}
              className={musicInputClass}
              placeholder="e.g. 3"
            />
          </label>
          <label className={labelClass}>
            Total tracks
            <input
              type="number"
              min={1}
              value={fields.trackTotal}
              onChange={handleAudioChange("trackTotal")}
              disabled={busy}
              className={musicInputClass}
              placeholder="e.g. 10"
            />
          </label>
          <label className={labelClass}>
            Duration (seconds)
            <input
              type="number"
              min={1}
              value={fields.durationSeconds}
              onChange={handleAudioChange("durationSeconds")}
              disabled={busy}
              className={musicInputClass}
              placeholder="e.g. 215"
            />
          </label>
          <label className={labelClass}>
            Genre
            <input
              type="text"
              value={fields.genre}
              onChange={handleAudioChange("genre")}
              disabled={busy}
              className={musicInputClass}
              placeholder="e.g. Electronic"
            />
          </label>
          <label className={labelClass}>
            Year
            <input
              type="number"
              min={0}
              value={fields.year}
              onChange={handleAudioChange("year")}
              disabled={busy}
              className={musicInputClass}
              placeholder="e.g. 2024"
            />
          </label>
        </div>
        <div className={infoPanelClass}>
          <div className={infoPanelHeadingClass}>Display name</div>
          <div className={infoPanelAliasClass}>{alias}</div>
          <p className={panelNoteClass}>
            The display name is automatically derived as <span className="font-semibold">Artist – Title</span> when an artist is provided.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className={overlayClass} onKeyDown={handleKeyDown}>
      <div className={dialogClass}>
        <h2 className={headingClass}>Edit file details</h2>
        {!isMusic && (
          <p className={descriptionClass}>
            Provide a new display name for <span className={shaHighlightClass}>{blob.sha256.slice(0, 12)}…</span>. Leave the field empty to clear the
            alias.
          </p>
        )}

        {isMusic ? (
          renderMusicFields()
        ) : (
          <label className={`${labelClass} mt-4`}>
            Display name
            <input
              ref={aliasInputRef}
              type="text"
              value={alias}
              onChange={event => onAliasChange(event.target.value)}
              disabled={busy}
              className={baseInputClass}
              placeholder="Enter a display name"
            />
          </label>
        )}
        {!isMusic && (
          <div className={`${labelClass} mt-4`}>
            <span>File location</span>
            <FolderSelect
              value={folder}
              onChange={value => onFolderChange(value)}
              options={folderOptions}
              invalid={folderInvalid}
              disabled={busy}
              placeholder={folderPlaceholder}
              customDefaultPath={folderCustomDefaultPath}
            />
            {folderInvalid && (
              <p className={helperTextClass}>Folder names cannot include the word "private".</p>
            )}
          </div>
        )}

        {privateLink && (
          <div className="mt-4 space-y-3">
            <div className={labelClass}>Private link</div>
            <div className={infoPanelClass}>
              <div className="space-y-2 text-sm">
                <p className={infoTextClass}>
                  Expiration: <span className="font-medium">{privateLinkExpirationText}</span>
                </p>
                {privateLink.alias ? (
                  <div>
                    <div className={infoTextClass}>Alias</div>
                    <div className={infoPanelAliasClass}>{privateLink.alias}</div>
                  </div>
                ) : null}
                {privateLink.url ? (
                  <p className={`${infoTextClass} break-all text-xs`}>{privateLink.url}</p>
                ) : null}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onRevokePrivateLink?.()}
                  disabled={busy || revokingPrivateLink || disablePrivateLinkRevoke || !onRevokePrivateLink}
                  className={privateLinkButtonClass}
                >
                  <CancelIcon size={16} className={revokingPrivateLink ? "opacity-60" : "opacity-80"} />
                  {revokingPrivateLink ? "Revoking…" : "Revoke"}
                </button>
                {revokePrivateLinkError ? (
                  <p className={helperTextClass}>{revokePrivateLinkError}</p>
                ) : null}
              </div>
            </div>
          </div>
        )}

        {error && <div className={errorTextClass}>{error}</div>}
        <div className="mt-6 flex justify-end gap-3">
          <button
            className={`inline-flex items-center gap-2 ${cancelButtonClass}`}
            onClick={onCancel}
            disabled={busy}
          >
            <CancelIcon size={16} className="opacity-80" />
            <span>Cancel</span>
          </button>
          <button
            className={`inline-flex items-center gap-2 ${saveButtonClass}`}
            onClick={onSubmit}
            disabled={busy || folderInvalid}
          >
            <SaveIcon size={16} className="opacity-80" />
            <span>{busy ? "Saving…" : "Save"}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
