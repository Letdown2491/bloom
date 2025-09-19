export type Listener = (...args: any[]) => Promise<unknown> | unknown;

type EventKey = string | symbol;

interface ListenerEntry {
  original: Listener;
  wrapped: Listener;
  once: boolean;
}

export type DefaultEventMap = Record<EventKey, Listener>;

export interface IEventEmitter<EventMap extends DefaultEventMap = DefaultEventMap> {
  emit<EventName extends keyof EventMap>(event: EventName, ...args: Parameters<EventMap[EventName]>): boolean;
  on<EventName extends keyof EventMap>(event: EventName, listener: EventMap[EventName]): this;
  once<EventName extends keyof EventMap>(event: EventName, listener: EventMap[EventName]): this;
  addListener<EventName extends keyof EventMap>(event: EventName, listener: EventMap[EventName]): this;
  removeListener<EventName extends keyof EventMap>(event: EventName, listener: EventMap[EventName]): this;
  prependListener<EventName extends keyof EventMap>(event: EventName, listener: EventMap[EventName]): this;
  prependOnceListener<EventName extends keyof EventMap>(event: EventName, listener: EventMap[EventName]): this;
  off<EventName extends keyof EventMap>(event: EventName, listener: EventMap[EventName]): this;
  removeAllListeners<EventName extends keyof EventMap>(event?: EventName): this;
  setMaxListeners(n: number): this;
  getMaxListeners(): number;
  listeners<EventName extends keyof EventMap>(event: EventName): EventMap[EventName][];
  rawListeners<EventName extends keyof EventMap>(event: EventName): EventMap[EventName][];
  eventNames(): Array<keyof EventMap>;
  listenerCount<EventName extends keyof EventMap>(event: EventName): number;
}

const warnMaxListeners = (count: number, max: number, event: EventKey) => {
  if (max !== Infinity && count > max) {
    console.warn(`Maximum event listeners for "${String(event)}" event!`);
  }
};

export class EventEmitter<EventMap extends DefaultEventMap = DefaultEventMap>
  implements IEventEmitter<EventMap>
{
  public maxListeners = Infinity;

  private registry = new Map<EventKey, ListenerEntry[]>();
  private boundRefs?: WeakMap<Listener, Listener>;

  emit<EventName extends keyof EventMap>(
    event: EventName,
    ...args: Parameters<EventMap[EventName]>
  ): boolean {
    const store = this.registry.get(event as EventKey);
    if (!store || store.length === 0) return false;

    // copy to prevent issues if listeners mutate the collection
    const entries = [...store];
    for (const entry of entries) {
      if (entry.once) {
        this.removeListener(event, entry.wrapped as EventMap[EventName]);
      }
      entry.wrapped.apply(this, args as unknown as any[]);
    }
    return true;
  }

  on<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName]
  ): this {
    return this.addEntry(event, listener, false, false);
  }

  once<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName]
  ): this {
    return this.addEntry(event, listener, true, false);
  }

  addListener<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName]
  ): this {
    return this.on(event, listener);
  }

  prependListener<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName]
  ): this {
    return this.addEntry(event, listener, false, true);
  }

  prependOnceListener<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName]
  ): this {
    return this.addEntry(event, listener, true, true);
  }

  removeListener<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName]
  ): this {
    const store = this.registry.get(event as EventKey);
    if (!store) return this;

    const idx = store.findIndex(
      (entry) => entry.original === listener || entry.wrapped === listener
    );

    if (idx !== -1) {
      store.splice(idx, 1);
      if (store.length === 0) this.registry.delete(event as EventKey);
    }

    return this;
  }

  off<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName]
  ): this {
    return this.removeListener(event, listener);
  }

  removeAllListeners<EventName extends keyof EventMap>(event?: EventName): this {
    if (event === undefined) {
      this.registry.clear();
      this.boundRefs = undefined;
    } else {
      this.registry.delete(event as EventKey);
    }
    return this;
  }

  setMaxListeners(n: number): this {
    this.maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return this.maxListeners;
  }

  listeners<EventName extends keyof EventMap>(event: EventName): EventMap[EventName][] {
    const store = this.registry.get(event as EventKey);
    if (!store) return [];
    return store.map((entry) =>
      (entry.once ? entry.wrapped : entry.original) as EventMap[EventName]
    );
  }

  rawListeners<EventName extends keyof EventMap>(
    event: EventName
  ): EventMap[EventName][] {
    const store = this.registry.get(event as EventKey);
    if (!store) return [];
    return store.map((entry) => entry.wrapped as EventMap[EventName]);
  }

  eventNames(): Array<keyof EventMap> {
    return Array.from(this.registry.keys()) as Array<keyof EventMap>;
  }

  listenerCount<EventName extends keyof EventMap>(event: EventName): number {
    const store = this.registry.get(event as EventKey);
    return store ? store.length : 0;
  }

  hasListeners<EventName extends keyof EventMap>(event: EventName): boolean {
    return this.listenerCount(event) > 0;
  }

  addListenerBound<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName],
    bindTo: unknown = this
  ): this {
    const bound = (listener as Listener).bind(bindTo);
    this.boundRefs ??= new WeakMap();
    this.boundRefs.set(listener as Listener, bound);
    return this.addListener(event, bound as EventMap[EventName]);
  }

  removeListenerBound<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName]
  ): this {
    const bound = this.boundRefs?.get(listener as Listener);
    if (bound) {
      this.boundRefs?.delete(listener as Listener);
      return this.removeListener(event, bound as EventMap[EventName]);
    }
    return this.removeListener(event, listener);
  }

  private addEntry<EventName extends keyof EventMap>(
    event: EventName,
    listener: EventMap[EventName],
    once: boolean,
    prepend: boolean
  ): this {
    const store = this.ensureStore(event as EventKey);
    const original = listener as unknown as Listener;
    const wrapped = once
      ? this.createOnceWrapper(event as EventKey, original)
      : original;
    const entry: ListenerEntry = { original, wrapped, once };
    if (prepend) store.unshift(entry);
    else store.push(entry);
    warnMaxListeners(store.length, this.maxListeners, event as EventKey);
    return this;
  }

  private ensureStore(event: EventKey): ListenerEntry[] {
    let store = this.registry.get(event);
    if (!store) {
      store = [];
      this.registry.set(event, store);
    }
    return store;
  }

  private createOnceWrapper(event: EventKey, listener: Listener): Listener {
    const emitter = this;
    const wrapped: Listener = function (this: unknown, ...args: any[]) {
      emitter.removeListener(event as never, wrapped as never);
      return listener.apply(this, args);
    };

    Object.defineProperty(wrapped, "listener", {
      value: listener,
      configurable: true,
    });

    return wrapped;
  }
}

export class EventEmitterSafe<EventMap extends DefaultEventMap = DefaultEventMap> extends EventEmitter<EventMap> {}
