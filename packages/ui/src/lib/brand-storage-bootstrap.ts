import { migrateBrandLocalStorage } from './brand-storage-migration';

// Imported before storage consumers evaluate, including non-React runtime entries.
// Cross-origin export/import belongs to the native shell, not browser storage.
if (typeof window !== 'undefined') {
  const storage = (() => {
    try { return window.localStorage; } catch { return null; }
  })();
  if (storage) {
    const result = migrateBrandLocalStorage(storage);
    if (result.failed.length) {
      // Fail closed: mounting empty stores could overwrite recoverable draft metadata.
      throw new Error(`Yuri storage migration needs retry (${result.failed.length} keys). Original data is preserved.`);
    }
  }
}
