// Node 20+ ships an experimental native `localStorage` global gated behind
// `--localstorage-file`. Without that flag it's present but non-functional,
// and jsdom sees `"localStorage" in window` already true (window *is*
// globalThis under vitest's jsdom pool) so it skips installing its own
// working implementation, leaving app code's `localStorage.getItem(...)`
// calls throwing on `undefined`. Real browsers have no such ambiguity --
// this is purely a Node-under-test artifact. Install a small in-memory
// polyfill whenever the ambient one isn't a real, working Storage.
if (typeof globalThis.localStorage?.getItem !== "function") {
  class MemoryStorage implements Storage {
    #store = new Map<string, string>();
    get length() {
      return this.#store.size;
    }
    clear() {
      this.#store.clear();
    }
    getItem(key: string) {
      return this.#store.has(key) ? this.#store.get(key)! : null;
    }
    key(index: number) {
      return Array.from(this.#store.keys())[index] ?? null;
    }
    removeItem(key: string) {
      this.#store.delete(key);
    }
    setItem(key: string, value: string) {
      this.#store.set(key, String(value));
    }
  }

  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
      writable: true
    });
  }
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  }) as unknown as MediaQueryList;
}
