import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../lib/logger.js';
import { MIGRATIONS } from './migrations.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

let instance: Db | null = null;
let raw: Database.Database | null = null;

export class DatabaseUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * Opens (and on first run creates) the SQLite file, then applies any pending
 * migrations. Any failure is surfaced as DatabaseUnavailableError so routes can
 * return an honest 503 instead of a stack trace.
 */
export function initDb(databasePath: string): Db {
  if (instance) return instance;
  const absolute = resolve(databasePath);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    const connection = new Database(absolute);
    // WAL keeps reads from blocking the writer, which matters because the scanner
    // writes snapshots while the UI is reading.
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    applyMigrations(connection);
    raw = connection;
    instance = drizzle(connection, { schema }) as Db;
    logger.info('database ready', { path: absolute });
    return instance;
  } catch (error) {
    throw new DatabaseUnavailableError(
      `Could not open the database at ${absolute}. Check the path is writable.`,
      error,
    );
  }
}

function applyMigrations(connection: Database.Database): void {
  connection.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT 0)',
  );
  const appliedRows = connection.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    const run = connection.transaction(() => {
      connection.exec(migration.sql);
      connection
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now());
    });
    run();
    logger.info('applied migration', { version: migration.version, name: migration.name });
  }
}

export function getDb(): Db {
  if (!instance) {
    throw new DatabaseUnavailableError('Database has not been initialised.');
  }
  return instance;
}

export function getRawDb(): Database.Database {
  if (!raw) {
    throw new DatabaseUnavailableError('Database has not been initialised.');
  }
  return raw;
}

export function closeDb(): void {
  raw?.close();
  raw = null;
  instance = null;
}

export { schema };
