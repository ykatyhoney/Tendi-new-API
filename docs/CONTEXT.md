# Tendi-new-API: where things live

Fastify backend for Tendi. It owns the family database objects (migrations, procedures, triggers), the backfill scripts and the Family API. Tendi-new (Next.js) reaches data only through this API over HTTP.

**State as of 2026-10-19 (Step 0.3):** the Fastify app skeleton exists (`src/`): config, database pool, transactions, error format, CORS, OpenAPI, Redis client and `GET /health`. The family database layer (Steps 1.1–2.2, Phase 4 reconciliation) is in `migrations/family/` and `scripts/family/`. The Family API routes are not built yet. Each bullet below gives the decision taken, what exists, or "not set up yet", plus what the family spec (`../docs/family-module/PLAN.md`, `SCHEMA.md`) requires where it says something. Update this file in the same pull request that sets each item up.

**Steps 1.1–2.2 were done before Step 0.3**, on `family/2.1-backfill` and `family/2.2-proof-run`. Step 0.3 (`family/0.3-app-scaffold`) added the app around them and left their scripts, migrations and tests as they were.

## Project basics

- **Node version:** Node 24: `.nvmrc` contains `24.12.0` and `package.json` has `"engines": { "node": ">=24" }`. The dev machine has Node v24.12.0 (nvm for Windows) and npm 11.6.2.
- **npm scripts:** `dev` (`node --watch src/server.ts`), `build` (`tsc -p tsconfig.build.json` into `dist/`), `start` (`node dist/server.js`), `test` (fast tests, see "Tests and CI"), `typecheck`, `lint`, `format`, `format:check`, `migrate` (alias of `db:family:migrate`) and `export:openapi`, plus the family database scripts (see "Local development"). npm runs the `.sh` scripts with `bash`, which must resolve to Git Bash (`C:\Program Files\Git\usr\bin\bash.exe`), not WSL.
- **Module format:** `"type": "module"` (ESM), with `"engines": { "node": ">=24" }`.
- **Local port:** **4000** (`PORT`, default 4000), listening on `HOST` (default `127.0.0.1`).
- **Git:** its own repository, remote `https://github.com/ykatyhoney/Tendi-new-API.git`. One branch per step: `family/2.1-backfill`, `family/2.2-proof-run`, `family/0.3-app-scaffold`. Nothing has been pushed. The workspace root (`Tendi/`) is **not** a git repository, so `../docs/family-module/` is not under version control.
- **Docker:** decided: none. No Docker and no Dockerfile.

## Fastify and code layout

- **Fastify version:** **Fastify 5** (`fastify` 5.12.7), with `@fastify/type-provider-typebox` so route handlers get their types from the TypeBox schemas.
- **TypeScript or JavaScript:** **TypeScript 6.0** (`typescript` 6.0.3; 7.0 is not yet supported by typescript-eslint). Node 24 runs the `.ts` files directly (type stripping): only erasable syntax (`erasableSyntaxOnly`), imports name the `.ts` file, type-only imports use `import type`. `npm run typecheck` checks `src/`, `scripts/` and `test/`. `npm run build` compiles `src/` to `dist/` and rewrites the import extensions.
- **Plugin/module registration:**
  - `src/app.ts` exports `buildApp(config?)`, which builds the app without listening, so tests use `app.inject()`. `src/server.ts` builds the app and listens.
  - Shared resources are decorations on the root instance: `app.config`, `app.db` (the pool) and `app.redis` (client or `null`). They are typed in `src/app.ts` and closed in an `onClose` hook.
  - Each module is a Fastify plugin in its own folder, `src/modules/<name>/index.ts` (default export `async function (app)`), registered in `buildApp`. The first one is `src/modules/health/`.
- **Where routes live:** in their module's folder under `src/modules/`. There is no global prefix: `GET /health`, `GET /openapi.json`, and the Family API at the paths in PLAN.md (`/families`, `/people/:id`, `/children/:childId/unlink`). The family module comes in Step 3.x.
- **Naming conventions:**
  - Folders and files are kebab-case; a module's entry is `index.ts`.
  - Functions and variables are camelCase. TypeBox schemas are PascalCase, named after what they describe (`ErrorResponse`, `Health`).
  - A schema shared across routes gets a `$id`, which becomes its name in the OpenAPI document. Env variables are UPPER_SNAKE_CASE.

## Database access

