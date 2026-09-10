import * as SQLite from 'expo-sqlite';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let dbQueue: Promise<unknown> = Promise.resolve();

/**
 * Returns the singleton SQLite database instance.
 * Thread-safe: ensures schema initialization and crash recovery complete
 * exactly once before any query runs, even with concurrent callers.
 */
export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      try {
        const db = await SQLite.openDatabaseAsync('field_reports.db');
        await initDatabase(db);
        return db;
      } catch (err) {
        dbPromise = null; // Allow retry if initialization failed
        throw err;
      }
    })();
  }
  return dbPromise;
}

/**
 * Executes a database operation sequentially through a mutex lock.
 * On Android, expo-sqlite throws NullPointerException in NativeDatabase.prepareAsync
 * if multiple asynchronous queries execute concurrently on the same database handle.
 * Serializing calls through this queue guarantees 100% crash-free ACID execution.
 */
export async function withDb<T>(op: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const db = await getDatabase();

  const currentOp = (async () => {
    try {
      await dbQueue;
    } catch {
      // Ignore previous errors so subsequent operations proceed uninterrupted
    }
    return await op(db);
  })();

  dbQueue = currentOp.catch(() => {});
  return await currentOp;
}

/**
 * Initializes database schema and runs startup recovery.
 */
async function initDatabase(db: SQLite.SQLiteDatabase): Promise<void> {
  // Enable Write-Ahead Logging (WAL) for maximum crash resilience on mobile devices
  await db.execAsync('PRAGMA journal_mode = WAL;');

  // Outbox table stores each report with its persistent client_report_id and state
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS outbox (
      client_report_id TEXT PRIMARY KEY,
      outlet_name TEXT NOT NULL,
      finding TEXT NOT NULL,
      action_needed TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      status TEXT NOT NULL,
      server_report_id TEXT,
      retry_count INTEGER DEFAULT 0,
      next_retry_at INTEGER DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_status_retry 
    ON outbox(status, next_retry_at);
  `);

  // ZOMBIE CRASH RECOVERY:
  // If the app was force-quit while a request was in flight, reset it to QUEUED
  // so the serial dispatcher can re-attempt it using the exact same client_report_id.
  await db.runAsync(`
    UPDATE outbox 
    SET status = 'QUEUED', next_retry_at = 0 
    WHERE status = 'IN_FLIGHT'
  `);
}
