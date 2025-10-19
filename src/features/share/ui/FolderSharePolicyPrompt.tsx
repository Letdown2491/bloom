import React, { useMemo, useState } from "react";
import type { FolderListRecord, FolderSharePolicy } from "../../../shared/domain/folderList";
import { CloseIcon, ChevronRightIcon } from "../../../shared/ui/icons";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-100">Select what to share</h2>
        <p className="mt-2 text-sm text-slate-300 break-all">{displayLabel}</p>
        <p className="mt-4 text-sm text-slate-300">
          Choose which files to include before publishing the folder to your relays.
        </p>
        <div className="mt-5 space-y-3">
          {options.map(option => {
            const isSelected = selected === option.value;
            const disabled = option.disabled;
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition ${
                  disabled
                    ? "cursor-not-allowed border-slate-800 bg-slate-900/50 opacity-60"
                    : isSelected
                      ? "border-emerald-500/60 bg-emerald-500/10"
                      : "border-slate-800 bg-slate-900/70 hover:border-slate-700/80"
                }`}
              >
                <input
                  type="radio"
                  name="folder-share-policy"
                  value={option.value}
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => setSelected(option.value)}
                  className="mt-1 h-4 w-4 text-emerald-500 focus:ring-emerald-500"
                />
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100">{POLICY_LABELS[option.value]}</span>
                    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300">
                      {option.count} {option.count === 1 ? "file" : "files"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{POLICY_DESCRIPTIONS[option.value]}</p>
                  {disabled ? (
                    <p className="mt-1 text-xs text-slate-500">
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
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950"
            onClick={onCancel}
          >
            <CloseIcon size={16} aria-hidden="true" />
            <span>Cancel</span>
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected)}
            disabled={!canConfirm}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-70"
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
