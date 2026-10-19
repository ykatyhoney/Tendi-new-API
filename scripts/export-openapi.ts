// Writes the OpenAPI document the app serves at /openapi.json to openapi/family.json, the
// contract Tendi-new generates its types from (CLAUDE.md rule 2). Run after any route change:
//   npm run export:openapi

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildApp } from '../src/app.ts';
import { API_ROOT, loadConfig } from '../src/config.ts';

const app = await buildApp({ ...loadConfig(), logLevel: 'silent' });
try {
  await app.ready();
  const out = join(API_ROOT, 'openapi', 'family.json');
  mkdirSync(join(API_ROOT, 'openapi'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
  console.log(`OpenAPI document written to ${relative(process.cwd(), out)}`);
} finally {
  await app.close();
}
