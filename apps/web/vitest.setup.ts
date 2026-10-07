localStorage.setItem("intrica:language", "zh-CN");
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (typeof globalThis.EventSource === "undefined") {
  class EventSourceStub {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly readyState = 2;
    readonly url = "";
    readonly withCredentials = false;
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return true;
    }
  }
  globalThis.EventSource = EventSourceStub as unknown as typeof EventSource;
}
