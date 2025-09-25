import React, { useCallback, useState } from "react";
import { useNip46Pairing } from "../../hooks/useNip46Pairing";
import { useNip46 } from "../../context/Nip46Context";

type ConnectSignerDialogProps = {
  open: boolean;
  onClose: () => void;
  onPaired?: (sessionId: string) => void;
};

export const ConnectSignerDialog: React.FC<ConnectSignerDialogProps> = ({ open, onClose, onPaired }) => {
  const { pairWithUri } = useNip46Pairing();
  const { snapshot, sessionManager, service } = useNip46();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!token.trim()) {
        setError("Paste a nostrconnect:// or bunker:// link from Amber");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await pairWithUri(token.trim());
        setToken("");
        onPaired?.(result.session.id);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [token, pairWithUri, onPaired, onClose]
  );

  const handleRevoke = useCallback(
    async (sessionId: string) => {
      try {
        await sessionManager.removeSession(sessionId);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    [sessionManager]
  );

  const handleReconnect = useCallback(
    async (sessionId: string) => {
      setError(null);
      setBusySessionId(sessionId);
      try {
        await service.connectSession(sessionId);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusySessionId(current => (current === sessionId ? null : current));
      }
    },
    [service]
  );

  if (!open) return null;

  const activeSessions = snapshot.sessions.filter(session => session.status !== "revoked");

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/80 px-4 py-6 backdrop-blur">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Connect Amber Signer</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-600 hover:text-slate-100"
          >
            Close
          </button>
        </div>

        <p className="mt-3 text-sm text-slate-300">
          Open your signer application, choose <strong>Share</strong>, copy the
          <code className="mx-1 rounded bg-slate-800 px-1 py-0.5 text-[11px]">bunker://</code> or
          <code className="mx-1 rounded bg-slate-800 px-1 py-0.5 text-[11px]">nostrconnect://</code> link, and paste it below
          to pair Bloom with your signer and get connected.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-400">Amber pairing link</span>
            <textarea
              rows={3}
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder="nostrconnect://..."
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              spellCheck={false}
            />
          </label>
          {error ? <div className="text-xs text-rose-400">{error}</div> : null}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
            <button
              type="button"
              onClick={() => setToken("")}
              disabled={busy || !token}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </form>

        {activeSessions.length > 0 && (
          <div className="mt-6 space-y-2 rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-xs">
            <h3 className="text-sm font-semibold text-slate-200">Connected signers</h3>
            <ul className="space-y-1">
              {activeSessions.map(session => (
                <li key={session.id} className="flex flex-col gap-0.5">
                  <span className="text-slate-100">
                    {session.metadata?.name || session.remoteSignerPubkey || session.id}
                  </span>
                  <span className="text-slate-400">
                    Status: {session.status}
                    {session.lastError ? ` • ${session.lastError}` : ""}
                  </span>
                  <div className="flex items-center gap-3">
                    {session.authChallengeUrl ? (
                      <a
                        className="text-emerald-400 hover:text-emerald-300"
                        href={session.authChallengeUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Complete authentication challenge
                      </a>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => handleReconnect(session.id)}
                      disabled={busySessionId === session.id}
                      className="text-xs text-slate-300 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Retry connect
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(session.id)}
                      className="text-xs text-rose-400 hover:text-rose-300"
                    >
                      Revoke
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};
