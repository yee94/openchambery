import { migrateHostBrandData } from './brand-migration.js';

// Synchronous ESM dependency runs before storage owners initialize credentials.
const results = migrateHostBrandData();
const failed = results.filter((result) => result.status === 'failed');
if (failed.length) {
  throw new Error(`Yuri Host migration incomplete: ${failed.map(({ resource, code }) => `${resource} (${code})`).join(', ')}. Old data is preserved; correct permissions or invalid data and retry.`);
}
