/**
 * CLI wrapper around src/sync/shapes.js — writes inferred KashFlow response
 * shapes to ./shapes/ as JSON. The same capture is available interactively on
 * the debug page (POST /debug/shape).
 *
 * Usage:
 *   npm run shapes                              # all endpoints
 *   npm run shapes -- purchases bankAccounts    # only named endpoints
 *
 * Requires the same env/auth as a normal sync run.
 */
import fs from 'node:fs';
import path from 'node:path';
import createClient from '../kashflow/client.js';
import logger from '../util/logger.js';
import { SHAPE_ENDPOINTS, captureShape } from '../sync/shapes.js';

const OUT_DIR = path.resolve('shapes');

function writeReport(name, report) {
  if (!report) return;
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  logger.info({ file, fields: report.fields.length, items: report.totalItems }, `Shape written: ${name}`);
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = requested.length ? requested : Object.keys(SHAPE_ENDPOINTS);
  const unknown = names.filter((n) => !SHAPE_ENDPOINTS[n]);
  if (unknown.length) {
    logger.error({ unknown, available: Object.keys(SHAPE_ENDPOINTS) }, 'Unknown endpoint name(s)');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const kf = await createClient();

  for (const name of names) {
    try {
      const { list, detail } = await captureShape(name, kf);
      writeReport(`${name}.list`, list);
      if (detail) writeReport(`${name}.detail`, detail);
      else if (SHAPE_ENDPOINTS[name].detail) logger.warn(`No item available to fetch ${name} detail`);
    } catch (e) {
      logger.error({ err: e.message }, `Shape dump failed for ${name}`);
      process.exitCode = 1;
    }
  }
  logger.info({ outDir: OUT_DIR }, 'Shape dump complete');
}

main().catch((e) => {
  logger.error({ err: e.message }, 'dumpShapes crashed');
  process.exit(1);
});
