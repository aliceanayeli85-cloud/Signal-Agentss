/** `npm run db:init` - creates the database file and applies migrations, then exits. */
import { env } from '../lib/env.js';
import { closeDb, initDb } from './index.js';
import { seedDefaults } from './seed.js';

try {
  const db = initDb(env.databasePath);
  seedDefaults(db);
  // eslint-disable-next-line no-console
  console.log(`Database initialised at ${env.databasePath}`);
  closeDb();
  process.exit(0);
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('Database initialisation failed:', error);
  process.exit(1);
}
