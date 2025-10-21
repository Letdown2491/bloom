import React from "react";

export type LoggedOutPromptProps = {
  onConnect: () => void | Promise<void>;
  onConnectRemoteSigner: () => void;
  hasNip07Extension: boolean;
};

export const LoggedOutPrompt: React.FC<LoggedOutPromptProps> = ({
  onConnect,
  onConnectRemoteSigner,
  hasNip07Extension,
}) => {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-8 text-center shadow-xl">
        <img src="/bloom.webp" alt="Bloom logo" width={128} height={128} className="w-24 rounded-xl md:w-32" />
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-slate-100">Welcome to Bloom</h2>
          <p className="text-left text-sm text-slate-300">
            Browse, upload, and share music, video, and documents on any{" "}
            <a
              href="https://github.com/nostr-protocol/nips/blob/master/B7.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-300 underline decoration-emerald-500/60 underline-offset-2 transition hover:text-emerald-200"
            >
              Blossom
            </a>{" "}
            and{" "}
            <a
              href="https://github.com/nostr-protocol/nips/blob/master/96.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-300 underline decoration-emerald-500/60 underline-offset-2 transition hover:text-emerald-200"
            >
              NIP-96
            </a>
            -compatible servers. All your media stays decentralized, secure, and instantly accessible.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          {hasNip07Extension && (
            <button
              onClick={() => {
                void onConnect();
              }}
              className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
            >
              Connect With Extension
            </button>
          )}
          <button
            onClick={onConnectRemoteSigner}
            className="rounded-xl border border-emerald-500/60 bg-transparent px-3 py-2 text-sm font-semibold text-emerald-300 transition hover:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          >
            Connect Remote Signer
          </button>
          <div className="flex items-center justify-center gap-2 text-xs uppercase tracking-wide text-slate-500">
            <span className="h-px w-6 bg-slate-800" aria-hidden="true" />
            <span>or</span>
            <span className="h-px w-6 bg-slate-800" aria-hidden="true" />
          </div>
          <button
            onClick={() => {
              window.open("https://start.nostr.net/", "_blank", "noopener");
            }}
            className="rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:border-emerald-400 hover:bg-slate-900/60 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          >
            Learn more about Nostr
          </button>
        </div>
      </div>
    </div>
  );
};

