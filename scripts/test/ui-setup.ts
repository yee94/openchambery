// UI unit tests must provide their own network responses. Reject unmocked requests
// instead of letting happy-dom connect to a real service during module imports.
const localFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    window.location.href,
  );
  // Attachment decoding is local and still uses happy-dom's real fetch behavior.
  if (url.protocol === 'data:' || url.protocol === 'blob:') {
    return localFetch(input, init);
  }
  throw new TypeError('Unmocked fetch in UI test; provide a fetch mock for this request.');
};

// happy-dom owns window/document. Only make navigator assignable so
// event-pipeline tests can do `globalThis.navigator = { onLine: false }`.
const current = globalThis.navigator;
let navigatorValue: Navigator | { onLine: boolean } = current ?? { onLine: true };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  enumerable: true,
  get() {
    return navigatorValue;
  },
  set(value) {
    navigatorValue = value;
  },
});