- **Driver or ORM:** **`mysql2`, no ORM** (no Knex, Prisma or Drizzle).
- **Where the pool is created:** `src/db/pool.ts` (`mysql2/promise` `createPool`, `DB_POOL_SIZE` connections, `utf8mb4_general_ci`, `dateStrings`). `buildApp` creates one pool, exposes it as `app.db` and ends it on close. For now it connects with the `DB_*` credentials; the dedicated `family_api` user comes with the Family API.
- **Transactions:** `withTransaction(pool, work, { auditUser })` in `src/db/transaction.ts`. Every write route uses it. It runs `work(connection)` in one transaction, commits only if `work` completes, and rolls back otherwise. It sets `@audit_user` (the ra_* audit triggers record it) and clears `@audit_user` / `@family_mirror` before the connection goes back to the pool. The spec also requires every family write to add an `audit_logs` row; the Family API does that inside the same transaction.
- **Migrations:** **this repo's own migration runner**, `scripts/family/migrate.sh` (bash plus the `mysql` CLI, so `DELIMITER` works for trigger and procedure migrations), run with `npm run migrate` (or `db:family:migrate`). The SQL files are in `migrations/family/`, applied in order. It writes rows compatible with the tenant database's existing `schema_migrations` table; its columns were checked in step 1.2. The tool that wrote the existing 131 rows (`applied_by` = `provision` / `clone-tenant-to-beta`) belongs to the PHP app and is not in this workspace.
  - Files are `migrations/family/family_NNN_<name>.sql`, each with a required `family_NNN_<name>.down.sql`. Each file holds **one DDL statement**, because MariaDB commits DDL implicitly; a failure then leaves nothing half-applied.
  - Each row records: `version` = `family_NNN`, `filename` = the up file, `checksum` = SHA-1 of the up file, `batch` = `MAX(batch) + 1` per run, and `applied_by` = `family-migrate`.
  - A failed up is recorded as `status = 'failed'` with `error_message` and retried on the next run. A down deletes its row, because the status enum has no "reverted" value.
  - `up` refuses to run if an applied file's checksum changed. To change an applied migration, add a new one. `.gitattributes` forces LF for `*.sql` so checksums are the same on every machine.
  - Commands: `npm run db:family:migrate` (up), `db:family:migrate:down` (last family batch, `-- --all` for everything), and `db:family:migrate:status`. Prefix with `DB_NAME=tendi_family_test` to target the test database.
  - Applied so far: `family_001` to `family_008` (SCHEMA.md "Migration SQL") and `family_009` (decision D4: `people.occupation` / `employer`, `VARCHAR(150) NOT NULL DEFAULT ''` after `hebrew_name`). New tables use `utf8mb4` / `utf8mb4_general_ci`, matching `children`.
  - `family_010` to `family_012` add the read-only procedures `sp_family_parent_values`, `sp_family_mirror_values` and `sp_family_preview`.
  - `family_013` to `family_015` add the writing procedures `sp_family_mirror` (`SQL SECURITY DEFINER`), `sp_family_mirror_family` and `sp_family_mirror_person`.
  - `family_016` adds the 14 after-write `trg_*` triggers on the six family tables. It is the one exception to "one DDL statement per file": it uses `CREATE OR REPLACE TRIGGER` in up and `DROP TRIGGER IF EXISTS` in down, so a partly applied run can be re-run.
  - `family_022` (step 2.2) re-creates six objects so the mirror fills the legacy columns exactly as today: 28 mirrored columns (no `home_send_notification`), `*_name` = `legacy_full_name` verbatim, 0/`'voice'` without a rights row, and empty CAI values keeping a stored NULL. Its down step restores the 010–018 definitions. Committed migrations are never edited; changes go in a new migration.
  - `family_017` adds `sp_family_mirror_cai`. `family_018` adds the link and lock triggers `trg_children_family_bu`, `trg_children_family_au` (`PRECEDES ra_children_au`) and `trg_cai_family_bu`, grouped like `family_016`. For a linked child, a legacy write to a mirrored column is put back and logged in `family_mirror_lock_log`, with `db_user = USER()`. Other columns save normally.
  - **Mirror and audit:**
    - The `ra_*` audit triggers record mirror writes with `user_id = COALESCE(@audit_user, updated_by, created_by, 0)`. The Family API must `SET @audit_user = <admin.id>` on its connection before each write, or mirror changes are attributed to the child's last editor.
    - `ra_children_au` does not audit `children.family_id`, because it was generated before the column existed. Link and unlink are therefore recorded only by the API's `audit_logs` row.
    - A statement on a family table must not read `children` or `children_additional_information` (for example `INSERT … SELECT … FROM children`), or the mirror's write fails with error 1442.
  - Conventions for stored routines:
    - Each routine is in its own migration and uses `DELIMITER //`.
    - Routines use `SQL SECURITY INVOKER` unless they must write columns the caller cannot write.
    - String parameters and variables declare `CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci` explicitly, so they don't depend on the database default.
    - A value longer than its target column raises a clear `SIGNAL` instead of depending on `sql_mode`. A routine runs with the `sql_mode` of the session that created it, and non-strict mode truncates silently.
