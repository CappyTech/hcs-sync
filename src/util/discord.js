import os from 'node:os';
import logger from './logger.js';

// Discord alerting for sync runs. Deliberately a "dumb" sender: the caller
// decides *whether* to alert and builds the fields; this module only formats
// the embed and POSTs it. Mirrors the backup scripts' send_discord() helper
// (docker/mongodb/mongo-backup.sh) so sync alerts look like the same family:
//   - emerald on success / red on failure, host in the footer;
//   - a custom User-Agent, because Discord 403s some default UAs;
//   - one retry on HTTP 429, honouring Retry-After (capped at 5s).
//
// It never throws and never blocks a run: a Discord hiccup must not fail or
// delay a sync, so every error path resolves quietly.

const USERNAME = 'Heron CS Sync';
const COLOR_OK = 0x10b981; // emerald — matches the backup alerts
const COLOR_ERR = 0xed4245; // red

// Read the webhook per-call (not at import time) so it works whether the value
// arrives via the container's env_file or via dotenv in local dev, regardless
// of module import order.
function webhookUrl() {
  return process.env.DISCORD_WEBHOOK_URL || '';
}

export function isDiscordEnabled() {
  return Boolean(webhookUrl());
}

/**
 * Post a Discord embed. Resolves to true if a request was accepted, false if
 * skipped (no webhook) or failed. Never rejects.
 *
 * @param {object}  opts
 * @param {boolean} opts.ok           success (emerald) vs failure (red)
 * @param {string}  opts.title        embed title
 * @param {string} [opts.description] embed description
 * @param {Array}  [opts.fields]      Discord embed fields (max 25 kept)
 */
export async function sendDiscord({ ok = true, title = '', description = '', fields = [] } = {}) {
  const webhook = webhookUrl();
  if (!webhook) return false;

  const embed = {
    title,
    description: description || '',
    color: ok ? COLOR_OK : COLOR_ERR,
    fields: (fields || []).filter(Boolean).slice(0, 25),
    footer: { text: `Heron CS sync • ${os.hostname()}` },
    timestamp: new Date().toISOString(),
  };
  const body = JSON.stringify({ username: USERNAME, embeds: [embed] });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'heroncs-sync/1.0', // Discord 403s some default UAs
        },
        body,
      });

      // One retry on rate-limit, honouring Discord's Retry-After (seconds).
      if (res.status === 429 && attempt === 0) {
        let wait = 1;
        const hdr = Number(res.headers.get('retry-after'));
        if (Number.isFinite(hdr) && hdr > 0) wait = hdr;
        await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
        continue;
      }

      if (!res.ok) {
        logger.warn({ status: res.status }, 'Discord alert rejected');
        return false;
      }
      return true;
    } catch (err) {
      logger.warn({ err: { message: err?.message } }, 'Discord alert request failed');
      return false;
    }
  }
  return false;
}

export default sendDiscord;
