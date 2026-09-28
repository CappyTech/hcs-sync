import crypto from 'crypto';
import cronstrue from 'cronstrue';
import { APP_BUILD } from '../buildInfo.js';
import { getEffectiveCronConfig } from '../syncController.js';

// Make cron config and nav helpers available to templates.
export function templateLocals(req, res, next) {
  res.locals.navActive = (href) =>
    req.path === href || (href !== '/' && req.path.startsWith(href));
  res.locals.cronConfig = getEffectiveCronConfig();
  res.locals.query = req.query || {};
  res.locals.appBuild = APP_BUILD;
  res.locals.appVersion = APP_BUILD?.version || null;
  res.locals.appCommit = APP_BUILD?.commit || null;
  res.locals.appBranch = APP_BUILD?.branch || null;

  res.locals.formatCronHuman = (schedule) => {
    const expr = String(schedule || '').trim();
    if (!expr) return '—';
    try {
      const toString = typeof cronstrue?.toString === 'function' ? cronstrue.toString : null;
      if (!toString) return expr;
      return toString(expr, {
        use24HourTimeFormat: true,
        verbose: true,
      });
    } catch {
      return expr;
    }
  };

  const dtf = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const df = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  res.locals.formatDateTimeUK = (value) => {
    if (value === null || typeof value === 'undefined') return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return dtf.format(date);
  };

  res.locals.formatDateUK = (value) => {
    if (value === null || typeof value === 'undefined') return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return df.format(date);
  };

  next();
}

/** A fresh nonce per response, for the CSP header and inline tags. */
export function cspNonce(_req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
}
