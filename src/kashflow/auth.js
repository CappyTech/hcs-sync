import axios from 'axios';
import config from '../config.js';
import logger from '../util/logger.js';

let cachedToken = '';
let lockUntil = 0;

function stripWrappingQuotes(value) {
  const v = String(value ?? '');
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function readEnvString(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length) return stripWrappingQuotes(v).trim();
  }
  return '';
}

// Obtains a permanent KF session token via the two-step flow.
// If `config.token` is provided, returns it.
// Otherwise, uses username/password to get a temp token, then upgrades with memorable word chars if provided.
export async function getSessionToken() {
  if (config.token) return config.token;
  if (cachedToken) return cachedToken;
  if (Date.now() < lockUntil) {
    throw new Error(`Auth temporarily disabled until ${new Date(lockUntil).toLocaleString()} due to previous lockout`);
  }

  const username = readEnvString('KASHFLOW_USERNAME', 'USERNAME');
  const password = readEnvString('KASHFLOW_PASSWORD', 'PASSWORD');
  const memorableWord = readEnvString('KASHFLOW_MEMORABLE_WORD', 'MEMORABLE_WORD');
  if (!username || !password) {
    throw new Error('Missing USERNAME/PASSWORD (or KASHFLOW_USERNAME/KASHFLOW_PASSWORD) env vars for session token acquisition');
  }

  const http = axios.create({ baseURL: config.baseUrl, timeout: config.timeoutMs });

  // Step 1: request temporary token (KashFlow expects capitalized keys)
  let step1;
  try {
    step1 = await http.post('/sessiontoken', {
      UserName: username,
      Password: password,
    });
  } catch (err) {
    const errData = err.response?.data;
    logger.error({ status: err.response?.status, data: errData }, 'Step1 /sessiontoken request failed');
    if (errData?.Error === 'PasswordExpired') {
      logger.warn('KashFlow returned PasswordExpired; this can also happen if the password value is malformed (e.g. wrapped quotes/whitespace). Prefer unquoted PASSWORD in .env or set SESSION_TOKEN to bypass login.');
      // Avoid hammering auth if the account is in a forced-reset state.
      lockUntil = Date.now() + 10 * 60 * 1000;
    }
    if (errData && (errData.Error === 'AccountLocked' || /locked/i.test(errData.Message || ''))) {
      lockUntil = Date.now() + 10 * 60 * 1000;
    }
    throw err;
  }

  const tempToken = step1.data?.TemporaryToken || step1.data?.tempToken || step1.data?.TemToken || step1.data?.token;
  // KashFlow often returns positions as a comma-separated string or a list of objects
  let requiredChars = step1.data?.MemorableWordPositions || step1.data?.requiredChars || step1.data?.RequiredChars;

  if (!tempToken) {
    logger.error({ data: step1.data }, 'No temp token returned from KashFlow');
    throw new Error('Failed to obtain temporary session token');
  }

  // If no additional characters required, sometimes PUT may still be needed; try upgrade when we have a memorable word.
  // Normalize required positions: handle comma-separated string or MemorableWordList with empty values
  let positions = [];
  if (typeof requiredChars === 'string' && requiredChars.trim().length > 0) {
    positions = requiredChars.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  } else if (Array.isArray(step1.data?.MemorableWordList)) {
    positions = step1.data.MemorableWordList
      .filter((x) => typeof x?.Position === 'number')
      .map((x) => x.Position);
  } else if (Array.isArray(requiredChars)) {
    positions = requiredChars.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  }

  if (positions.length > 0) {
      if (!memorableWord) {
        throw new Error('Memorable word required but MEMORABLE_WORD env var is missing');
    }
    const list = positions.map((pos) => ({
      Position: pos,
        Value: memorableWord[Number(pos) - 1] || '',
    }));
    const step2Body = {
      TemporaryToken: tempToken,
      MemorableWordList: list,
      KeepUserLoggedIn: false,
    };
    const step2 = await http.put('/sessiontoken', step2Body);
    const sessionToken = step2.data?.SessionToken || step2.data?.KFSessionToken || step2.data?.token || step2.data?.Token;
    if (!sessionToken) {
      logger.error({ data: step2.data }, 'No permanent token returned from KashFlow');
      throw new Error('Failed to obtain permanent session token');
    }
    cachedToken = sessionToken;
    return sessionToken;
  }

  // If no required chars, try using the temp token as bearer (some deployments allow it temporarily)
  logger.warn('No memorable word chars required; using temp token as session token');
  cachedToken = tempToken;
  return tempToken;
}

export function clearCachedSessionToken() {
  cachedToken = '';
}
