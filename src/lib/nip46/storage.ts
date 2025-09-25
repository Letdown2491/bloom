import { SessionSnapshot } from "./session";

export interface StorageAdapter {
  load: () => Promise<SessionSnapshot | null>;
  save: (snapshot: SessionSnapshot) => Promise<void>;
}

const STORAGE_KEY = "bloom.nip46.sessions.v1";

const isQuotaExceededError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" || error.code === 22 || error.name === "NS_ERROR_DOM_QUOTA_REACHED");

export class LocalStorageAdapter implements StorageAdapter {
  private blocked = false;

  async load(): Promise<SessionSnapshot | null> {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const snapshot = parsed as SessionSnapshot;
      if (!Array.isArray(snapshot.sessions)) return null;
      return snapshot;
    } catch (error) {
      console.warn("Failed to load NIP-46 sessions", error);
      return null;
    }
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    if (typeof window === "undefined" || this.blocked) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      if (isQuotaExceededError(error)) {
        this.blocked = true;
        console.warn("Disabling NIP-46 session persistence due to storage quota");
        return;
      }
      console.warn("Failed to persist NIP-46 sessions", error);
    }
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  private snapshot: SessionSnapshot | null = null;

  async load(): Promise<SessionSnapshot | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}
