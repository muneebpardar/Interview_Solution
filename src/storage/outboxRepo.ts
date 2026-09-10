import { getDatabase } from './db';
import { OutboxItem, QueueStats, ReportPayload } from '../types/report';

export class OutboxRepository {
  /**
   * Inserts a newly captured report into the outbox with status 'QUEUED'.
   * The client_report_id must already be set so that it is immutable across retries.
   */
  async enqueue(payload: ReportPayload): Promise<OutboxItem> {
    const db = await getDatabase();
    const now = Date.now();

    const item: OutboxItem = {
      ...payload,
      status: 'QUEUED',
      server_report_id: null,
      retry_count: 0,
      next_retry_at: 0,
      last_error: null,
      created_at: now,
    };

    await db.runAsync(
      `INSERT INTO outbox (
        client_report_id, outlet_name, finding, action_needed,
        captured_at, lat, lng, status, server_report_id,
        retry_count, next_retry_at, last_error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.client_report_id,
        item.outlet_name,
        item.finding,
        item.action_needed,
        item.captured_at,
        item.lat,
        item.lng,
        item.status,
        item.server_report_id,
        item.retry_count,
        item.next_retry_at,
        item.last_error,
        item.created_at,
      ]
    );

    return item;
  }

  /**
   * Fetches the next eligible item for dispatch:
   * Status is either QUEUED or WAITING_RETRY, and next_retry_at is <= current timestamp.
   * Dispatched in FIFO order by created_at.
   */
  async getNextPendingItem(now: number = Date.now()): Promise<OutboxItem | null> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<OutboxItem>(
      `SELECT * FROM outbox 
       WHERE status IN ('QUEUED', 'WAITING_RETRY') 
         AND next_retry_at <= ?
       ORDER BY created_at ASC 
       LIMIT 1`,
      [now]
    );
    return row || null;
  }

  /**
   * Transitions an item to IN_FLIGHT.
   */
  async markInFlight(clientReportId: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE outbox SET status = 'IN_FLIGHT' WHERE client_report_id = ?`,
      [clientReportId]
    );
  }

  /**
   * Transitions an item to CONFIRMED and attaches the confirmed server_report_id.
   */
  async markConfirmed(clientReportId: string, serverReportId: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE outbox 
       SET status = 'CONFIRMED', 
           server_report_id = ?, 
           last_error = NULL 
       WHERE client_report_id = ?`,
      [serverReportId, clientReportId]
    );
  }

  /**
   * Transitions an item to WAITING_RETRY, schedules next_retry_at, and increments retry_count.
   */
  async markRetry(
    clientReportId: string,
    delayMs: number,
    error: string
  ): Promise<void> {
    const db = await getDatabase();
    const nextRetryAt = Date.now() + delayMs;
    await db.runAsync(
      `UPDATE outbox 
       SET status = 'WAITING_RETRY', 
           retry_count = retry_count + 1, 
           next_retry_at = ?, 
           last_error = ? 
       WHERE client_report_id = ?`,
      [nextRetryAt, error, clientReportId]
    );
  }

  /**
   * Transitions an item to FAILED_FATAL for unrecoverable errors (e.g., HTTP 400).
   */
  async markFatal(clientReportId: string, error: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE outbox 
       SET status = 'FAILED_FATAL', 
           last_error = ? 
       WHERE client_report_id = ?`,
      [error, clientReportId]
    );
  }

  /**
   * Returns all items currently in the outbox, newest first.
   */
  async getAll(): Promise<OutboxItem[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<OutboxItem>(
      `SELECT * FROM outbox ORDER BY created_at DESC`
    );
    return rows;
  }

  /**
   * Returns aggregated queue counts.
   */
  async getStats(): Promise<QueueStats> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM outbox GROUP BY status`
    );

    const stats: QueueStats = {
      total: 0,
      queued: 0,
      in_flight: 0,
      waiting_retry: 0,
      confirmed: 0,
      failed_fatal: 0,
    };

    for (const r of rows) {
      stats.total += r.count;
      if (r.status === 'QUEUED') stats.queued = r.count;
      else if (r.status === 'IN_FLIGHT') stats.in_flight = r.count;
      else if (r.status === 'WAITING_RETRY') stats.waiting_retry = r.count;
      else if (r.status === 'CONFIRMED') stats.confirmed = r.count;
      else if (r.status === 'FAILED_FATAL') stats.failed_fatal = r.count;
    }

    return stats;
  }

  /**
   * Clears the entire outbox table (for reset / testing).
   */
  async clearAll(): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(`DELETE FROM outbox`);
  }
}

export const outboxRepo = new OutboxRepository();
