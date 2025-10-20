import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useUserPreferences } from "../../../app/context/UserPreferencesContext";
import { ShareIcon, LockIcon, CopyIcon, CancelIcon, SaveIcon } from "../../../shared/ui/icons";

export type ShareHowDialogProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (mode: "public" | "private") => void;
  allowPublic: boolean;
  allowPrivate: boolean;
  hasExistingPrivateLink?: boolean;
  canCreatePrivateLink?: boolean;
  privateLinkDisabledReason?: string | null;
  publicLinkUrl?: string;
  privateLinkUrl?: string;
};

export const ShareHowDialog: React.FC<ShareHowDialogProps> = ({
  open,
  onClose,
  onSelect,
  allowPublic,
  allowPrivate,
  hasExistingPrivateLink = false,
  canCreatePrivateLink = false,
  privateLinkDisabledReason = null,
  publicLinkUrl,
  privateLinkUrl,
}) => {
  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";
  const [mounted, setMounted] = useState(false);
  const [selection, setSelection] = useState<"public" | "private">("public");
  const [copyState, setCopyState] = useState<null | "public" | "private">(null);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (allowPublic) {
      setSelection("public");
    } else if (allowPrivate) {
      setSelection("private");
    } else {
      setSelection("public");
    }
    setCopyState(null);
  }, [open, allowPublic, allowPrivate]);

  if (!mounted || !open || typeof document === "undefined") return null;

  const overlayClass = "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4";
  const dialogClass = isLightTheme
    ? "w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-xl"
    : "w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-6 text-slate-100 shadow-xl";
  const headingClass = isLightTheme ? "text-lg font-semibold text-slate-900" : "text-lg font-semibold text-slate-100";
  const descriptionClass = isLightTheme ? "mt-2 text-sm text-slate-600" : "mt-2 text-sm text-slate-400";
  const optionsContainerClass = isLightTheme
    ? "mt-4 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4"
    : "mt-4 space-y-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4";
  const optionTitleClass = isLightTheme ? "text-sm font-semibold text-slate-900" : "text-sm font-semibold text-slate-100";
  const optionDescriptionClass = isLightTheme ? "mt-1 text-xs text-slate-500" : "mt-1 text-xs text-slate-400";
  const radioClass = isLightTheme
    ? "mt-1 h-4 w-4 text-emerald-600 focus:ring-emerald-500 border-slate-300"
    : "mt-1 h-4 w-4 text-emerald-500 focus:ring-emerald-500 border-slate-600 bg-slate-900";
  const iconPillClass = isLightTheme
    ? "flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500"
    : "flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300";
  const buttonBarClass = "mt-6 flex justify-end gap-3";
  const cancelButtonClass = isLightTheme
    ? "rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400"
    : "rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:border-slate-600";
  const continueButtonClass = isLightTheme
    ? "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
    : "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60";

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = event => {
    event.preventDefault();
    if ((selection === "public" && !allowPublic) || (selection === "private" && !allowPrivate)) return;
    onSelect(selection);
  };

  const privateDescription = (() => {
    if (!allowPrivate) {
      return privateLinkDisabledReason ?? "Private sharing isn’t available for this file.";
    }
    if (hasExistingPrivateLink) {
      return "Share a private link you can revoke at any time.";
    }
    if (canCreatePrivateLink) {
      return "This file doesn’t have a private link yet—we’ll create one before sharing.";
    }
    return "Create or reuse a private link managed by your private link service.";
  })();

  const handleCopy = (value: string, variant: "public" | "private") => {
    if (!value) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(value).then(
        () => {
          setCopyState(variant);
          window.setTimeout(() => setCopyState(null), 2000);
        },
        () => {
          setCopyState(null);
        }
      );
    }
  };

  const copyButtonClass = (disabled: boolean) =>
    `flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-sm transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
      disabled
        ? "border-slate-300 text-slate-400 cursor-not-allowed"
        : isLightTheme
          ? "border-slate-300 bg-white hover:border-emerald-400 hover:text-emerald-600"
          : "border-slate-700 bg-slate-900 hover:border-emerald-400 hover:text-emerald-300"
    }`;
  const linkTextClass = "flex-1 min-w-0 truncate text-left font-mono text-[13px]";

  return createPortal(
    <div className={overlayClass} role="presentation">
      <form
        className={dialogClass}
        role="dialog"
        aria-modal="true"
        aria-label="Select how to share"
        onSubmit={handleSubmit}
      >
        <h2 className={headingClass}>Select how to share</h2>
        <p className={descriptionClass}>Choose how you want to share this file.</p>

        <fieldset className={optionsContainerClass}>
          <legend className="sr-only">Share options</legend>
          <label className={`flex gap-3 ${!allowPublic ? "opacity-60" : ""}`}>
            <input
              type="radio"
              name="share-mode"
              value="public"
              className={radioClass}
              checked={selection === "public"}
              disabled={!allowPublic}
              onChange={() => allowPublic && setSelection("public")}
            />
            <div className="flex flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className={iconPillClass}>
                  <ShareIcon size={16} />
                </span>
                <span className={optionTitleClass}>Share via public link</span>
              </div>
              <p className={optionDescriptionClass}>
                Share a direct link that anyone can open without additional approval.
              </p>
            </div>
          </label>

          <label className={`flex gap-3 ${!allowPrivate ? "opacity-60" : ""}`}>
            <input
              type="radio"
              name="share-mode"
              value="private"
              className={radioClass}
              checked={selection === "private"}
              disabled={!allowPrivate}
              onChange={() => allowPrivate && setSelection("private")}
            />
            <div className="flex flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className={iconPillClass}>
                  <LockIcon size={16} />
                </span>
                <span className={optionTitleClass}>Share via private link</span>
              </div>
              <p className={optionDescriptionClass}>{privateDescription}</p>
            </div>
          </label>
        </fieldset>

        <div className="mt-5 space-y-2">
          {publicLinkUrl ? (
            <button
              type="button"
              className={copyButtonClass(false)}
              onClick={() => handleCopy(publicLinkUrl, "public")}
              aria-label="Copy public link"
              title="Copy public link"
            >
              <span className="whitespace-nowrap text-left text-sm font-medium">Public link</span>
              <span className={linkTextClass}>{publicLinkUrl}</span>
              <CopyIcon size={14} className="flex-shrink-0" />
              <span className="text-xs text-emerald-500">{copyState === "public" ? "Copied!" : ""}</span>
            </button>
          ) : null}
          {privateLinkUrl ? (
            <button
              type="button"
              className={copyButtonClass(false)}
              onClick={() => handleCopy(privateLinkUrl, "private")}
              aria-label="Copy private link"
              title="Copy private link"
            >
              <span className="whitespace-nowrap text-left text-sm font-medium">Private link</span>
              <span className={linkTextClass}>{privateLinkUrl}</span>
              <CopyIcon size={14} className="flex-shrink-0" />
              <span className="text-xs text-emerald-500">{copyState === "private" ? "Copied!" : ""}</span>
            </button>
          ) : null}
        </div>

        <div className={buttonBarClass}>
          <button type="button" className={cancelButtonClass} onClick={onClose}>
            <span className="flex items-center gap-2">
              <CancelIcon size={15} />
              <span>Cancel</span>
            </span>
          </button>
          <button
            type="submit"
            className={continueButtonClass}
            disabled={(selection === "public" && !allowPublic) || (selection === "private" && !allowPrivate)}
          >
            <span className="flex items-center gap-2">
              <SaveIcon size={16} />
              <span>Continue</span>
            </span>
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
};

export default ShareHowDialog;