- **Backfill (step 2.1):** `npm run family:backfill -- [--dry-run] [--reset] [--group-by-home-phone] [--database <name>]` runs `scripts/family/backfill.ts`.
  - It builds draft families from the legacy columns, in one transaction. It writes the 6 family tables plus the bookkeeping tables `family_backfill_runs`, `_rows` and `_child_map` (migrations `family_019` to `family_021`), and never sets `children.family_id`.
  - Planning is a pure function, `scripts/family/backfill/plan.ts`, unit-tested by `npm run test:family-backfill`.
  - Review CSVs go to `var/family-backfill/review-run-<id>.csv`. `var/` is git-ignored because the CSVs hold personal data.
- **Proof run (step 2.2):** `npm run family:proof-run -- [--run <id>] [--database <name>]` runs `scripts/family/proof-run.ts`.
  - For every child in a backfill run's `family_backfill_child_map`, it compares `sp_family_preview(child, draft family)` with the 28 stored mirrored values (`home_send_notification` is not mirrored). Phones are compared as typed and normalized; strings exactly and after trim/case-fold; bit and enum columns by value.
  - It is read-only: a `READ ONLY` transaction, with `CHECKSUM TABLE` compared before and after.
  - It writes `docs/family/family-sync-proof.md` with counts and child ids only, no personal data (CLAUDE.md rule 6), and the full diff with names and values as `var/family-proof/family-sync-proof-run-<id>.csv`. Accepted causes are `ALLOWED_CAUSES` in `compare.ts`: missing CAI row (D4), `parent_email` matches neither parent, parent shared with siblings, shared phone. Any other cause is a failure, and the command exits 1.
  - The comparison and cause rules are in `scripts/family/proof/compare.ts`, tested by `npm run test:family-proof`.
- **Reconciliation (Phase 4 pilot):** `npm run family:reconcile [-- --once] [-- --database <name>]` runs `scripts/family/reconcile.ts`.
  - It compares every linked child's 28 mirrored columns with `sp_family_preview(child, NULL)` and counts lock-log rows from the last 24 hours. It writes one `family_reconcile_runs` row (migration `family_023`) and never fixes data.
  - Exit codes: 0 no drift or skipped, 2 drift, 1 error.
  - The core is in `scripts/family/reconcile/run.ts`, tested in `test/family-db/reconcile.test.ts`. The runbook is `docs/family/reconcile-runbook.md`.
- **Shared TypeScript helpers:** `scripts/family/lib/`.
  - `db.ts` provides the local-only mysql2 connection and `.env` loading; the tests use it as well.
  - `phone.ts` provides `normalizePhone`: digits only, last 10, `''` below 10 digits. No normalizer existed in this repository; the rule comes from `parent_sms_messages`, where the PHP app matched `718-555-0199` and `7185550199` to `7185550199`.
  - Step 0.3 should move both into the app's own layer.
- **Fixtures:** `scripts/family/fixtures/mirror-cases.sql` loads four hand-made families into `tendi_family_test` only (both parents, step-father only, no mother, two payment-responsible members). It never links a child, but its cleanup unlinks children of fixture families. Preview the cases with `CALL sp_family_preview(child, family)`. It is re-runnable and removes only its own rows (`families.name LIKE 'FIXTURE %'`, `people.note = 'fixture:mirror-cases'`).
  - `schema_migrations` columns: `id`, `version` (unique), `filename`, `checksum` (`char(40)`, SHA-1 of the file), `batch`, `status` (enum `applied` / `failed` / `skipped` / `baselined`), `applied_at`, `execution_ms`, `applied_by`, `error_message`.
  - Family migration versions are prefixed **`family_`**, so they never collide with the existing tool's versions.
  - Family migrations, procedures and triggers are specified in `SCHEMA.md` ("Migration SQL", "Database objects: mirror and lock").
