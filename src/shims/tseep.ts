export type Listener = (...args: unknown[]) => void;

type EventKey = string | symbol;

type WrappedListener = Listener & { __originalListener__?: Listener };

const cloneListeners = (listeners: WrappedListener[] | undefined) =>
  listeners ? listeners.slice() : [];

const unwrapListener = (listener: WrappedListener) => listener.__originalListener__ ?? listener;

class EventEmitter {
  private listenersByEvent = new Map<EventKey, WrappedListener[]>();
  private maxListeners = Infinity;

  setMaxListeners(n: number): this {
    if (Number.isFinite(n) && n >= 0) {
      this.maxListeners = n;
    }
    return this;
  }

  getMaxListeners(): number {
    return this.maxListeners;
  }

  eventNames(): EventKey[] {
    return Array.from(this.listenersByEvent.keys());
  }

  listeners(event: EventKey): Listener[] {
    return cloneListeners(this.listenersByEvent.get(event)).map(unwrapListener);
  }

  rawListeners(event: EventKey): Listener[] {
    return this.listeners(event);
  }

  listenerCount(event: EventKey): number {
    return this.listenersByEvent.get(event)?.length ?? 0;
  }

  addListener(event: EventKey, listener: Listener): this {
    return this.addInternal(event, listener as WrappedListener, false);
  }

  on(event: EventKey, listener: Listener): this {
    return this.addListener(event, listener);
  }

  once(event: EventKey, listener: Listener): this {
    const wrapped: WrappedListener = ((...args: unknown[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    }) as WrappedListener;
    wrapped.__originalListener__ = listener;
    return this.addInternal(event, wrapped, false);
  }

  prependListener(event: EventKey, listener: Listener): this {
    return this.addInternal(event, listener as WrappedListener, true);
  }

  prependOnceListener(event: EventKey, listener: Listener): this {
    const wrapped: WrappedListener = ((...args: unknown[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    }) as WrappedListener;
    wrapped.__originalListener__ = listener;
    return this.addInternal(event, wrapped, true);
  }

  off(event: EventKey, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  removeListener(event: EventKey, listener: Listener): this {
    const listeners = this.listenersByEvent.get(event);
    if (!listeners || listeners.length === 0) return this;
    const filtered = listeners.filter(existing => unwrapListener(existing) !== listener);
    if (filtered.length > 0) {
      this.listenersByEvent.set(event, filtered);
    } else {
      this.listenersByEvent.delete(event);
    }
    return this;
  }

  removeAllListeners(event?: EventKey): this {
    if (typeof event === "undefined") {
      this.listenersByEvent.clear();
    } else {
      this.listenersByEvent.delete(event);
    }
    return this;
  }

  emit(event: EventKey, ...args: unknown[]): boolean {
    const listeners = cloneListeners(this.listenersByEvent.get(event));
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      listener(...args);
    }
    return true;
  }

  private addInternal(event: EventKey, listener: WrappedListener, prepend: boolean): this {
    const listeners = this.listenersByEvent.get(event) ?? [];
    if (prepend) {
      listeners.unshift(listener);
    } else {
      listeners.push(listener);
    }
    this.listenersByEvent.set(event, listeners);
    if (Number.isFinite(this.maxListeners) && listeners.length > this.maxListeners) {
      // Silently ignore for browser parity; Node would warn, but we keep it minimal.
    }
    return this;
  }
}

const exported = { EventEmitter };

export { EventEmitter };
export default exported;
