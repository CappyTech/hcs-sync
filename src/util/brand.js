/**
 * brand — the company name this deployment runs for, and the product label
 * built from it. Nothing company-specific is hard-coded: set COMPANY_NAME
 * (and optionally COMPANY_SHORT_NAME) in the environment, the same keys
 * hcs-app uses, typically from the stack's shared env file.
 *
 * Read per call so tests and a restart with new env pick up changes.
 */

const str = (key) => String(process.env[key] || '').trim();

/** The company's full name, or '' when unset. */
export function companyName() {
  return str('COMPANY_NAME');
}

/** A short name for tight spaces (alerts), falling back to the full name. */
export function companyShortName() {
  return str('COMPANY_SHORT_NAME') || companyName();
}

/** "Acme | Sync" when a company is set, otherwise the product name. */
export function syncLabel() {
  const short = companyShortName();
  return short ? `${short} | Sync` : 'HCS Sync';
}

export default { companyName, companyShortName, syncLabel };
