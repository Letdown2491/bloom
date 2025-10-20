import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QRCodeToDataURLOptions } from "qrcode";
import type { RemoteSignerSession } from "../../shared/api/nip46";
import { useNip46Pairing } from "./hooks/useNip46Pairing";
import { useNip46 } from "../../app/context/Nip46Context";
import { useNdk } from "../../app/context/NdkContext";

const BLOOM_METADATA = {
  name: "Bloom",
  url: "https://bloomapp.me",
  image: "https://bloomapp.me/bloom.webp",
  description: "Bloom remote signer pairing",
} as const;

const DEFAULT_INVITATION_RELAYS: string[] = [
  "wss://relay.primal.net",
  "wss://relay.nsec.app",
  "wss://theforest.nostr1.com",
];

const buildNostrConnectUriFromSession = (session: RemoteSignerSession): string => {
  const params = new URLSearchParams();
  session.relays.forEach(relay => params.append("relay", relay));
  if (session.nostrConnectSecret) params.set("secret", session.nostrConnectSecret);
  if (session.permissions.length) params.set("perms", session.permissions.join(","));
  if (session.algorithm) params.set("alg", session.algorithm);
  if (session.metadata?.name) params.set("name", session.metadata.name);
  if (session.metadata?.url) params.set("url", session.metadata.url);
  if (session.metadata?.image) params.set("image", session.metadata.image);
  if (session.metadata) params.set("metadata", JSON.stringify(session.metadata));
  const encodedPubkey = encodeURIComponent(session.clientPublicKey);
  const query = params.toString();
  return query ? `nostrconnect://${encodedPubkey}?${query}` : `nostrconnect://${encodedPubkey}`;
};

type ConnectSignerDialogProps = {
  open: boolean;
  onClose: () => void;
};

