import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from 'vitest';

const withDefaultExport = (exports: unknown) => {
  if (!exports || typeof exports !== 'object' || 'default' in exports) {
    return exports;
  }
  return { ...exports, default: exports };
};

const mock = Object.assign(
  <T extends (...args: never[]) => unknown>(implementation?: T) => vi.fn(implementation),
  {
    // bun:test mock.module is runtime and pairs with a later dynamic import.
    // vi.mock is compile-time hoisted and would break factory closures.
    module: (id: string, factory?: () => Record<string, unknown>) => {
      const impl = factory
        ? () => withDefaultExport(factory()) as Record<string, unknown>
        : undefined;
      const ids = [id];
      if (id.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(id)) {
        ids.push(`${id}.ts`, `${id}.js`);
      }
      for (const specifier of ids) {
        vi.doMock(specifier, impl);
      }
    },
    restore: () => vi.restoreAllMocks(),
    clearAllMocks: () => vi.clearAllMocks(),
  },
);

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  test,
  vi,
};
