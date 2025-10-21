import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useUserPreferences } from "../../../app/context/UserPreferencesContext";

type MoveDialogOption = {
  value: string | null;
  label: string;
  disabled?: boolean;
};

export type MoveDialogDestination =
  | { kind: "existing"; target: string | null }
  | { kind: "new"; path: string };

type MoveDialogProps = {
  itemType: "file" | "folder";
  itemLabel: string;
  currentLocationLabel: string;
  itemPathLabel?: string;
  options: MoveDialogOption[];
  initialValue: string | null;
  busy?: boolean;
  error?: string | null;
  onSubmit: (destination: MoveDialogDestination) => void;
  onCancel: () => void;
  createNewOptionValue?: string;
  newFolderDefaultPath?: string;
  destinationHint?: string;
};

const HOME_VALUE = "";

export const MoveDialog: React.FC<MoveDialogProps> = ({
  itemType,
  itemLabel,
  currentLocationLabel,
  itemPathLabel,
  options,
  initialValue,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
  createNewOptionValue,
  newFolderDefaultPath = "Images/Trips",
  destinationHint = "Only non-private folders are available as destinations.",
}) => {
  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";

  const initialSelection = initialValue ?? HOME_VALUE;
  const [selection, setSelection] = useState<string>(initialSelection);
  const [newFolderDraft, setNewFolderDraft] = useState<string>(newFolderDefaultPath);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setSelection(initialSelection);
  }, [initialSelection]);

  useEffect(() => {
    if (busy) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, onCancel]);

  const optionList = useMemo(() => {
    return options.map(option => {
      const normalizedValue = option.value ?? HOME_VALUE;
      return {
        value: normalizedValue,
        label: option.label,
        disabled: option.disabled ?? false,
      };
    });
  }, [options]);

  const selectedOption = optionList.find(option => option.value === selection);
  const selectionDisabled = Boolean(selectedOption?.disabled);
  const isCreatingNewFolder = createNewOptionValue ? selection === createNewOptionValue : false;
  const trimmedNewFolderDraft = newFolderDraft.trim();

  useEffect(() => {
    if (!createNewOptionValue) return;
    if (selection !== createNewOptionValue) return;
    if (!newFolderDraft) {
      setNewFolderDraft(newFolderDefaultPath);
    }
  }, [createNewOptionValue, newFolderDraft, newFolderDefaultPath, selection]);

  useEffect(() => {
    setNewFolderDraft(newFolderDefaultPath);
  }, [newFolderDefaultPath]);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const canSubmit =
    !busy &&
    !selectionDisabled &&
    (isCreatingNewFolder ? trimmedNewFolderDraft.length > 0 : selection !== initialSelection);

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = event => {
    event.preventDefault();
    if (!canSubmit) return;
    if (isCreatingNewFolder) {
      onSubmit({ kind: "new", path: trimmedNewFolderDraft });
      return;
    }
    const target = selection === HOME_VALUE ? null : selection;
    onSubmit({ kind: "existing", target });
  };

  const moveVerb = busy ? "Moving…" : "Move";
  const itemDescriptor = itemType === "folder" ? "folder" : "file";

  const overlayClass =
    "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4";
  const dialogClass = isLightTheme
    ? "w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-xl"
    : "w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-6 text-slate-100 shadow-xl";
  const headingClass = isLightTheme
    ? "text-lg font-semibold text-slate-900"
    : "text-lg font-semibold text-slate-100";
  const itemSummaryTextClass = isLightTheme
    ? "mt-1 text-sm text-slate-600"
    : "mt-1 text-sm text-slate-400";
  const itemLabelClass = isLightTheme ? "text-slate-900" : "text-slate-200";
  const locationTextClass = isLightTheme
    ? "mt-3 text-sm text-slate-700"
    : "mt-3 text-sm text-slate-300";
  const locationHighlightClass = isLightTheme
    ? "font-medium text-emerald-600"
    : "font-medium text-emerald-300";
  const pathTextClass = isLightTheme
    ? "mt-1 text-xs text-slate-500"
    : "mt-1 text-xs text-slate-500";
  const destinationLabelClass = isLightTheme
    ? "mt-5 block text-sm text-slate-700"
    : "mt-5 block text-sm text-slate-200";
  const selectClass = isLightTheme
    ? "mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
    : "mt-2 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
  const newFolderLabelClass = isLightTheme
    ? "block text-xs text-slate-600"
    : "block text-xs text-slate-300";
  const newFolderInputClass = isLightTheme
    ? "mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
    : "mt-2 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
  const helperTextClass = isLightTheme
    ? "mt-1 text-xs text-slate-500"
    : "mt-1 text-xs text-slate-500";
  const hintTextClass = isLightTheme
    ? "mt-2 text-xs text-slate-500"
    : "mt-2 text-xs text-slate-500";
  const warningTextClass = isLightTheme
    ? "mt-1 text-xs text-amber-600"
    : "mt-1 text-xs text-amber-400";
  const errorTextClass = isLightTheme ? "mt-2 text-sm text-red-500" : "mt-2 text-sm text-red-400";
  const cancelButtonClass = isLightTheme
    ? "rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
    : "rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-60";
  const submitButtonClass = isLightTheme
    ? "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
    : "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60";

  if (!mounted || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className={overlayClass}>
      <form onSubmit={handleSubmit} className={dialogClass}>
        <h2 className={headingClass}>Move {itemDescriptor}</h2>
        <p className={itemSummaryTextClass}>
          <span className={itemLabelClass}>{itemLabel}</span>
        </p>
        <p className={locationTextClass}>
          Current location: <span className={locationHighlightClass}>{currentLocationLabel}</span>
        </p>
        {itemType === "folder" && itemPathLabel ? (
          <p className={pathTextClass}>Folder path: {itemPathLabel}</p>
        ) : null}

        <label className={destinationLabelClass}>
          Destination
          <select
            value={selection}
            onChange={event => setSelection(event.target.value)}
            disabled={busy}
            className={selectClass}
          >
            {optionList.map(option => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
                {option.value === initialSelection ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
        {isCreatingNewFolder ? (
          <div className="mt-3">
            <label className={newFolderLabelClass}>
              New folder path
              <input
                type="text"
                value={newFolderDraft}
                onChange={event => setNewFolderDraft(event.target.value)}
                disabled={busy}
                className={newFolderInputClass}
                placeholder={newFolderDefaultPath}
              />
            </label>
            <p className={helperTextClass}>
              Enter the destination folder name. It will be created if needed.
            </p>
          </div>
        ) : null}
        <p className={hintTextClass}>{destinationHint}</p>
        {selectionDisabled ? (
          <p className={warningTextClass}>
            You cannot move a folder into itself or one of its subfolders.
          </p>
        ) : null}
        {error ? <p className={errorTextClass}>{error}</p> : null}

        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} disabled={busy} className={cancelButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={!canSubmit} className={submitButtonClass}>
            {moveVerb}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};

export default MoveDialog;
