import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QRCodeToDataURLOptions } from "qrcode";
import type { RemoteSignerSession } from "../../lib/nip46";
import { useNip46Pairing } from "../../hooks/useNip46Pairing";
import { useNip46 } from "../../context/Nip46Context";
import { useNdk } from "../../context/NdkContext";
import { DEFAULT_PUBLIC_RELAYS } from "../../utils/relays";

const BLOOM_METADATA = {
  name: "Bloom",
  url: "https://github.com/utxo-one/bloom",
  description: "Bloom remote signer pairing",
} as const;

const DEFAULT_INVITATION_RELAYS = Array.from(DEFAULT_PUBLIC_RELAYS);

const buildNostrConnectUriFromSession = (session: RemoteSignerSession): string => {
  const params = new URLSearchParams();
  session.relays.forEach(relay => params.append("relay", relay));
  if (session.nostrConnectSecret) params.set("secret", session.nostrConnectSecret);
  if (session.permissions.length) params.set("perms", session.permissions.join(","));
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
  const { createInvitation } = useNip46Pairing();
  const { snapshot, sessionManager, service } = useNip46();
  const { connect: ensureNdkConnection, signer: adoptedSigner } = useNdk();
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [invitationSessionId, setInvitationSessionId] = useState<string | null>(null);
  const invitationRef = useRef<string | null>(null);
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [invitationUri, setInvitationUri] = useState<string | null>(null);
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
    if (!invitationSession) return;
    const uri = buildNostrConnectUriFromSession(invitationSession);
    setInvitationUri(prev => (prev === uri ? prev : uri));
  }, [invitationSession]);

  useEffect(() => {
    invitationRef.current = invitationSessionId;
  }, [invitationSessionId]);

  useEffect(() => {
    if (!open) return;
    void ensureNdkConnection();
  }, [ensureNdkConnection, open]);

  useEffect(() => {
    if (!open) {
      attemptedAutoConnectRef.current.clear();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [activeSessionReady, invitationSessionId, open, sessionManager, snapshot.sessions]);

  useEffect(() => {
    if (!invitationSession) return;
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
    if (!activeSessionReady) return;
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

  useEffect(() => {
    if (!open) return;
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

  if (activeSessionReady) {
    return null;
  }

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

        <p className="mt-3 text-sm text-slate-300">Scan the QR code below with your signer, or copy the link below.</p>

        <div className="mt-4 space-y-6">
          <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            {invitationError ? <div className="text-xs text-rose-400">{invitationError}</div> : null}
            <div className="mt-4 flex flex-col items-center gap-4">
              <div className="flex flex-col items-center gap-2">
                <div className="flex h-48 w-48 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt="nostrconnect invitation" className="h-full w-full rounded-md" />
                  ) : invitationBusy ? (
                    <span className="text-xs text-slate-400">Preparing QR…</span>
                  ) : (
                    <span className="text-xs text-slate-400">Waiting for link…</span>
                  )}
                </div>
                {qrError ? <div className="text-[11px] text-rose-400">{qrError}</div> : null}
                <button
                  type="button"
                  onClick={() => void handleCopyInvitation()}
                  disabled={!invitationUri}
                  className="w-full break-all rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-emerald-300 hover:border-emerald-500 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                  title={invitationUri ?? "Invitation link not ready"}
                >
                  {invitationUri ?? "Generating invitation…"}
                </button>
                {copied ? <div className="text-[11px] text-emerald-300">Link copied to clipboard</div> : null}
                {invitationSession?.relays.length ? (
                  <div className="text-center text-[11px] text-slate-400">
                    Relays: {invitationSession.relays.join(", ")}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void generateInvitation()}
                disabled={invitationBusy}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-600 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {invitationBusy ? "Generating…" : "Regenerate link"}
              </button>
            </div>
          </section>
        </div>

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
                    Status: {session.userPubkey && !session.lastError ? "active" : session.status}
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