export const ConnectSignerDialog: React.FC<ConnectSignerDialogProps> = ({ open, onClose }) => {
  const { createInvitation, pairWithUri } = useNip46Pairing();
  const { snapshot, sessionManager, service, ready, transportReady } = useNip46();
  const { ensureConnection, signer: adoptedSigner } = useNdk();
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [invitationSessionId, setInvitationSessionId] = useState<string | null>(null);
  const invitationRef = useRef<string | null>(null);
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [invitationUri, setInvitationUri] = useState<string | null>(null);
  const [manualUri, setManualUri] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualSuccess, setManualSuccess] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"scan" | "link">("scan");
  const invitationRelays = useMemo(() => DEFAULT_INVITATION_RELAYS, []);
  const attemptedAutoConnectRef = useRef(new Set<string>());

  const readySession = useMemo(
    () => snapshot.sessions.find(session => session.userPubkey && !session.lastError) ?? null,
    [snapshot.sessions]
  );

  const activeSessionReady = Boolean(adoptedSigner || readySession);

  const invitationSession = useMemo(() => {
    if (!invitationSessionId) return null;
    return snapshot.sessions.find(session => session.id === invitationSessionId) ?? null;
  }, [invitationSessionId, snapshot.sessions]);

  useEffect(() => {
    if (!invitationSession || !service) return;
    const uri = buildNostrConnectUriFromSession(invitationSession);
    setInvitationUri(prev => (prev === uri ? prev : uri));
  }, [invitationSession]);

  useEffect(() => {
    invitationRef.current = invitationSessionId;
  }, [invitationSessionId]);

  useEffect(() => {
    if (!open) return;
    void ensureConnection();
  }, [ensureConnection, open]);

  useEffect(() => {
    if (!open) {
      attemptedAutoConnectRef.current.clear();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!sessionManager || !service) return;
    if (activeSessionReady) return;
    if (invitationSessionId) return;
    const pendingSessions = snapshot.sessions.filter(session => {
      if (session.status === "revoked") return false;
      if (session.userPubkey) return false;
      if (!session.nostrConnectSecret) return false;
      return true;
    });
    if (!pendingSessions.length) return;
    const latest = pendingSessions.reduce((prev, current) =>
      current.createdAt > prev.createdAt ? current : prev
    );
    setInvitationSessionId(latest.id);
    setInvitationUri(buildNostrConnectUriFromSession(latest));
    invitationRef.current = latest.id;
    const extras = pendingSessions.filter(session => session.id !== latest.id);
    if (extras.length) {
      void Promise.all(
        extras.map(session => {
          attemptedAutoConnectRef.current.delete(session.id);
          return sessionManager.removeSession(session.id).catch(() => undefined);
        })
      );
    }
  }, [activeSessionReady, invitationSessionId, open, service, sessionManager, snapshot.sessions]);

  useEffect(() => {
    if (!invitationSession || !service) return;
    if (activeSessionReady) {
      attemptedAutoConnectRef.current.delete(invitationSession.id);
      return;
    }
    if (!invitationSession.remoteSignerPubkey) return;
    if (invitationSession.userPubkey) return;
    if (attemptedAutoConnectRef.current.has(invitationSession.id)) return;
    attemptedAutoConnectRef.current.add(invitationSession.id);
    void service.connectSession(invitationSession.id).catch(error => {
      console.warn("Auto connect attempt failed", error);
      attemptedAutoConnectRef.current.delete(invitationSession.id);
    });
  }, [activeSessionReady, invitationSession, service]);

  useEffect(() => {
    if (!open) return;
    if (activeSessionReady) {
      onClose();
    }
  }, [activeSessionReady, onClose, open]);

  useEffect(() => {
    if (!activeSessionReady || !sessionManager) return;
    setInvitationSessionId(null);
    setInvitationUri(null);
    invitationRef.current = null;
    const stale = snapshot.sessions.filter(
      session => session.status === "pairing" && !session.userPubkey
    );
    if (stale.length) {
      void Promise.all(
        stale.map(session => {
          attemptedAutoConnectRef.current.delete(session.id);
          return sessionManager.removeSession(session.id).catch(() => undefined);
        })
      );
    }
  }, [activeSessionReady, sessionManager, snapshot.sessions]);

  const generateInvitation = useCallback(async () => {
    if (activeSessionReady) return;
    if (!sessionManager) {
      setInvitationError("Remote signer is still preparing. Please try again shortly.");
      return;
    }
    setInvitationError(null);
    setInvitationBusy(true);
    const previousSessionId = invitationRef.current;
    try {
      const next = await createInvitation({
        relays: invitationRelays,
        metadata: BLOOM_METADATA,
      });
      setInvitationSessionId(next.session.id);
      setInvitationUri(next.uri);
      invitationRef.current = next.session.id;
      if (previousSessionId && previousSessionId !== next.session.id) {
        attemptedAutoConnectRef.current.delete(previousSessionId);
        await sessionManager.removeSession(previousSessionId).catch(() => undefined);
      }
    } catch (err) {
      setInvitationError(err instanceof Error ? err.message : String(err));
    } finally {
      setInvitationBusy(false);
    }
  }, [activeSessionReady, createInvitation, invitationRelays, sessionManager]);

  useEffect(() => {
    if (!open) return;
    if (activeSessionReady) return;
    if (invitationSessionId || invitationBusy) return;
    void generateInvitation();
  }, [activeSessionReady, generateInvitation, invitationBusy, invitationSessionId, open]);

  const handleManualPair = useCallback(async () => {
    if (!open) return;
    if (manualBusy) return;
    const value = manualUri.trim();
    if (!value) {
      setManualError("Enter a nostrconnect:// or bunker:// link.");
      setManualSuccess(null);
      return;
    }
    setManualError(null);
    setManualSuccess(null);
    setManualBusy(true);
    try {
      const result = await pairWithUri(value);
      const sessionId = result.session.id;
      setInvitationSessionId(sessionId);
      invitationRef.current = sessionId;
      if (result.session.nostrConnectSecret) {
        setInvitationUri(buildNostrConnectUriFromSession(result.session));
      } else {
        setInvitationUri(null);
      }
      setManualUri("");
      setManualSuccess("Link accepted. Waiting for your signer…");
    } catch (error) {
      setManualError(error instanceof Error ? error.message : "Unable to use that link.");
    } finally {
      setManualBusy(false);
    }
  }, [manualBusy, manualUri, open, pairWithUri]);

  useEffect(() => {
    if (!open || !sessionManager) return;
    const errored = snapshot.sessions.filter(
      session => session.lastError && !session.userPubkey && session.status !== "revoked"
    );
    if (!errored.length) return;
    void Promise.all(
      errored.map(session => sessionManager.removeSession(session.id).catch(() => undefined))
    );
  }, [open, sessionManager, snapshot.sessions]);

  useEffect(() => {
    if (!invitationUri) {
      setQrDataUrl(null);
      setQrError(null);
      return;
    }
    let cancelled = false;
    const options: QRCodeToDataURLOptions = {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 6,
    };

    import("qrcode")
      .then(async module => {
        try {
          const url = await module.toDataURL(invitationUri, options);
          if (!cancelled) {
            setQrDataUrl(url);
            setQrError(null);
          }
        } catch (err) {
          if (cancelled) return;
          setQrDataUrl(null);
          setQrError(err instanceof Error ? err.message : String(err));
        }
      })
      .catch(err => {
        if (cancelled) return;
        setQrDataUrl(null);
        setQrError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [invitationUri]);

  useEffect(() => {
    setCopied(false);
  }, [invitationUri]);

  const handleCopyInvitation = useCallback(async () => {
    if (!invitationUri) return;
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(invitationUri);
        setCopied(true);
        return;
      } catch (err) {
        setInvitationError(err instanceof Error ? err.message : String(err));
      }
    }
    setInvitationError("Copy to clipboard is not available in this browser");
  }, [invitationUri]);

  const handleRevoke = useCallback(
    async (sessionId: string) => {
      if (!sessionManager) return;
      try {
        await sessionManager.removeSession(sessionId);
      } catch (error) {
        console.error("Failed to revoke signer", error);
      }
    },
    [sessionManager]
  );

  const handleReconnect = useCallback(
    async (sessionId: string) => {
      if (!service) return;
      setBusySessionId(sessionId);
      try {
        await service.connectSession(sessionId);
      } catch (error) {
        console.error("Failed to reconnect signer", error);
      } finally {
        setBusySessionId(current => (current === sessionId ? null : current));
      }
    },
    [service]
  );

  const activeSessions = useMemo(
    () =>
      snapshot.sessions.filter(session => {
        if (session.status === "revoked") return false;
        if (session.userPubkey && !session.lastError) return true;
        return invitationSessionId ? session.id === invitationSessionId : false;
      }),
    [invitationSessionId, snapshot.sessions]
  );

  if (!open) return null;

  if (!ready || !transportReady || !sessionManager || !service) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/80 px-4 py-6 backdrop-blur">
        <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 text-center text-sm text-slate-300 shadow-2xl max-h-[calc(100vh-3rem)] overflow-y-auto">
          Preparing remote signer support…
        </div>
      </div>
    );
  }

  if (activeSessionReady) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/80 px-4 py-6 backdrop-blur">
      <div className="w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-200 shadow-2xl max-h-[calc(100vh-3rem)]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Connect Remote Signer</h2>
            <p className="text-sm text-slate-300">
              Scan the QR code or use a link from your remote signer to approve the connection.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="self-start rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-600 hover:text-slate-100"
          >
            Close
          </button>
        </div>

        <div className="mt-6">
          <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/70 p-1 sm:flex-row">
            <button
              type="button"
              onClick={() => setActiveTab("scan")}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-400 ${
                activeTab === "scan"
                  ? "border border-emerald-500 bg-emerald-500/10 text-emerald-300"
                  : "border border-transparent bg-transparent text-slate-300 hover:border-slate-700 hover:bg-slate-900"
              }`}
            >
              Scan or copy invitation
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("link")}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-400 ${
                activeTab === "link"
                  ? "border border-emerald-500 bg-emerald-500/10 text-emerald-300"
                  : "border border-transparent bg-transparent text-slate-300 hover:border-slate-700 hover:bg-slate-900"
              }`}
            >
              Use bunker:// link
            </button>
          </div>

          <div className="mt-4">
            {activeTab === "scan" ? (
              <section className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/70 p-5">
                {invitationError ? (
                  <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                    {invitationError}
                  </div>
                ) : null}
                <div className="flex flex-col items-center gap-4">
                  <div className="flex h-60 w-60 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    {qrDataUrl ? (
                      <img src={qrDataUrl} alt="nostrconnect invitation" className="h-full w-full rounded-md" />
                    ) : invitationBusy ? (
                      <span className="text-xs text-slate-400">Preparing QR…</span>
                    ) : (
                      <span className="text-xs text-slate-400">Waiting for link…</span>
                    )}
                  </div>
                  {qrError ? <div className="text-[11px] text-rose-400">{qrError}</div> : null}

                  <div className="flex w-full flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopyInvitation()}
                      disabled={!invitationUri}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-emerald-300 hover:border-emerald-500 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                      title={invitationUri ?? "Invitation link not ready"}
                    >
                      {invitationUri ? "Click to copy Nostr Connect URL" : invitationBusy ? "Preparing invitation…" : "Waiting for invitation…"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void generateInvitation()}
                      disabled={invitationBusy}
                      className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:border-slate-600 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {invitationBusy ? "Generating new link…" : "Regenerate invitation"}
                    </button>
                  </div>
                  {copied ? <div className="text-[11px] text-emerald-300">Link copied to clipboard</div> : null}

                  {invitationUri ? (
                    <details className="w-full rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-left text-[11px] text-slate-400">
                      <summary className="cursor-pointer select-none text-slate-300 hover:text-emerald-300">
                        Show invitation details
                      </summary>
                      <div className="mt-2 space-y-2 break-all">
                        <div className="font-mono text-slate-400">{invitationUri}</div>
                        {invitationSession?.relays.length ? (
                          <div className="text-slate-400">Relays: {invitationSession.relays.join(", ")}</div>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </div>
              </section>
            ) : (
              <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/70 p-5">
                <div>
                  <h3 className="text-sm font-semibold text-slate-200">Use a bunker link</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    Paste a <code className="rounded bg-slate-800 px-1 py-0.5 text-[10px]">bunker://</code> URL to reuse an existing invitation from your signer.
                  </p>
                </div>
                <form
                  onSubmit={event => {
                    event.preventDefault();
                    void handleManualPair();
                  }}
                  className="flex flex-col gap-2"
                >
                  <input
                    type="text"
                    value={manualUri}
                    onChange={event => {
                      setManualUri(event.target.value);
                      if (manualError) setManualError(null);
                      if (manualSuccess) setManualSuccess(null);
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    placeholder="bunker://..."
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="submit"
                      disabled={manualBusy || manualUri.trim().length === 0}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-emerald-500 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {manualBusy ? "Connecting…" : "Connect"}
                    </button>
                    {manualError ? <span className="text-[11px] text-rose-400">{manualError}</span> : null}
                    {manualSuccess ? <span className="text-[11px] text-emerald-300">{manualSuccess}</span> : null}
                  </div>
                </form>
                <p className="text-[11px] text-slate-400">Tip: bunker links and QR codes from the same signer usually represent the same invitation.</p>
              </section>
            )}
          </div>
        </div>

        {activeSessions.length > 0 && (
          <section className="mt-6 space-y-3 rounded-xl border border-slate-800 bg-slate-900/70 p-5 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">Saved signers</h3>
              <span className="text-[11px] text-slate-400">{activeSessions.length} connected</span>
            </div>
            <ul className="space-y-2">
              {activeSessions.map(session => (
                <li key={session.id} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-slate-100">
                      {session.metadata?.name || session.remoteSignerPubkey || session.id}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {session.userPubkey && !session.lastError ? "Active" : session.status}
                      {session.lastError ? ` • ${session.lastError}` : ""}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {session.authChallengeUrl ? (
                      <a
                        className="text-[11px] text-emerald-400 hover:text-emerald-300"
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
                      className="text-[11px] text-slate-300 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Retry connect
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(session.id)}
                      className="text-[11px] text-rose-400 hover:text-rose-300"
                    >
                      Revoke
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
};
