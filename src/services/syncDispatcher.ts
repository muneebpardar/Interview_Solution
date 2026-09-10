import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { apiClient } from './api';
import { outboxRepo } from '../storage/outboxRepo';
import { SyncLogEntry } from '../types/report';

type Listener = () => void;
type LogListener = (entry: SyncLogEntry) => void;

class SyncDispatcher {
  private isProcessing = false;
  private rerunRequested = false;
  private isOnline = true;
  private isSimulatedOffline = false;
  private timer: any = null;

  private listeners: Set<Listener> = new Set();
  private logListeners: Set<LogListener> = new Set();
  private logs: SyncLogEntry[] = [];

  constructor() {
    // Monitor native connectivity changes
    NetInfo.addEventListener((state: NetInfoState) => {
      const connected = Boolean(state.isConnected && state.isInternetReachable !== false);
      const changed = this.isOnline !== connected;
      this.isOnline = connected;

      if (changed) {
        this.addLog(
          this.isOnline ? 'info' : 'warn',
          `Network status changed: ${this.isOnline ? 'ONLINE' : 'OFFLINE'}`
        );
        if (this.isOnline && !this.isSimulatedOffline) {
          this.notify();
        }
      }
      this.notifyListeners();
    });
  }

  // --- Configuration & State ---

  getNetworkStatus(): { isOnline: boolean; isSimulatedOffline: boolean; effectiveOnline: boolean } {
    return {
      isOnline: this.isOnline,
      isSimulatedOffline: this.isSimulatedOffline,
      effectiveOnline: this.isOnline && !this.isSimulatedOffline,
    };
  }

  setSimulatedOffline(simulated: boolean) {
    this.isSimulatedOffline = simulated;
    this.addLog(
      simulated ? 'warn' : 'info',
      simulated ? 'Simulated Offline Mode ENABLED' : 'Simulated Offline Mode DISABLED'
    );
    this.notifyListeners();
    if (!simulated && this.isOnline) {
      this.notify();
    }
  }

  // --- Subscriptions ---

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  getRecentLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Listener error', err);
      }
    }
  }

  private addLog(type: SyncLogEntry['type'], message: string) {
    const entry: SyncLogEntry = {
      id: Math.random().toString(36).slice(2, 9),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 50) this.logs.pop();

    for (const listener of this.logListeners) {
      try {
        listener(entry);
      } catch (err) {
        console.error('Log listener error', err);
      }
    }
  }

  // --- Dispatch Loop ---

  /**
   * Trigger queue processing. Safe to call concurrently; protected by single-flight mutex
   * with dirty-flag tail checks to ensure rapid enqueues never get missed.
   */
  notify() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.isProcessing) {
      this.rerunRequested = true;
      return;
    }
    this.processQueue();
  }

  private canDispatch(): boolean {
    return this.isOnline && !this.isSimulatedOffline;
  }

  private async processQueue() {
    if (this.isProcessing) {
      this.rerunRequested = true;
      return;
    }

    this.isProcessing = true;
    this.notifyListeners();

    try {
      do {
        this.rerunRequested = false;

        while (this.canDispatch()) {
          const item = await outboxRepo.getNextPendingItem(Date.now());
          if (!item) {
            // No items ready now. Check if any items are scheduled for future retry.
            await this.scheduleWakeupIfPending();
            break;
          }

        // Transition item to IN_FLIGHT
        await outboxRepo.markInFlight(item.client_report_id);
        this.addLog(
          'info',
          `[SYNC] Sending report "${item.outlet_name}" (CID: ${item.client_report_id.slice(0, 8)}...)`
        );
        this.notifyListeners();

        // Dispatch HTTP request
        const result = await apiClient.submitReport(item);

        if (result.kind === 'created') {
          // Success: Report accepted cleanly by server
          await outboxRepo.markConfirmed(item.client_report_id, result.reportId);
          this.addLog(
            'success',
            `[201 CREATED] "${item.outlet_name}" saved as ${result.reportId}`
          );
        } else if (result.kind === 'conflict_resolved') {
          // IDEMPOTENT RECOVERY: The server saved this during a previous save_then_drop socket drop!
          await outboxRepo.markConfirmed(item.client_report_id, result.reportId);
          this.addLog(
            'idempotent',
            `[409 CONFLICT] Idempotent recovery! "${item.outlet_name}" was already stored as ${result.reportId}`
          );
        } else if (result.kind === 'rate_limited') {
          // HTTP 429: Rate limited; honor Retry-After
          const delayMs = result.retryAfterSeconds * 1000;
          await outboxRepo.markRetry(
            item.client_report_id,
            delayMs,
            `Rate limited (429). Retrying after ${result.retryAfterSeconds}s`
          );
          this.addLog(
            'warn',
            `[429 RATE LIMIT] Backing off ${result.retryAfterSeconds}s for "${item.outlet_name}"`
          );
        } else if (result.kind === 'fatal_error') {
          // HTTP 400 or 413: Fatal error; do not retry endlessly
          await outboxRepo.markFatal(item.client_report_id, result.message);
          this.addLog(
            'error',
            `[FATAL ${result.status}] ${result.message} for "${item.outlet_name}"`
          );
        } else {
          // 5xx Server Error or Network Socket Drop (e.g. save_then_drop)
          const delayMs = this.calculateBackoff(item.retry_count);
          const errorDesc =
            result.kind === 'server_error'
              ? `Server Error HTTP ${result.status}`
              : `Network dropped / ${result.message}`;

          await outboxRepo.markRetry(item.client_report_id, delayMs, errorDesc);
          this.addLog(
            'warn',
            `[RETRY NEEDED] ${errorDesc}. Retrying in ${(delayMs / 1000).toFixed(1)}s (Attempt #${item.retry_count + 1})`
          );
        }

        this.notifyListeners();
      }
    } while (this.rerunRequested && this.canDispatch());
    } catch (err: any) {
      console.error('Unexpected queue processing error:', err);
    } finally {
      this.isProcessing = false;
      this.notifyListeners();
    }
  }

  /**
   * Exponential backoff with full jitter to avoid synchronous retry spikes:
   * backoff = random(0, min(maxDelay, baseDelay * 2^retryCount))
   */
  private calculateBackoff(retryCount: number): number {
    const baseDelay = 1500; // 1.5s
    const maxDelay = 15000; // 15s max
    const exponential = Math.min(maxDelay, baseDelay * Math.pow(1.8, Math.min(retryCount, 6)));
    // Full jitter
    return Math.floor(Math.random() * exponential) + 800;
  }

  /**
   * If there are items in WAITING_RETRY scheduled for future times, set a timer.
   */
  private async scheduleWakeupIfPending() {
    const all = await outboxRepo.getAll();
    const waiting = all.filter((i) => i.status === 'WAITING_RETRY' && i.next_retry_at > Date.now());

    if (waiting.length > 0) {
      const earliest = Math.min(...waiting.map((i) => i.next_retry_at));
      const delay = Math.max(earliest - Date.now(), 500);

      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.notify();
      }, delay);
    }
  }
}

export const syncDispatcher = new SyncDispatcher();
