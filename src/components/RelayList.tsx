import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { useNdk, type RelayHealth } from "../context/NdkContext";
import { usePreferredRelays, type RelayPolicy } from "../hooks/usePreferredRelays";
import { normalizeRelayOrigin, sanitizeRelayUrl } from "../utils/relays";
import type { EventTemplate } from "../lib/blossomClient";
import { SaveIcon, TrashIcon, CancelIcon, EditIcon } from "./icons";

const statusStyles: Record<RelayHealth["status"], { label: string; dot: string; text: string }> = {
  error: {
    label: "Offline",
    dot: "bg-red-500",
    text: "text-red-300",
  },
  connecting: {
    label: "Connecting",
    dot: "bg-amber-500 animate-pulse",
    text: "text-amber-300",
  },
  connected: {
    label: "Connected",
    dot: "bg-emerald-500",
    text: "text-emerald-300",
  },
};

const UNKNOWN_STATUS_STYLE = {
  label: "Unknown",
  dot: "bg-slate-600",
  text: "text-slate-400",
};


const createDraftId = () => `relay-${Math.random().toString(36).slice(2)}-${Date.now()}`;

type RelayDraft = {
  id: string;
  url: string;
  read: boolean;
  write: boolean;
};

const policiesToDrafts = (policies: RelayPolicy[]): RelayDraft[] =>
  policies.map(policy => ({
    id: policy.url,
    url: policy.url,
    read: policy.read,
    write: policy.write,
  }));

const normalizePolicies = (policies: RelayPolicy[]) =>
  policies
    .map(policy => ({
      url: sanitizeRelayUrl(policy.url),
      read: Boolean(policy.read),
      write: Boolean(policy.write),
    }))
    .filter((policy): policy is { url: string; read: boolean; write: boolean } => Boolean(policy.url))
    .map(policy => ({
      url: policy.url,
      read: policy.read,
      write: policy.write,
    }))
    .sort((a, b) => a.url.localeCompare(b.url));

const normalizeDrafts = (drafts: RelayDraft[]) => {
  const seen = new Set<string>();
  const entries: RelayPolicy[] = [];
  drafts.forEach(draft => {
    const url = sanitizeRelayUrl(draft.url);
    if (!url) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    if (!draft.read && !draft.write) return;
    seen.add(key);
    entries.push({ url, read: draft.read, write: draft.write });
  });
  return normalizePolicies(entries);
};

const diffPolicies = (drafts: RelayDraft[], policies: RelayPolicy[]) => {
  const normalizedDrafts = normalizeDrafts(drafts);
  const normalizedPolicies = normalizePolicies(policies);
  if (normalizedDrafts.length !== normalizedPolicies.length) return true;
  for (let index = 0; index < normalizedDrafts.length; index += 1) {
    const a = normalizedDrafts[index];
    const b = normalizedPolicies[index];
    if (!a || !b) return true;
    if (a.url !== b.url || a.read !== b.read || a.write !== b.write) return true;
  }
  return false;
};

const buildNip65Template = (policies: RelayPolicy[]): EventTemplate => {
  const tags: string[][] = policies.map(policy => {
    if (policy.read && policy.write) return ["r", policy.url];
    if (policy.read && !policy.write) return ["r", policy.url, "read"];
    if (!policy.read && policy.write) return ["r", policy.url, "write"];
    return ["r", policy.url];
  });
  return {
    kind: 10002,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags,
  };
};

