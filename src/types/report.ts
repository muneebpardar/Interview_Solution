export type OutboxStatus =
  | 'QUEUED'
  | 'IN_FLIGHT'
  | 'WAITING_RETRY'
  | 'CONFIRMED'
  | 'FAILED_FATAL';

export interface ReportPayload {
  client_report_id: string;
  outlet_name: string;
  finding: string;
  action_needed: string;
  captured_at: string;
  lat: number;
  lng: number;
}

export interface OutboxItem extends ReportPayload {
  status: OutboxStatus;
  server_report_id: string | null;
  retry_count: number;
  next_retry_at: number; // Unix timestamp ms
  last_error: string | null;
  created_at: number; // Unix timestamp ms
}

export interface QueueStats {
  total: number;
  queued: number;
  in_flight: number;
  waiting_retry: number;
  confirmed: number;
  failed_fatal: number;
}

export interface ServerDebugCount {
  server_hash: string;
  VERDICT: string;
  distinct_submissions: number;
  reports_stored: number;
  duplicates_created: number;
  duplicate_groups: Array<{ fingerprint: string; stored_copies: number }>;
  used_client_report_id: boolean;
  create_attempts: number;
  stored: number;
  conflicts_409: number;
  injected_failures: number;
  save_then_drop: number;
  rejected_400: number;
  rejected_413: number;
}

export interface SyncLogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'idempotent';
  message: string;
}
