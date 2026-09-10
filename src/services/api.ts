import { NativeModules, Platform } from 'react-native';
import { ReportPayload, ServerDebugCount } from '../types/report';

export type SubmitResult =
  | { kind: 'created'; reportId: string }
  | { kind: 'conflict_resolved'; reportId: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'server_error'; status: number; message: string }
  | { kind: 'fatal_error'; status: number; message: string }
  | { kind: 'network_error'; message: string };

/**
 * Automatically infers the development machine's IP address from Metro scriptURL.
 * This ensures that physical devices running Expo Go over Wi-Fi connect seamlessly
 * to the mock server running on port 4000 without requiring manual IP entry.
 */
export function getDefaultServerUrl(): string {
  try {
    const scriptURL = (NativeModules as any)?.SourceCode?.scriptURL;
    if (typeof scriptURL === 'string') {
      const match = scriptURL.match(/https?:\/\/([^/:]+)/);
      const host = match ? match[1] : null;
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        return `http://${host}:4000`;
      }
    }
  } catch {}

  // Fallback: Android Emulator uses 10.0.2.2; iOS / Web uses localhost.
  return Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
}

export const DEFAULT_SERVER_URL = getDefaultServerUrl();

class ApiClient {
  private baseUrl: string = getDefaultServerUrl();

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Submits a field report to POST /v1/reports with a 10-second AbortController watchdog.
   */
  async submitReport(payload: ReportPayload): Promise<SubmitResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${this.baseUrl}/v1/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_report_id: payload.client_report_id,
          outlet_name: payload.outlet_name,
          finding: payload.finding,
          action_needed: payload.action_needed,
          captured_at: payload.captured_at,
          lat: payload.lat,
          lng: payload.lng,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const status = response.status;
      let data: any = {};
      try {
        data = await response.json();
      } catch {
        // empty or non-JSON body
      }

      if (status === 201) {
        return {
          kind: 'created',
          reportId: data.report_id,
        };
      }

      if (status === 409) {
        // CRITICAL: The server already received and saved this exact client_report_id
        // during an earlier save_then_drop or dropped connection!
        return {
          kind: 'conflict_resolved',
          reportId: data.report_id,
        };
      }

      if (status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 3;
        return {
          kind: 'rate_limited',
          retryAfterSeconds: isNaN(seconds) ? 3 : seconds,
        };
      }

      if (status === 400 || status === 413) {
        return {
          kind: 'fatal_error',
          status,
          message: data.error || `HTTP ${status} Client Error`,
        };
      }

      if (status >= 500 && status < 600) {
        return {
          kind: 'server_error',
          status,
          message: data.error || `HTTP ${status} Server Error`,
        };
      }

      return {
        kind: 'server_error',
        status,
        message: `Unexpected status HTTP ${status}`,
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      const isAbort = err.name === 'AbortError';
      const message = isAbort
        ? 'Request timed out after 10s'
        : err.message || 'Network request failed';

      return {
        kind: 'network_error',
        message,
      };
    }
  }

  /**
   * Fetches mock server debug assessment metrics.
   */
  async fetchDebugCount(): Promise<ServerDebugCount> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
      const response = await fetch(`${this.baseUrl}/v1/_debug/count`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err: any) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Resets mock server state between test runs.
   */
  async resetServer(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/_debug/reset`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Failed to reset server: HTTP ${response.status}`);
    }
  }
}

export const apiClient = new ApiClient();
