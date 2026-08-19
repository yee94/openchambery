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