- **`audit_logs` (existing table):** the columns are `type`, `table_name`, `action`, `col_name`, `old_value`, `new_value`, `user_id`, `actor_type`, `actor_ref`, `device_id`, `table_id`, `entity_name`, `created_at`, `updated_at`. Every Family API write adds a row here. The `ra_*` triggers separately capture the mirror writes to `children` and `children_additional_information`. How the API fills each column has not been set up yet.
- **Target database:** MariaDB 10.11, tenant schema from the 2026-09-24 dump, restored locally into `tendi_family_dev` by `npm run db:family:restore` (Step 1.1). Tendi-new's Playwright tests also use that script to reset the database.
  - The dump holds 209 base tables (all InnoDB), 2 views (`v_attendance_reporting`, `v_bus_route_orders`, `SQL SECURITY INVOKER`), and 312 `ra_*` audit triggers on 104 tables. The triggers write to `record_audit` using `@audit_user`. It has no stored routines, no events, no `DEFINER` clauses and no `CREATE DATABASE`/`USE`. The triggers are therefore owned by the local `DB_USER` that loads the dump, and no definer users need to exist.
  - The local database is created as `utf8mb4` / `utf8mb4_general_ci`, the collation of most tables in the dump. The production schema's default is not recorded in the dump, and the family tables in SCHEMA.md inherit the database default.

## Validation and OpenAPI

- **Validation library:** **TypeBox** (`typebox` 1.x, the current package; `@sinclair/typebox` is its 0.x predecessor). Fastify validates requests with its built-in Ajv against the TypeBox schemas. The env config is validated with TypeBox `Value` (`src/config.ts`).
- **How schemas attach to routes:** TypeBox schemas go on each route's `schema` option (`params`, `querystring`, `body`, `response`, plus `tags` and `summary`), so the same definitions validate requests, type the handler, and produce the OpenAPI document. Shared schemas are added with `app.addSchema` and need a `$id`.
- **@fastify/swagger / OpenAPI:** `@fastify/swagger` 9 builds an OpenAPI 3.0.3 document from the route schemas. The running app serves it at **`GET /openapi.json`** (`http://localhost:4000/openapi.json`). `npm run export:openapi` writes it to **`openapi/family.json`** (committed), which Tendi-new generates its types from. Today it holds `/health` and `ErrorResponse`; Step 3.3 adds the family routes.

## Auth and roles

- **Current user resolution:** not set up yet. The spec says to check the bearer token's md5 against `admin_api_tokens.token_hash`, in the same form `admin.login_auth` uses, with no new login system (PLAN.md "Security, permissions and audit"). How staff obtain a token is still open (see Open questions).
- **Role checks:** decided: the allowed `admin.type` values are **`admin`, `superadmin`, `office`**. This settles spec decision D5. It goes beyond D5's recommendation (`admin` and `office` only), and PLAN.md still lists D5 as Pending. Not set up yet.

## CORS

- **Setup and allowed origins:** `@fastify/cors`, allowing the origins in `CORS_ORIGIN` (comma-separated; locally `http://localhost:3000`, Tendi-new) with credentials. Other origins get no CORS headers.

## Logging, errors, config, jobs, alerting

- **Logging:** Fastify's built-in logger (pino, JSON lines on stdout) at `LOG_LEVEL` (default `info`); request logging is on. The family CLIs (backfill, proof run, reconcile) print to stdout and stderr, which the scheduler captures.
- **Error response format:** every error is `{ statusCode, error, message }` (`src/errors.ts`): the error handler, the 404 handler and validation errors (400). For 5xx the message is the generic "Internal Server Error" and the details go to the log only. The schema is registered as `ErrorResponse` for routes' `response` sections.
- **Config/env loading:** `src/config.ts` (`loadConfig`) reads `.env` (git-ignored); variables already set in the environment win. It validates the values with TypeBox at startup, and stops with `invalid configuration (see .env.example): …` if one is missing or wrong.
  - App keys: `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_POOL_SIZE`, `REDIS_URL` (optional) and `CORS_ORIGIN`. Empty values count as unset.
  - `.env.example` (committed) also lists the script-only keys `DB_TEST_NAME`, `FAMILY_DUMP_PATH`, `MARIADB_BIN_DIR` and `FAMILY_DB_PERF_TARGET_MS`. The `scripts/family/*.sh` scripts and `scripts/family/lib/db.ts` keep their own `.env` readers.
