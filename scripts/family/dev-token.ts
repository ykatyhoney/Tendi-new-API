// Dev-only staff token for the Family API, until staff sign-in exists (scripts/family/dev-token/token.ts).
//
// Usage:
//   npm run family:dev-token -- --admin <id>     create a token for that active admin; prints it once
//   npm run family:dev-token -- --revoke <id>    delete that admin's dev tokens
//   add --database <name> for another database (default DB_NAME); only tendi_family_dev and
//   tendi_family_test are allowed. The API must run against the same database for the token to work.

import { parseArgs } from 'node:util';
import { loadFamilyConfig } from '../../src/modules/family/config.ts';
import { assertDevDatabase, createDevToken, DEV_DEVICE_ID, revokeDevTokens } from './dev-token/token.ts';
import { connectLocal, loadEnv, requireEnv } from './lib/db.ts';

const { values: args } = parseArgs({
  options: {
    admin: { type: 'string' },
    revoke: { type: 'string' },
    database: { type: 'string' },
  },
});

function adminId(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`--${flag} needs an admin id (a number), got '${value}'`);
  return Number(value);
}

async function main() {
  if ((args.admin === undefined) === (args.revoke === undefined)) {
    throw new Error('give exactly one of --admin <id> or --revoke <id>');
  }
  loadEnv();
  const database = args.database ?? requireEnv('DB_NAME');
  assertDevDatabase(database);
  const db = await connectLocal(database);
  try {
    if (args.revoke !== undefined) {
      const id = adminId(args.revoke, 'revoke');
      const n = await revokeDevTokens(db, id);
      console.log(`Deleted ${n} dev token${n === 1 ? '' : 's'} (device_id '${DEV_DEVICE_ID}') of admin ${id} in ${database}.`);
      return;
    }
    const { token, admin } = await createDevToken(db, adminId(args.admin!, 'admin'));
    const allowed = loadFamilyConfig().allowedStaffTypes;
    const name = `${admin.fname} ${admin.lname}`.trim();
    console.error(`Dev token for admin ${admin.id} (${name || 'no name'}, type ${admin.type ?? 'none'}) in ${database}:`);
    console.log(token);
    console.error('Shown once: only its md5 is stored. Paste it at http://localhost:3000/dev-sign-in.');
    console.error(`The API must use ${database}. Revoke with: npm run family:dev-token -- --revoke ${admin.id}`);
    if (!admin.type || !allowed.includes(admin.type as (typeof allowed)[number])) {
      console.error(`WARNING: type '${admin.type}' is not in FAMILY_ALLOWED_STAFF_TYPES (${allowed.join(', ')}); the API will answer 403.`);
    }
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(`family:dev-token: ${(error as Error).message}`);
  process.exit(1);
});
