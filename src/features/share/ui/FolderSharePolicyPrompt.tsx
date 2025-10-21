import React, { useMemo, useState } from "react";
import type { FolderListRecord, FolderSharePolicy } from "../../../shared/domain/folderList";
import { CloseIcon, ChevronRightIcon } from "../../../shared/ui/icons";
import { useUserPreferences } from "../../../app/context/UserPreferencesContext";

type FolderSharePolicyPromptProps = {
  record: FolderListRecord;
  counts: {
    total: number;
    privateOnly: number;
    publicOnly: number;
  };
  defaultPolicy: FolderSharePolicy;
  onConfirm: (policy: FolderSharePolicy) => void | Promise<void>;
  onCancel: () => void;
};

const POLICY_DESCRIPTIONS: Record<FolderSharePolicy, string> = {
  all: "Include every file in the folder. Private links are preferred when available.",
  "private-only": "Share only files that have active private links. Other files stay hidden.",
  "public-only": "Share only files without private links. Private links stay private.",
};

const POLICY_LABELS: Record<FolderSharePolicy, string> = {
  all: "All files",
  "private-only": "Private links only",
  "public-only": "Public links only",
};

export const FolderSharePolicyPrompt: React.FC<FolderSharePolicyPromptProps> = ({
  record,
  counts,
  defaultPolicy,
  onConfirm,
  onCancel,
}) => {
  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";

  const effectiveDefault = useMemo<FolderSharePolicy>(() => {
    const hasPrivate = counts.privateOnly > 0;
    const hasPublic = counts.publicOnly > 0;
    if (defaultPolicy === "private-only" && !hasPrivate) return hasPublic ? "public-only" : "all";
    if (defaultPolicy === "public-only" && !hasPublic) return hasPrivate ? "private-only" : "all";
    return defaultPolicy;
  }, [counts.privateOnly, counts.publicOnly, defaultPolicy]);

  const [selected, setSelected] = useState<FolderSharePolicy>(effectiveDefault);

  const canConfirm = useMemo(() => {
    if (selected === "private-only") return counts.privateOnly > 0;
    if (selected === "public-only") return counts.publicOnly > 0;
    return counts.total > 0;
  }, [counts.privateOnly, counts.publicOnly, counts.total, selected]);

  const options: Array<{
    value: FolderSharePolicy;
    count: number;
    disabled: boolean;
  }> = [
    {
      value: "all",
      count: counts.total,
      disabled: counts.total === 0,
    },
    {
      value: "private-only",
      count: counts.privateOnly,
      disabled: counts.privateOnly === 0,
    },
    {
      value: "public-only",
      count: counts.publicOnly,
      disabled: counts.publicOnly === 0,
    },
  ];

  const displayLabel = useMemo(() => {
    const name = record.name?.trim() || "Shared folder";
    const path = record.path?.trim() || "/";
    return `${name} (${path})`;
  }, [record.name, record.path]);

  const overlayClass =
    "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4";
  const containerClass = isLightTheme
    ? "w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-xl"
    : "w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl";
  const headingClass = isLightTheme
    ? "text-lg font-semibold text-slate-900"
    : "text-lg font-semibold text-slate-100";
  const folderLabelClass = isLightTheme
    ? "mt-2 text-sm text-slate-600 break-all"
    : "mt-2 text-sm text-slate-300 break-all";
  const descriptionClass = isLightTheme
    ? "mt-4 text-sm text-slate-600"
    : "mt-4 text-sm text-slate-300";
  const optionBaseClass = isLightTheme
    ? "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition"
    : "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition";
  const optionDisabledClass = isLightTheme
    ? "cursor-not-allowed border-slate-200 bg-slate-100 opacity-60"
    : "cursor-not-allowed border-slate-800 bg-slate-900/50 opacity-60";
  const optionSelectedClass = isLightTheme
    ? "border-emerald-500/70 bg-emerald-50"
    : "border-emerald-500/60 bg-emerald-500/10";
  const optionIdleClass = isLightTheme
    ? "border-slate-200 bg-white hover:border-slate-300"
    : "border-slate-800 bg-slate-900/70 hover:border-slate-700/80";
  const optionTitleClass = isLightTheme
    ? "text-sm font-semibold text-slate-900"
    : "text-sm font-semibold text-slate-100";
  const countPillClass = isLightTheme
    ? "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
    : "rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300";
  const optionDescriptionClass = isLightTheme
    ? "mt-1 text-xs text-slate-500"
    : "mt-1 text-xs text-slate-400";
  const optionDisabledHintClass = isLightTheme
    ? "mt-1 text-xs text-slate-500"
    : "mt-1 text-xs text-slate-500";
  const cancelButtonClass = isLightTheme
    ? "inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white"
    : "inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950";
  const continueButtonClass = isLightTheme
    ? "inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
    : "inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className={overlayClass}>
      <div className={containerClass}>
        <h2 className={headingClass}>Select what to share</h2>
        <p className={folderLabelClass}>{displayLabel}</p>
        <p className={descriptionClass}>
          Choose which files to include before publishing the folder to your relays.
        </p>
        <div className="mt-5 space-y-3">
          {options.map(option => {
            const isSelected = selected === option.value;
            const disabled = option.disabled;
            const optionClassName = [
              optionBaseClass,
              disabled ? optionDisabledClass : isSelected ? optionSelectedClass : optionIdleClass,
            ].join(" ");
            return (
              <label key={option.value} className={optionClassName}>
                <input
                  type="radio"
                  name="folder-share-policy"
                  value={option.value}
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => setSelected(option.value)}
                  className={
                    isLightTheme
                      ? "mt-1 h-4 w-4 text-emerald-600 focus:ring-emerald-500"
                      : "mt-1 h-4 w-4 text-emerald-500 focus:ring-emerald-500"
                  }
                />
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className={optionTitleClass}>{POLICY_LABELS[option.value]}</span>
                    <span className={countPillClass}>
                      {option.count} {option.count === 1 ? "file" : "files"}
                    </span>
                  </div>
                  <p className={optionDescriptionClass}>{POLICY_DESCRIPTIONS[option.value]}</p>
                  {disabled ? (
                    <p className={optionDisabledHintClass}>
                      {option.value === "private-only"
                        ? "No files have private links yet."
                        : "No files fit this option right now."}
                    </p>
                  ) : null}
                </div>
              </label>
            );
          })}
        </div>
        <div className="mt-6 flex items-center justify-between">
          <button type="button" className={cancelButtonClass} onClick={onCancel}>
            <CloseIcon size={16} aria-hidden="true" />
            <span>Cancel</span>
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected)}
            disabled={!canConfirm}
            className={continueButtonClass}
          >
            <span>Continue</span>
            <ChevronRightIcon size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderSharePolicyPrompt;
