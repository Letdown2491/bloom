import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type DialogTone = "default" | "danger" | "info" | "success" | "warning";

export type ConfirmDialogOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  icon?: ReactNode;
};

export type PromptDialogOptions<Value = string> = {
  title?: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  helpText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  trim?: boolean;
  validate?: (value: string) => string | null;
  transform?: (value: string) => Value;
};

export type AlertDialogOptions = {
  title?: string;
  message: string;
  acknowledgeLabel?: string;
  tone?: DialogTone;
  icon?: ReactNode;
};

type DialogContextValue = {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  prompt: <Value = string>(options: PromptDialogOptions<Value>) => Promise<Value | null>;
  alert: (options: AlertDialogOptions) => Promise<void>;
};

const DialogContext = createContext<DialogContextValue | undefined>(undefined);

export const useDialog = (): DialogContextValue => {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error("useDialog must be used within a DialogProvider");
  }
  return context;
};

type ConfirmRequest = {
  kind: "confirm";
  options: ConfirmDialogOptions;
  resolve: (value: boolean) => void;
};

type PromptRequest = {
  kind: "prompt";
  options: PromptDialogOptions<unknown>;
  resolve: (value: unknown) => void;
};

type AlertRequest = {
  kind: "alert";
  options: AlertDialogOptions;
  resolve: () => void;
};

type DialogRequest = ConfirmRequest | PromptRequest | AlertRequest;

type DialogProviderProps = {
  children: React.ReactNode;
};

export const DialogProvider: React.FC<DialogProviderProps> = ({ children }) => {
  const [activeRequest, setActiveRequest] = useState<DialogRequest | null>(null);
  const queueRef = useRef<DialogRequest[]>([]);

  useEffect(() => {
    if (!activeRequest && queueRef.current.length > 0) {
      const [next, ...rest] = queueRef.current;
      queueRef.current = rest;
      setActiveRequest(next ?? null);
    }
  }, [activeRequest]);

  const enqueue = useCallback(
    (request: DialogRequest) => {
      if (activeRequest) {
        queueRef.current = [...queueRef.current, request];
        return;
      }
      setActiveRequest(request);
    },
    [activeRequest],
  );

  const confirm = useCallback(
    (options: ConfirmDialogOptions) =>
      new Promise<boolean>(resolve => {
        enqueue({ kind: "confirm", options, resolve });
      }),
    [enqueue],
  );

  const prompt = useCallback(
    <Value,>(options: PromptDialogOptions<Value>) =>
      new Promise<Value | null>(resolve => {
        const request: PromptRequest = {
          kind: "prompt",
          options: options as PromptDialogOptions<unknown>,
          resolve: value => {
            resolve(value as Value | null);
          },
        };
        enqueue(request);
      }),
    [enqueue],
  );

  const alert = useCallback(
    (options: AlertDialogOptions) =>
      new Promise<void>(resolve => {
        enqueue({ kind: "alert", options, resolve });
      }),
    [enqueue],
  );

  const handleConfirmResult = useCallback(
    (value: boolean) => {
      if (!activeRequest || activeRequest.kind !== "confirm") return;
      const resolver = activeRequest.resolve;
      setActiveRequest(null);
      resolver(value);
    },
    [activeRequest],
  );

  const handlePromptResult = useCallback(
    (value: unknown) => {
      if (!activeRequest || activeRequest.kind !== "prompt") return;
      const resolver = activeRequest.resolve;
      setActiveRequest(null);
      resolver(value);
    },
    [activeRequest],
  );

  const handlePromptCancel = useCallback(() => {
    if (!activeRequest || activeRequest.kind !== "prompt") return;
    const resolver = activeRequest.resolve;
    setActiveRequest(null);
    resolver(null);
  }, [activeRequest]);

  const handleAlertClose = useCallback(() => {
    if (!activeRequest || activeRequest.kind !== "alert") return;
    const resolver = activeRequest.resolve;
    setActiveRequest(null);
    resolver();
  }, [activeRequest]);

  const contextValue = useMemo(
    () => ({
      confirm,
      prompt,
      alert,
    }),
    [alert, confirm, prompt],
  );

  return (
    <DialogContext.Provider value={contextValue}>
      {children}
      <DialogHost
        request={activeRequest}
        onConfirm={handleConfirmResult}
        onPromptSubmit={handlePromptResult}
        onPromptCancel={handlePromptCancel}
        onAlertClose={handleAlertClose}
      />
    </DialogContext.Provider>
  );
};

type DialogHostProps = {
  request: DialogRequest | null;
  onConfirm: (value: boolean) => void;
  onPromptSubmit: (value: unknown) => void;
  onPromptCancel: () => void;
  onAlertClose: () => void;
};

const TONE_PRIMARY_CLASS: Record<DialogTone, string> = {
  default:
    "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950",
  danger:
    "rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-slate-50 transition hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-slate-950",
  info: "rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-slate-50 transition hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-slate-950",
  success:
    "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950",
  warning:
    "rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-slate-950",
};

const SECONDARY_BUTTON_CLASS =
  "rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:ring-offset-slate-950";

