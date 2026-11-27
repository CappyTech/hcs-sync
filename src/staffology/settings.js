import axios from 'axios';
import config from '../config.js';
import { appBaseUrl } from '../server/middleware/auth.js';

/**
 * Where the Staffology API key comes from, in order:
 *
 *  1. STAFFOLOGY_API_KEY in hcs-sync's own environment (with
 *     STAFFOLOGY_EMPLOYER_ID), for local runs and as an override.
 *  2. hcs-app's Settings → Connections → Staffology, read from
 *     GET {HCS_APP_BASE_URL}/api/sync/staffology-config with the shared
 *     X-Sync-Api-Key. This is the normal production path: the key is entered
 *     once in hcs-app, stored encrypted there, and only ever held in memory here.
 *
 * Resolves to { apiKey, employerId, source } or null when neither has a key.
 * Throws when hcs-app should have the settings but can't be asked.
 */
export function canReachAppSettings() {
  return Boolean(appBaseUrl() && String(process.env.HCS_SYNC_API_KEY || '').trim());
}

export function staffologyMayBeConfigured() {
  return Boolean(config.staffologyApiKey) || canReachAppSettings();
}

export async function resolveStaffologySettings({ http = axios } = {}) {
  if (config.staffologyApiKey) {
    return { apiKey: config.staffologyApiKey, employerId: config.staffologyEmployerId || '', source: 'env' };
  }
  if (!canReachAppSettings()) return null;

  let data;
  try {
    const res = await http.get(`${appBaseUrl()}/api/sync/staffology-config`, {
      headers: { 'X-Sync-Api-Key': String(process.env.HCS_SYNC_API_KEY).trim(), Accept: 'application/json' },
      timeout: Math.min(config.timeoutMs || 30000, 15000),
    });
    data = res.data || {};
  } catch (err) {
    const status = err?.response?.status;
    const why = status === 401 ? 'hcs-app refused the sync API key (HCS_SYNC_API_KEY must match on both)'
      : status === 404 ? 'hcs-app is too old to share Staffology settings (needs 6.157.0)'
        : status ? `HTTP ${status}` : err?.message || 'unreachable';
    throw new Error(`Could not read the Staffology settings from hcs-app: ${why}`);
  }
  const apiKey = String(data.apiKey || '').trim();
  if (!apiKey) return null;
  return { apiKey, employerId: String(data.employerId || '').trim(), source: 'hcs-app' };
}