- **Scheduled jobs/cron:** chosen 2026-10-19: the **OS scheduler runs the CLI**, with no in-process scheduler and no new library. The nightly reconciliation is `npm run family:reconcile`. On Windows it is registered by `scripts/family/schedule-reconcile.ps1` (user task "Tendi family reconcile", 02:30, log in `var/family-reconcile/`); on Linux, cron (`docs/family/reconcile-runbook.md`). Single run: a MariaDB `GET_LOCK('<db>:family:reconcile')`, plus a per-night check in `family_reconcile_runs`. It switches to the Redis lock (`SET <prefix>:family:reconcile NX EX 3600`) in Step 2.3. The jobs may move into the app's scheduler after Step 0.3.
- **Alerting/email:** not set up yet. Chosen 2026-10-19 for the reconciliation: a `WARNING` on stderr and exit code 2, which the scheduler records as a failed run. `scripts/family/reconcile/alert.ts` is the single hook to wire once an alerting channel is chosen. The PHP `notifications_queue` is the parents' SMS/voice/email queue and must not be used for staff alerts.

## Tests and CI

- **Test runner:** **`node:test`** (Node 24's built-in runner, chosen 2026-10-19; no test library).
  - Tests are TypeScript, run directly by Node's type stripping. They are type-checked by `npm run typecheck`.
  - `npm test` runs the fast tests: `test/app/` (the app through `app.inject()`; `/health` needs the local MariaDB from `.env`), `test/family-backfill/` and `test/family-proof/`.
  - `npm run test:family-db` runs the database suite (see below).
- **Lint and format:**
  - **ESLint 10** (`eslint.config.js`: `@eslint/js` recommended plus `typescript-eslint` recommended); `npm run lint` covers the whole repo.
  - **Prettier 3** (`.prettierrc.json`: single quotes, width 120, trailing commas); `npm run format` / `format:check`.
  - `.prettierignore` leaves out `scripts/family/` and the `test/family-*` suites, which predate Prettier. Format them in a separate change before editing them.
- **How tests hit a database:** the suites (Steps 1.6 and 3.8) use `tendi_family_test` (`DB_TEST_NAME`), never the development database.
  - `npm run test:family-db` first runs `db:family:test-reset`: restore the dump into the test database, then apply every family migration. It then runs `test/family-db/**/*.test.ts` with `--test-concurrency=1`.
  - Each file opens one connection (`test/family-db/support/db.ts`). Every test runs inside a transaction that is rolled back, with `@family_mirror` and `@audit_user` cleared first.
  - Fixtures are built per test with `test/family-db/support/family.ts`.
  - The connection helper refuses a non-local host, a database not named `tendi_family_*`, `DB_TEST_NAME = DB_NAME`, and a server whose `@@hostname` is not this machine.
  - The performance target is `FAMILY_DB_PERF_TARGET_MS` (default 200), compared with the median of 7 runs.
  - `db:family:test-clone` (a copy of dev) remains available but is not used by the suite.
- **CI config:** not set up yet (no `.github/workflows/`).

## Local development (no Docker)

- **MariaDB:** **MariaDB 10.11.9 (same as production) from the Windows MSI**, installed 2026-10-19 from `archive.mariadb.org` (SHA-256 checked).
  - It runs as the Windows service `MariaDB` (automatic start) on port 3306, with `character-set-server=utf8mb4`.
  - The install folder is `C:\Program Files\MariaDB 10.11`, and its `bin` folder is not on PATH.
  - The root password is in `.env` only. Root can log in from `localhost` only (no remote root access).
  - The server listens on all interfaces, but no account accepts remote logins.
- **Redis:** decided: **Memurai or Redis under WSL**, needed from **Step 2.3**. Not installed yet: nothing listens on port 6379.
- **Env files:** copy `.env.example` to `.env`, then set `DB_PASSWORD` and `FAMILY_DUMP_PATH`.
- **Database npm scripts (Step 1.1):**
  - `npm run db:family:restore [-- <dump.sql>]`: drops and recreates `DB_NAME`, loads the dump, then checks for 209 base tables, 2 views, 753 `children` rows, 749 `children_additional_information` rows, 312 `ra_*` triggers on 104 tables (via `SHOW TRIGGERS`) and 0 routines. It exits non-zero on any mismatch.
  - `npm run db:family:test-clone`: rebuilds `DB_TEST_NAME` from `DB_NAME`, including any applied family migrations and their `schema_migrations` rows, and runs the same checks. The check of 209 tables counts the dump's tables only; the 7 family tables are reported separately.
  - Both scripts refuse a `DB_HOST` other than `localhost`, `127.0.0.1` or `::1`, a database name that does not start with `tendi_family_`, and a server whose `@@hostname` is not this machine (for example a tunnel). They warn when the server is not MariaDB 10.11.9. Credentials go to `mysql` through a temporary option file, never on the command line.
- **npm scripts for dev, test and migrations:** `npm run dev` (watch mode on port 4000), `npm test`, `npm run migrate`. See "Project basics".

## Redis

- **Client library:** **`redis`** 6 (node-redis, the official client). `src/redis.ts` connects only when `REDIS_URL` is set; `app.redis` is the client or `null`, and `/health` reports `redis: ok | down | disabled`. Redis itself is used from Step 2.3.
- **Connection config:** `REDIS_URL` (for example `redis://127.0.0.1:6379`); unset or empty means no Redis.
- **Key naming:** not set up yet.
- **What is cached:** nothing in this repo yet. The tenant database's `redis_caches_log` table only tracks `children_attendance`. The PHP team has not yet confirmed whether any child or parent data is cached in Redis (see Open questions).
- **Invalidation:** not set up yet. The spec says to clear cached child and parent data after mirror writes. What to clear depends on the PHP team's answer.

## Conventions to follow

- Use npm only (no yarn or pnpm). Do not use Docker or add a Dockerfile. MariaDB 10.11 and Redis run as local installs.
- Use Node 24 (`.nvmrc` `24.12.0`), TypeScript 6 (erasable syntax only), and port 4000. New code passes `npm run typecheck`, `npm run lint` and `npm run format:check`.
- Use `mysql2` directly, with no ORM or query builder.
- Use TypeBox for every route schema. Errors use `{ statusCode, error, message }`. Each module is a plugin in `src/modules/<name>/`. The OpenAPI document comes from those schemas, exported to `openapi/family.json`.
- Every migration goes through this repo's runner, with a version prefixed `family_` and a row in `schema_migrations`.
- Do not share code with Tendi-new. The contract is `openapi/family.json`.
- Read the spec from `../docs/family-module/` (single copy). Do not copy it into this repo.
- One step = one branch `family/<step>-<slug>` = one pull request.
- Never run anything against production. Use the local database restored from the 2026-09-24 dump.
- Set `children.family_id` (link, unlink, demos, fixtures, tests) only in `tendi_family_test`, never in `tendi_family_dev` (CLAUDE.md rule 7). The mirror would overwrite the dev legacy values that the backfill and the proof run read.
- Never change or drop an existing column the PHP app reads. Only the database mirror writes the 28 mirrored legacy parent columns (`home_send_notification` stays form-owned).
- Every family write runs in one transaction through `withTransaction` (with `auditUser`) and writes an `audit_logs` row.
- Only `admin`, `superadmin` and `office` staff may use the Family API.
- When a step sets up or changes a convention, update this file in the same pull request.

## Open questions

1. **Staff sign-in:** how does a staff member get a bearer token for the Family API? A login endpoint here would need to verify `admin.password` exactly as the PHP app hashes it. The PHP password hashing scheme is still needed.
2. **Redis contents (PHP team):** does the PHP app cache any child or parent data in Redis, and under which keys? The invalidation after mirror writes depends on the answer. Today `redis_caches_log` only tracks `children_attendance`.
3. ~~**2026-09-24 dump:** where will the dump come from for the Step 1.1 restore?~~ Answered on 2026-10-19: the dump is `C:\Users\admin\Downloads\raul-tendi-db-2026-09-24.sql` (SHA-1 `94678a1c04cf8b8154444de05a7a0c704c4a8d6d`, 17,514,044 bytes, MariaDB 10.11.9 dump). Byte-identical copies exist as `raul-tendi-db-2026-09-24 (2).sql` in `Downloads` and in the workspace root. Keep it out of every repository.