const DialogHost: React.FC<DialogHostProps> = ({
  request,
  onConfirm,
  onPromptSubmit,
  onPromptCancel,
  onAlertClose,
}) => {
  const [promptValue, setPromptValue] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (request?.kind === "prompt") {
      setPromptValue(request.options.initialValue ?? "");
      setPromptError(null);
      const frame =
        typeof window !== "undefined"
          ? window.requestAnimationFrame(() => {
              inputRef.current?.focus({ preventScroll: true });
              inputRef.current?.select();
            })
          : null;
      return () => {
        if (frame !== null && typeof window !== "undefined") {
          window.cancelAnimationFrame(frame);
        }
      };
    }
    return undefined;
  }, [request]);

  useEffect(() => {
    if (request?.kind && request.kind !== "prompt") {
      const frame =
        typeof window !== "undefined"
          ? window.requestAnimationFrame(() => {
              const element = descriptionRef.current ?? inputRef.current;
              element?.focus({ preventScroll: true });
            })
          : null;
      return () => {
        if (frame !== null && typeof window !== "undefined") {
          window.cancelAnimationFrame(frame);
        }
      };
    }
    return undefined;
  }, [request]);

  if (!request) return null;

  const tone: DialogTone = request.options.tone ?? "default";
  const confirmLabel =
    request.kind === "confirm"
      ? (request.options.confirmLabel ?? "Confirm")
      : request.kind === "prompt"
        ? (request.options.confirmLabel ?? "Submit")
        : undefined;
  const cancelLabel =
    request.kind === "confirm" || request.kind === "prompt"
      ? (request.options.cancelLabel ?? "Cancel")
      : undefined;
  const acknowledgeLabel =
    request.kind === "alert" ? (request.options.acknowledgeLabel ?? "Got it") : undefined;

  const overlayKeyDown: React.KeyboardEventHandler<HTMLDivElement> = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (request.kind === "prompt") {
        onPromptCancel();
        return;
      }
      if (request.kind === "confirm") {
        onConfirm(false);
        return;
      }
      if (request.kind === "alert") {
        onAlertClose();
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (request.kind === "confirm") {
        event.preventDefault();
        onConfirm(true);
      }
      if (request.kind === "alert") {
        event.preventDefault();
        onAlertClose();
      }
    }
  };

  const handleBackdropClick: React.MouseEventHandler<HTMLDivElement> = event => {
    if (event.target !== event.currentTarget) return;
    if (request.kind === "alert") {
      onAlertClose();
      return;
    }
    if (request.kind === "confirm") {
      onConfirm(false);
      return;
    }
    if (request.kind === "prompt") {
      onPromptCancel();
    }
  };

  const submitPrompt = () => {
    if (request.kind !== "prompt") return;
    const rawValue = request.options.trim === false ? promptValue : promptValue.trim();
    const validator = request.options.validate;
    const validationError = validator ? validator(rawValue) : null;
    if (validationError) {
      setPromptError(validationError);
      return;
    }
    const transform = request.options.transform;
    const result = transform ? transform(rawValue) : rawValue;
    onPromptSubmit(result);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4"
      role="dialog"
      aria-modal="true"
      onKeyDown={overlayKeyDown}
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl focus:outline-none">
        {"icon" in request.options && request.options.icon ? (
          <div className="mb-3 text-emerald-300" aria-hidden="true">
            {request.options.icon}
          </div>
        ) : null}
        {request.options.title ? (
          <h2 className="text-lg font-semibold text-slate-100">{request.options.title}</h2>
        ) : null}
        {"message" in request.options && request.options.message ? (
          <p
            ref={descriptionRef}
            className="mt-3 text-sm text-slate-300 focus:outline-none"
            tabIndex={-1}
          >
            {request.options.message}
          </p>
        ) : null}
        {request.kind === "prompt" ? (
          <div className="mt-5">
            <label className="text-sm text-slate-300">
              <span className="sr-only">Prompt</span>
              <input
                ref={inputRef}
                type="text"
                value={promptValue}
                onChange={event => {
                  setPromptValue(event.target.value);
                  if (promptError) setPromptError(null);
                }}
                placeholder={request.options.placeholder}
                className={`w-full rounded-xl border px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                  promptError
                    ? "border-red-600 focus:ring-red-500"
                    : "border-slate-700 bg-slate-950"
                }`}
              />
            </label>
            {request.options.helpText ? (
              <p className="mt-2 text-xs text-slate-400">{request.options.helpText}</p>
            ) : null}
            {promptError ? <p className="mt-2 text-xs text-red-400">{promptError}</p> : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          {request.kind === "confirm" ? (
            <>
              <button
                type="button"
                className={SECONDARY_BUTTON_CLASS}
                onClick={() => onConfirm(false)}
              >
                {cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={TONE_PRIMARY_CLASS[tone]}
                onClick={() => onConfirm(true)}
              >
                {confirmLabel ?? "Confirm"}
              </button>
            </>
          ) : null}
          {request.kind === "prompt" ? (
            <>
              <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onPromptCancel}>
                {cancelLabel ?? "Cancel"}
              </button>
              <button type="button" className={TONE_PRIMARY_CLASS[tone]} onClick={submitPrompt}>
                {confirmLabel ?? "Submit"}
              </button>
            </>
          ) : null}
          {request.kind === "alert" ? (
            <button type="button" className={TONE_PRIMARY_CLASS[tone]} onClick={onAlertClose}>
              {acknowledgeLabel ?? "Got it"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default DialogProvider;