const RelayList: React.FC = () => {
  const { relayPolicies, loading, refresh } = usePreferredRelays();
  const { relayHealth, ndk, signer } = useNdk();
  const [drafts, setDrafts] = useState<RelayDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"success" | "error" | "info">("info");
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingSnapshotRef = useRef<RelayDraft | null>(null);

  useEffect(() => {
    setDrafts(policiesToDrafts(relayPolicies));
  }, [relayPolicies]);

  const healthMap = useMemo(() => {
    const map = new Map<string, RelayHealth>();
    relayHealth.forEach(entry => {
      const normalized = normalizeRelayOrigin(entry.url) ?? sanitizeRelayUrl(entry.url);
      if (normalized) map.set(normalized, entry);
    });
    return map;
  }, [relayHealth]);

  const validationErrors = useMemo(() => {
    const errors = new Map<string, string>();
    const seen = new Map<string, string>();
    drafts.forEach(draft => {
      const sanitized = sanitizeRelayUrl(draft.url);
      if (!sanitized) {
        errors.set(draft.id, "Enter a valid wss:// URL.");
        return;
      }
      const key = sanitized.toLowerCase();
      const previousId = seen.get(key);
      if (previousId) {
        errors.set(previousId, "Duplicate relay URL.");
        errors.set(draft.id, "Duplicate relay URL.");
      } else {
        seen.set(key, draft.id);
      }
      if (!draft.read && !draft.write) {
        errors.set(draft.id, "Enable read or write access.");
      }
    });
    return errors;
  }, [drafts]);

  const hasChanges = useMemo(() => diffPolicies(drafts, relayPolicies), [drafts, relayPolicies]);
  const hasValidationError = validationErrors.size > 0;
  const canEdit = Boolean(signer && ndk);

  const setDraftField = useCallback(
    (id: string, patch: Partial<RelayDraft>) => {
      setDrafts(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)));
    },
    []
  );

  const handleAddRelay = () => {
    setMessage(null);
    const id = createDraftId();
    setDrafts(prev => [
      ...prev,
      {
        id,
        url: "wss://",
        read: true,
        write: true,
      },
    ]);
    editingSnapshotRef.current = null;
    setEditingId(id);
  };

  const handleRemoveRelay = (id: string) => {
    setMessage(null);
    setDrafts(prev => prev.filter(item => item.id !== id));
    if (editingId === id) {
      setEditingId(null);
      editingSnapshotRef.current = null;
    }
  };

  const saveDisabled = !canEdit || saving || !hasChanges || hasValidationError;

  const beginEdit = (id: string) => {
    if (!canEdit) return;
    setMessage(null);
    const current = drafts.find(item => item.id === id);
    editingSnapshotRef.current = current ? { ...current } : null;
    setEditingId(id);
  };

  const handleEditCancel = () => {
    if (!editingId) return;
    const snapshot = editingSnapshotRef.current;
    setDrafts(prev => {
      if (!snapshot) {
        return prev.filter(item => item.id !== editingId);
      }
      return prev.map(item => (item.id === editingId ? snapshot : item));
    });
    setEditingId(null);
    editingSnapshotRef.current = null;
  };

  const handleEditSubmit = () => {
    if (!editingId) return;
    const validationMessage = validationErrors.get(editingId);
    if (validationMessage) {
      setMessage(validationMessage);
      setMessageTone("error");
      return;
    }
    setMessage(null);
    setDrafts(prev =>
      prev.map(item => {
        if (item.id !== editingId) return item;
        const sanitized = sanitizeRelayUrl(item.url) ?? item.url;
        return { ...item, url: sanitized };
      })
    );
    setEditingId(null);
    editingSnapshotRef.current = null;
  };

  const handleSave = async () => {
    if (saveDisabled) return;
    if (!ndk) {
      setMessage("NDK is not ready.");
      setMessageTone("error");
      return;
    }
    setMessage(null);
    setMessageTone("info");

    const normalized = normalizeDrafts(drafts);
    setSaving(true);
    try {
      const template = buildNip65Template(normalized);
      const event = new NDKEvent(ndk, template);
      if (!event.created_at) {
        event.created_at = Math.floor(Date.now() / 1000);
      }
      await event.sign();
      await event.publish();
      setMessage("Relay preferences saved.");
      setMessageTone("success");
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save relays.";
      setMessage(message);
      setMessageTone("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 flex-1 min-h-0">
      <header className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Relays</h2>
          <p className="text-xs text-slate-400">Publish your preferred relays (NIP-65) and monitor their status.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleAddRelay}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!canEdit}
          >
            Add relay
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={saveDisabled}
          >
            <SaveIcon size={16} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {!canEdit && (
        <div className="mb-3 rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs text-slate-300" role="alert">
          Connect your signer to publish relay preferences.
        </div>
      )}

      {message && (
        <div
          className={`mb-3 rounded-xl border px-3 py-2 text-xs ${
            messageTone === "success"
              ? "border-emerald-600/40 bg-emerald-500/5 text-emerald-200"
              : messageTone === "error"
              ? "border-red-600/40 bg-red-500/5 text-red-200"
              : "border-slate-700 bg-slate-900/60 text-slate-300"
          }`}
          role="alert"
        >
          {message}
        </div>
      )}

      {loading && drafts.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-6 text-sm text-slate-300">
          Loading relay preferences…
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full table-fixed text-sm text-slate-300">
            <thead className="text-[11px] uppercase tracking-wide text-slate-300">
              <tr>
                <th scope="col" className="py-2 px-3 text-left font-semibold">Relay</th>
                <th scope="col" className="w-48 py-2 px-3 text-left font-semibold">Status</th>
                <th scope="col" className="w-24 py-2 px-3 text-center font-semibold">Read</th>
                <th scope="col" className="w-24 py-2 px-3 text-center font-semibold">Write</th>
                <th scope="col" className="w-20 py-2 px-3 text-center font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {drafts.length === 0 ? (
                <tr className="border-t border-slate-800">
                  <td colSpan={5} className="py-6 px-3 text-center text-sm text-slate-400">
                    No relays configured yet. Add a relay to get started.
                  </td>
                </tr>
              ) : (
                drafts.map(draft => {
                  const sanitized = sanitizeRelayUrl(draft.url);
                  const normalized = sanitized ? normalizeRelayOrigin(sanitized) ?? sanitized : null;
                  const health = normalized ? healthMap.get(normalized) : undefined;
                  const style = health ? statusStyles[health.status] : UNKNOWN_STATUS_STYLE;
                  const validationMessage = validationErrors.get(draft.id) ?? null;
                  const isEditing = editingId === draft.id;

                  if (isEditing) {
                    return (
                      <tr key={draft.id} className="border-t border-slate-800 align-top">
                        <td className="py-3 px-3">
                          <input
                            type="text"
                            value={draft.url}
                            onChange={event => setDraftField(draft.id, { url: event.target.value })}
                            className={`w-full rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none bg-slate-900 ${
                              validationMessage ? "border border-red-700" : "border border-slate-700"
                            }`}
                            placeholder="wss://relay.example.com"
                            autoComplete="off"
                            spellCheck={false}
                          />
                          {validationMessage ? (
                            <p className="mt-1 text-[11px] text-red-300">{validationMessage}</p>
                          ) : null}
                        </td>
                        <td className="py-3 px-3 text-xs">
                          <div className={`inline-flex items-center gap-2 ${style.text}`}>
                            <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden />
                            {style.label}
                          </div>
                        </td>
                        <td className="py-3 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={draft.read}
                            onChange={event => setDraftField(draft.id, { read: event.target.checked })}
                          />
                        </td>
                        <td className="py-3 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={draft.write}
                            onChange={event => setDraftField(draft.id, { write: event.target.checked })}
                          />
                        </td>
                        <td className="py-3 px-3 text-center">
                          <div className="flex justify-center gap-2">
                            <button
                              type="button"
                              onClick={handleEditSubmit}
                              className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-2 py-2 text-slate-50 hover:bg-emerald-500"
                              aria-label="Save relay"
                            >
                              <SaveIcon size={16} />
                            </button>
                            <button
                              type="button"
                              onClick={handleEditCancel}
                              className="inline-flex items-center justify-center rounded-lg bg-slate-800 px-2 py-2 text-slate-200 hover:bg-slate-700"
                              aria-label="Cancel editing"
                            >
                              <CancelIcon size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={draft.id} className="border-t border-slate-800 align-top">
                      <td className="py-3 px-3 text-slate-100">
                        <div className="flex flex-col">
                          <span className="break-all text-sm">{sanitized ?? draft.url}</span>
                          {validationMessage ? (
                            <p className="mt-1 text-[11px] text-red-300">{validationMessage}</p>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-xs">
                        <div className={`inline-flex items-center gap-2 ${style.text}`}>
                          <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden />
                          {style.label}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <input
                          type="checkbox"
                          checked={draft.read}
                          onChange={event => setDraftField(draft.id, { read: event.target.checked })}
                          disabled={!canEdit}
                        />
                      </td>
                      <td className="py-3 px-3 text-center">
                        <input
                          type="checkbox"
                          checked={draft.write}
                          onChange={event => setDraftField(draft.id, { write: event.target.checked })}
                          disabled={!canEdit}
                        />
                      </td>
                      <td className="py-3 px-3 text-center">
                        <div className="flex justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => beginEdit(draft.id)}
                            className="inline-flex items-center justify-center rounded-lg bg-slate-800 px-2 py-2 text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            disabled={!canEdit}
                            aria-label="Edit relay"
                          >
                            <EditIcon size={16} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveRelay(draft.id)}
                            className="inline-flex items-center justify-center rounded-lg bg-red-900/80 px-2 py-2 text-slate-100 hover:bg-red-800 disabled:opacity-40 disabled:cursor-not-allowed"
                            disabled={!canEdit}
                            aria-label="Remove relay"
                          >
                            <TrashIcon size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

export { RelayList };
export default RelayList;
