import axios from 'axios';
import config from '../config.js';
import logger from '../util/logger.js';

// Obtains a permanent KF session token via the two-step flow.
// If `config.token` is provided, returns it.
// Otherwise, uses username/password to get a temp token, then upgrades with memorable word chars if provided.
export async function getSessionToken() {
  if (config.token) return config.token;

  const { KASHFLOW_USERNAME, KASHFLOW_PASSWORD, KASHFLOW_MEMORABLE_WORD } = process.env;
  if (!KASHFLOW_USERNAME || !KASHFLOW_PASSWORD) {
    throw new Error('Missing KASHFLOW_USERNAME or KASHFLOW_PASSWORD env vars for session token acquisition');
  }

  const http = axios.create({ baseURL: config.baseUrl, timeout: config.timeoutMs });

  // Step 1: request temporary token
  const step1 = await http.post('/sessiontoken', {
    username: KASHFLOW_USERNAME,
    password: KASHFLOW_PASSWORD,
  });

  const tempToken = step1.data?.tempToken || step1.data?.TemToken || step1.data?.token;
  const requiredChars = step1.data?.requiredChars || step1.data?.RequiredChars;

  if (!tempToken) {
    logger.error({ data: step1.data }, 'No temp token returned from KashFlow');
    throw new Error('Failed to obtain temporary session token');
  }

  // If no additional characters required, sometimes PUT may still be needed; try upgrade when we have a memorable word.
  if (Array.isArray(requiredChars) && requiredChars.length > 0) {
    if (!KASHFLOW_MEMORABLE_WORD) {
      throw new Error('Memorable word required but KASHFLOW_MEMORABLE_WORD env var is missing');
    }
    const chars = {};
    // Positions are 1-based in many flows; API often returns indexes. Use positions directly.
    for (const pos of requiredChars) {
      const idx = Number(pos) - 1;
      chars[pos] = KASHFLOW_MEMORABLE_WORD[idx];
    }
    const step2 = await http.put('/sessiontoken', {
      tempToken,
      chars,
    });
    const sessionToken = step2.data?.sessionToken || step2.data?.KFSessionToken || step2.data?.token;
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
