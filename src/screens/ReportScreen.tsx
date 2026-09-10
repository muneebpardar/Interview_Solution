import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  Switch,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
} from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import { outboxRepo } from '../storage/outboxRepo';
import { syncDispatcher } from '../services/syncDispatcher';
import { apiClient, DEFAULT_SERVER_URL } from '../services/api';
import { OutboxItem, QueueStats, ServerDebugCount, SyncLogEntry } from '../types/report';

// Karachi default coordinates (as permitted in brief fallback)
const DEFAULT_COORDS = { lat: 24.8607, lng: 67.0011 };

export default function ReportScreen() {
  // --- Form State ---
  const [outletName, setOutletName] = useState('');
  const [finding, setFinding] = useState('');
  const [actionNeeded, setActionNeeded] = useState('');
  const [coords, setCoords] = useState(DEFAULT_COORDS);
  const [useLiveLocation, setUseLiveLocation] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);

  // --- Queue State ---
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [stats, setStats] = useState<QueueStats>({
    total: 0,
    queued: 0,
    in_flight: 0,
    waiting_retry: 0,
    confirmed: 0,
    failed_fatal: 0,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // --- Network & Dispatcher State ---
  const [networkStatus, setNetworkStatus] = useState(syncDispatcher.getNetworkStatus());
  const [logs, setLogs] = useState<SyncLogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  // --- Server Verification State ---
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [showConfig, setShowConfig] = useState(false);
  const [debugResult, setDebugResult] = useState<ServerDebugCount | null>(null);
  const [verifyingServer, setVerifyingServer] = useState(false);

  // Tick for retry countdowns
  const [, setTick] = useState(0);

  const loadData = useCallback(async () => {
    try {
      const [allRows, queueStats] = await Promise.all([
        outboxRepo.getAll(),
        outboxRepo.getStats(),
      ]);
      setItems(allRows);
      setStats(queueStats);
      setNetworkStatus(syncDispatcher.getNetworkStatus());
      setLogs(syncDispatcher.getRecentLogs());
    } catch (err) {
      console.error('Error loading outbox data:', err);
    }
  }, []);

  // Initialize and subscribe
  useEffect(() => {
    loadData();

    // Trigger sync queue on mount
    syncDispatcher.notify();

    // Subscribe to dispatcher events
    const unsubscribe = syncDispatcher.subscribe(() => {
      loadData();
    });

    // 1-second countdown ticker for UI retry timers
    const ticker = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(ticker);
    };
  }, [loadData]);

  // GPS Location handler
  const handleLocationToggle = async (val: boolean) => {
    setUseLiveLocation(val);
    if (!val) {
      setCoords(DEFAULT_COORDS);
      return;
    }

    try {
      setLocationLoading(true);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Location Permission Denied',
          'Using Karachi coordinates (24.8607, 67.0011) as fallback.'
        );
        setCoords(DEFAULT_COORDS);
        setUseLiveLocation(false);
        return;
      }

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setCoords({
        lat: parseFloat(loc.coords.latitude.toFixed(5)),
        lng: parseFloat(loc.coords.longitude.toFixed(5)),
      });
    } catch (err: any) {
      Alert.alert(
        'GPS Acquisition Failed',
        `Falling back to Karachi coordinates: ${err.message}`
      );
      setCoords(DEFAULT_COORDS);
      setUseLiveLocation(false);
    } finally {
      setLocationLoading(false);
    }
  };

  // Form Submission
  const handleSubmit = async () => {
    if (!outletName.trim()) {
      Alert.alert('Validation Error', 'Please enter an outlet name.');
      return;
    }
    if (!finding.trim()) {
      Alert.alert('Validation Error', 'Please specify what you found.');
      return;
    }
    if (!actionNeeded.trim()) {
      Alert.alert('Validation Error', 'Please specify action needed.');
      return;
    }

    try {
      setIsSubmitting(true);

      // 1. Generate immutable client_report_id once at capture time
      const client_report_id = Crypto.randomUUID();
      const captured_at = new Date().toISOString();

      // 2. Persist locally to SQLite outbox first (Local-First Outbox Pattern)
      await outboxRepo.enqueue({
        client_report_id,
        outlet_name: outletName.trim(),
        finding: finding.trim(),
        action_needed: actionNeeded.trim(),
        captured_at,
        lat: coords.lat,
        lng: coords.lng,
      });

      // 3. Clear form inputs immediately
      setOutletName('');
      setFinding('');
      setActionNeeded('');

      // 4. Update UI & trigger serial dispatcher
      await loadData();
      syncDispatcher.notify();
    } catch (err: any) {
      Alert.alert('Submission Failed', `Local database error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Server Verification
  const checkServerVerdict = async () => {
    try {
      setVerifyingServer(true);
      apiClient.setBaseUrl(serverUrl);
      const res = await apiClient.fetchDebugCount();
      setDebugResult(res);
    } catch (err: any) {
      Alert.alert(
        'Server Verification Failed',
        `Could not reach mock server at ${serverUrl}: ${err.message}\nMake sure 'node mock-server.js' is running.`
      );
    } finally {
      setVerifyingServer(false);
    }
  };

  const handleResetServer = async () => {
    try {
      await apiClient.resetServer();
      await outboxRepo.clearAll();
      setDebugResult(null);
      await loadData();
      Alert.alert('Reset Complete', 'Mock server and local outbox cleared.');
    } catch (err: any) {
      Alert.alert('Reset Failed', err.message);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    syncDispatcher.notify();
    setRefreshing(false);
  };

  const getStatusBadge = (item: OutboxItem) => {
    const now = Date.now();
    switch (item.status) {
      case 'CONFIRMED':
        return (
          <View style={[styles.badge, styles.badgeConfirmed]}>
            <Text style={styles.badgeTextConfirmed}>✓ CONFIRMED</Text>
          </View>
        );
      case 'IN_FLIGHT':
        return (
          <View style={[styles.badge, styles.badgeInFlight]}>
            <ActivityIndicator size="small" color="#1d4ed8" style={{ marginRight: 4 }} />
            <Text style={styles.badgeTextInFlight}>SYNCING...</Text>
          </View>
        );
      case 'WAITING_RETRY': {
        const remaining = Math.max(0, Math.ceil((item.next_retry_at - now) / 1000));
        return (
          <View style={[styles.badge, styles.badgeRetry]}>
            <Text style={styles.badgeTextRetry}>
              RETRY #{item.retry_count} {remaining > 0 ? `(${remaining}s)` : 'NOW'}
            </Text>
          </View>
        );
      }
      case 'FAILED_FATAL':
        return (
          <View style={[styles.badge, styles.badgeFatal]}>
            <Text style={styles.badgeTextFatal}>✗ FATAL ERROR</Text>
          </View>
        );
      case 'QUEUED':
      default:
        return (
          <View style={[styles.badge, styles.badgeQueued]}>
            <Text style={styles.badgeTextQueued}>QUEUED</Text>
          </View>
        );
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {/* Header & Network Banner */}
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Field Reporter</Text>
              <Text style={styles.subtitle}>Offline-First Outbox Dispatcher</Text>
            </View>
            <TouchableOpacity
              style={styles.configToggle}
              onPress={() => setShowConfig(!showConfig)}
            >
              <Text style={styles.configToggleText}>{showConfig ? 'Close' : '⚙ Server'}</Text>
            </TouchableOpacity>
          </View>

          {/* Network Bar */}
          <View
            style={[
              styles.networkBanner,
              networkStatus.effectiveOnline ? styles.networkOnline : styles.networkOffline,
            ]}
          >
            <View style={styles.networkLeft}>
              <View
                style={[
                  styles.networkDot,
                  { backgroundColor: networkStatus.effectiveOnline ? '#22c55e' : '#ef4444' },
                ]}
              />
              <Text style={styles.networkText}>
                {networkStatus.effectiveOnline
                  ? 'ONLINE — Live Sync Active'
                  : networkStatus.isSimulatedOffline
                  ? 'SIMULATED AIRPLANE MODE (Queueing)'
                  : 'OFFLINE — No Cellular Connection'}
              </Text>
            </View>
            <View style={styles.networkToggleWrapper}>
              <Text style={styles.networkToggleLabel}>Force Offline</Text>
              <Switch
                value={networkStatus.isSimulatedOffline}
                onValueChange={(val) => syncDispatcher.setSimulatedOffline(val)}
                trackColor={{ false: '#94a3b8', true: '#f97316' }}
                thumbColor="#ffffff"
              />
            </View>
          </View>

          {/* Server Config & Diagnostics Drawer */}
          {showConfig && (
            <View style={styles.configCard}>
              <Text style={styles.configTitle}>Server Connection & Verification</Text>
              <Text style={styles.configSubtitle}>
                Host machine URL (10.0.2.2 for Android Emulator, localhost for iOS/Web)
              </Text>
              <TextInput
                style={styles.input}
                value={serverUrl}
                onChangeText={(val) => {
                  setServerUrl(val);
                  apiClient.setBaseUrl(val);
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.configButtonRow}>
                <TouchableOpacity
                  style={[styles.btnAction, styles.btnVerify]}
                  onPress={checkServerVerdict}
                  disabled={verifyingServer}
                >
                  {verifyingServer ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.btnActionText}>Check Mock Server Stats</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.btnAction, styles.btnReset]}
                  onPress={handleResetServer}
                >
                  <Text style={styles.btnActionText}>Reset All</Text>
                </TouchableOpacity>
              </View>

              {debugResult && (
                <View style={styles.debugBox}>
                  <Text
                    style={[
                      styles.debugVerdict,
                      debugResult.duplicates_created === 0
                        ? styles.debugVerdictPass
                        : styles.debugVerdictFail,
                    ]}
                  >
                    {debugResult.VERDICT}
                  </Text>
                  <View style={styles.debugGrid}>
                    <Text style={styles.debugText}>
                      Stored: <Text style={styles.bold}>{debugResult.reports_stored}</Text>
                    </Text>
                    <Text style={styles.debugText}>
                      Duplicates: <Text style={[styles.bold, { color: debugResult.duplicates_created === 0 ? '#15803d' : '#b91c1c' }]}>{debugResult.duplicates_created}</Text>
                    </Text>
                    <Text style={styles.debugText}>
                      409 Handled: <Text style={styles.bold}>{debugResult.conflicts_409}</Text>
                    </Text>
                    <Text style={styles.debugText}>
                      Drops Caught: <Text style={styles.bold}>{debugResult.save_then_drop}</Text>
                    </Text>
                  </View>
                </View>
              )}
            </View>
          )}

          {/* Report Form */}
          <View style={styles.card}>
            <Text style={styles.cardHeader}>New Field Report</Text>

            <Text style={styles.label}>Outlet Name *</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Metro Cash & Carry, Model Town"
              placeholderTextColor="#94a3b8"
              value={outletName}
              onChangeText={setOutletName}
            />

            <Text style={styles.label}>What You Found *</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="e.g. Stock levels low on dairy. Shelf display damaged."
              placeholderTextColor="#94a3b8"
              value={finding}
              onChangeText={setFinding}
              multiline
              numberOfLines={3}
            />

            <Text style={styles.label}>Action Needed *</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="e.g. Dispatch regional distributor order by Wednesday."
              placeholderTextColor="#94a3b8"
              value={actionNeeded}
              onChangeText={setActionNeeded}
              multiline
              numberOfLines={2}
            />

            {/* GPS Coordinates & Fallback Toggle */}
            <View style={styles.gpsRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Location Coordinates</Text>
                <Text style={styles.coordsText}>
                  {coords.lat.toFixed(4)}, {coords.lng.toFixed(4)}{' '}
                  {useLiveLocation ? '(GPS Device)' : '(Karachi Fallback)'}
                </Text>
              </View>
              <View style={styles.gpsToggleWrapper}>
                <Text style={styles.gpsToggleLabel}>Live GPS</Text>
                <Switch
                  value={useLiveLocation}
                  onValueChange={handleLocationToggle}
                  disabled={locationLoading}
                />
              </View>
            </View>

            <TouchableOpacity
              style={[styles.submitButton, isSubmitting && { opacity: 0.7 }]}
              onPress={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.submitButtonText}>Submit to Outbox</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Queue Overview Summary */}
          <View style={styles.statsCard}>
            <Text style={styles.statsTitle}>Outbox Sync Engine</Text>
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statNumber}>{stats.total}</Text>
                <Text style={styles.statLabel}>Total</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNumber, { color: '#eab308' }]}>
                  {stats.queued + stats.waiting_retry}
                </Text>
                <Text style={styles.statLabel}>Pending</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNumber, { color: '#3b82f6' }]}>{stats.in_flight}</Text>
                <Text style={styles.statLabel}>In Flight</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNumber, { color: '#22c55e' }]}>{stats.confirmed}</Text>
                <Text style={styles.statLabel}>Synced</Text>
              </View>
            </View>

            <View style={styles.queueActionsRow}>
              <TouchableOpacity
                style={styles.miniBtn}
                onPress={() => syncDispatcher.notify()}
              >
                <Text style={styles.miniBtnText}>⚡ Force Sync</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.miniBtn}
                onPress={() => setShowLogs(!showLogs)}
              >
                <Text style={styles.miniBtnText}>
                  {showLogs ? 'Hide Log' : `Live Log (${logs.length})`}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Live Telemetry Log View */}
          {showLogs && (
            <View style={styles.logCard}>
              <Text style={styles.logTitle}>Live Dispatcher Stream</Text>
              {logs.length === 0 ? (
                <Text style={styles.logEmpty}>No events recorded yet.</Text>
              ) : (
                logs.slice(0, 8).map((log) => (
                  <View key={log.id} style={styles.logLine}>
                    <Text style={styles.logTimestamp}>{log.timestamp}</Text>
                    <Text
                      style={[
                        styles.logMessage,
                        log.type === 'success' && styles.logSuccess,
                        log.type === 'idempotent' && styles.logIdempotent,
                        log.type === 'warn' && styles.logWarn,
                        log.type === 'error' && styles.logError,
                      ]}
                    >
                      {log.message}
                    </Text>
                  </View>
                ))
              )}
            </View>
          )}

          {/* Queue Item List */}
          <View style={styles.queueSection}>
            <Text style={styles.queueSectionTitle}>Outbox Entries ({items.length})</Text>
            {items.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>Outbox is empty.</Text>
                <Text style={styles.emptySubtext}>
                  Submit a report above to test offline queueing and sync.
                </Text>
              </View>
            ) : (
              items.map((item) => (
                <View key={item.client_report_id} style={styles.itemCard}>
                  <View style={styles.itemTop}>
                    <Text style={styles.itemOutlet} numberOfLines={1}>
                      {item.outlet_name}
                    </Text>
                    {getStatusBadge(item)}
                  </View>

                  <Text style={styles.itemFinding} numberOfLines={2}>
                    {item.finding}
                  </Text>
                  <Text style={styles.itemAction} numberOfLines={1}>
                    Action: {item.action_needed}
                  </Text>

                  <View style={styles.itemFooter}>
                    <Text style={styles.itemId}>
                      CID: {item.client_report_id.slice(0, 8)}...
                      {item.server_report_id ? `  ➔  ${item.server_report_id}` : ''}
                    </Text>
                    <Text style={styles.itemTime}>
                      {new Date(item.captured_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                  </View>

                  {item.last_error && item.status !== 'CONFIRMED' && (
                    <Text style={styles.itemError} numberOfLines={1}>
                      {item.last_error}
                    </Text>
                  )}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  container: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 2,
  },
  configToggle: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
  },
  configToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },
  networkBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginBottom: 16,
    borderWidth: 1,
  },
  networkOnline: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
  },
  networkOffline: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  networkLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  networkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  networkText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1e293b',
    flex: 1,
  },
  networkToggleWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  networkToggleLabel: {
    fontSize: 11,
    color: '#64748b',
    marginRight: 4,
  },
  configCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  configTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  configSubtitle: {
    fontSize: 11,
    color: '#64748b',
    marginBottom: 8,
  },
  configButtonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  btnAction: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnVerify: {
    backgroundColor: '#0284c7',
  },
  btnReset: {
    backgroundColor: '#64748b',
    maxWidth: 90,
  },
  btnActionText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 12,
  },
  debugBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  debugVerdict: {
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 6,
  },
  debugVerdictPass: {
    color: '#15803d',
  },
  debugVerdictFail: {
    color: '#b91c1c',
  },
  debugGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  debugText: {
    fontSize: 11,
    color: '#334155',
    width: '48%',
    marginBottom: 2,
  },
  bold: {
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    marginBottom: 16,
  },
  cardHeader: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
    marginBottom: 12,
  },
  textArea: {
    minHeight: 56,
    textAlignVertical: 'top',
  },
  gpsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f1f5f9',
    padding: 10,
    borderRadius: 8,
    marginBottom: 16,
  },
  coordsText: {
    fontSize: 12,
    color: '#334155',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  gpsToggleWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  gpsToggleLabel: {
    fontSize: 11,
    color: '#64748b',
    marginRight: 6,
  },
  submitButton: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 15,
  },
  statsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 16,
  },
  statsTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 8,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  statBox: {
    alignItems: 'center',
    flex: 1,
  },
  statNumber: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  statLabel: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  queueActionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    paddingTop: 10,
  },
  miniBtn: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  miniBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#334155',
  },
  logCard: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  logTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  logEmpty: {
    fontSize: 11,
    color: '#64748b',
  },
  logLine: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  logTimestamp: {
    fontSize: 10,
    color: '#64748b',
    marginRight: 6,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  logMessage: {
    fontSize: 11,
    color: '#e2e8f0',
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  logSuccess: {
    color: '#4ade80',
  },
  logIdempotent: {
    color: '#38bdf8',
  },
  logWarn: {
    color: '#fbbf24',
  },
  logError: {
    color: '#f87171',
  },
  queueSection: {
    marginTop: 4,
  },
  queueSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 10,
  },
  emptyCard: {
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  emptyText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
  },
  emptySubtext: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 4,
    textAlign: 'center',
  },
  itemCard: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  itemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  itemOutlet: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    flex: 1,
    marginRight: 8,
  },
  itemFinding: {
    fontSize: 13,
    color: '#334155',
    marginBottom: 4,
  },
  itemAction: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 6,
  },
  itemFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    paddingTop: 6,
  },
  itemId: {
    fontSize: 10,
    color: '#94a3b8',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  itemTime: {
    fontSize: 10,
    color: '#94a3b8',
  },
  itemError: {
    fontSize: 10,
    color: '#dc2626',
    marginTop: 4,
    fontStyle: 'italic',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  badgeQueued: {
    backgroundColor: '#fef3c7',
  },
  badgeTextQueued: {
    fontSize: 10,
    fontWeight: '700',
    color: '#d97706',
  },
  badgeInFlight: {
    backgroundColor: '#dbeafe',
  },
  badgeTextInFlight: {
    fontSize: 10,
    fontWeight: '700',
    color: '#1d4ed8',
  },
  badgeRetry: {
    backgroundColor: '#ffedd5',
  },
  badgeTextRetry: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ea580c',
  },
  badgeConfirmed: {
    backgroundColor: '#dcfce7',
  },
  badgeTextConfirmed: {
    fontSize: 10,
    fontWeight: '700',
    color: '#15803d',
  },
  badgeFatal: {
    backgroundColor: '#fee2e2',
  },
  badgeTextFatal: {
    fontSize: 10,
    fontWeight: '700',
    color: '#b91c1c',
  },
});
