import axios from 'axios';
import config from '../config.js';
import logger from '../util/logger.js';

// Obtains a permanent KF session token via the two-step flow.
// If `config.token` is provided, returns it.
// Otherwise, uses username/password to get a temp token, then upgrades with memorable word chars if provided.
export async function getSessionToken() {
  if (config.token) return config.token;

    const {
      USERNAME,
      PASSWORD,
      MEMORABLE_WORD,
      KASHFLOW_USERNAME,
      KASHFLOW_PASSWORD,
      KASHFLOW_MEMORABLE_WORD,
    } = process.env;
    const username = USERNAME || KASHFLOW_USERNAME;
    const password = PASSWORD || KASHFLOW_PASSWORD;
    const memorableWord = MEMORABLE_WORD || KASHFLOW_MEMORABLE_WORD;
    if (!username || !password) {
      throw new Error('Missing USERNAME or PASSWORD env vars for session token acquisition');
  }

  const http = axios.create({ baseURL: config.baseUrl, timeout: config.timeoutMs });

  // Step 1: request temporary token (KashFlow expects capitalized keys)
  let step1;
  try {
    step1 = await http.post('/sessiontoken', {
      Username: username,
      Password: password,
      KeepUserLoggedIn: false,
    });
  } catch (err) {
    logger.error({ status: err.response?.status, data: err.response?.data }, 'Step1 /sessiontoken request failed');
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
    return sessionToken;
  }

  // If no required chars, try using the temp token as bearer (some deployments allow it temporarily)
  logger.warn('No memorable word chars required; using temp token as session token');
  return tempToken;
}
