# Family API

This service is the only writer of the family tables and, through its mirror, of the 28 old parent columns on linked children. The legacy PHP app keeps reading those columns. The API never changes a legacy table's structure.

The build steps and the rules for each one are in [family-module/BACKEND-GUIDE.md](family-module/BACKEND-GUIDE.md).

## Current state

B0 is the Fastify scaffold. B1 adds the local databases, the `family_api` account, one mysql2 pool, and `withTransaction()`. B2 adds the error shape, helmet, CORS, rate limits, OpenAPI, and `GET /api/v1/health`. B3 requires a staff bearer token on every family route except health. B4 adds the read routes: family search and detail, contacts, a child's linked or draft family, and active relationship types. B5 adds the mirror: `deriveLegacyValues`, `writeMirror`, and the affected-child lookup. B6 wires that mirror into the family, member, and contact writes. Each write locks the household, changes the family tables, re-mirrors affected linked children, and writes one `audit_logs` row per changed column. B7 adds rights for one child, a preview of the 28 old values, link, and unlink. Link writes the preview's values under the mirror flag. Unlink clears `family_id` and leaves those values. B8 lets relationship admins add a relationship type and change its label, order, or status. `father`, `mother`, `step_father`, and `step_mother` cannot be renamed or deactivated. The dropdown returns active types only. B9 adds `family:reconcile`, which compares every linked child's 28 stored parent columns with the derived values and writes nothing unless `--child` and `--fix` are both set. B10 checks concurrent saves, a save on the largest family, placeholders, paging, response schemas, and `npm audit`. B11 reset the test database, verified the schema, and passed typecheck, lint, the full test suite, `family:reconcile` (624 linked children, 0 differences), and `export:openapi`. A live walk-through on `tendi_family_dev` searched a family by the father's mobile, opened it, added a grandmother with an Other phone labeled "Grandma's cell" (no old columns changed), edited that mobile (`father_phone` on the linked child followed it), previewed an unlinked child without writing, linked it to the previewed values, and unlinked it with those values left in place. The dev rows were put back, and reconcile again reported 0 differences.

## Databases

Reset and schema checks use `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` from `.env` (the MariaDB admin). The API process uses only `family_api`.

```bash
npm run db:dev:reset
npm run db:test:reset
npm run db:verify-schema
```

`db:dev:reset` and `db:test:reset` drop and recreate `tendi_family_dev` or `tendi_family_test` (`utf8mb4` / `utf8mb4_general_ci`), import `db/tendi-family-dev-db-2026-11-06.sql`, and grant `family_api` on every local family database that exists. They refuse any host other than `127.0.0.1` or `localhost`, and any database name other than those two.

`db/tendi_family_module.sql` is the 2026-09-24 dump with family revision 3 applied. It has no `CREATE USER`. `db:verify-schema` imports it into `tendi_family_schema_ref` and compares columns, generated columns, indexes, foreign keys and their rules, check constraints, and the two lock triggers. The account grants follow the design's section 6 table: full access to the seven family tables, no delete on `relationship_types`, update only `children.family_id` and the 28 parent columns, insert on `children_additional_information`, read on `classes`, `branches`, and `admin_api_tokens`, six columns of `admin` (not `password`), and insert on `audit_logs`. Staff auth also updates `admin_api_tokens.last_seen_at`, so the account has `UPDATE` on that column and nothing else on the table. The account is created for both `localhost` and `127.0.0.1` because the pool connects to `DB_HOST`.

The pool is one mysql2 promise pool: `utf8mb4`, `dateStrings: true`, `timezone: 'Z'`, `supportBigNumbers`, named placeholders, and `bit(1)` values as numbers. `withTransaction()` runs at READ COMMITTED, commits or rolls back, clears `@family_mirror` and `@audit_user` before releasing the connection, and retries once on error 1213. If those variables cannot be cleared, the connection is destroyed instead of going back to the pool. `withStaffTransaction()` also sets `@audit_user`; every route write uses it. Two saves of the same family take its row lock, so they commit one after the other. A test sends both with `Promise.all` and both return 200.

READ COMMITTED is required, not a tuning choice. At MariaDB's default REPEATABLE READ, a save that does a plain `SELECT` and then waits on a family lock keeps reading the rows as they were before the wait, so it derives the 28 columns from data another save has already changed. A contact save waiting behind a member save wrote the old father's new mobile into `father_phone` this way. `test/api/hardening.test.ts` repeats that interleaving and fails if the isolation level is removed. A contact save also re-reads the contact's households after each lock and locks any it has not, so a household that gains the contact during the wait is included.

The lock triggers `trg_children_family_bu` and `trg_cai_family_bu` put a linked child's 28 parent columns back unless the statement runs as `family_api` with `@family_mirror = 1`. `family_id` itself is not one of those columns. `writeMirror` sets the flag for the statement and clears it before the connection returns to the pool. Unlink sets `family_id` to NULL and does not rewrite the 28 columns.

## How to start

Requirements: Node.js 26 (`engines` and `.nvmrc`) and local MariaDB 10.11. Node 26.13.0 (the first 26 LTS) is installed here with nvm-windows, and typecheck, lint, the full suite, `family:reconcile`, `build`, and `node dist/server.js` pass on it. Run `nvm use 26.13.0` to make it the default; 24.12.0 is still the active version for other projects. Put the MariaDB admin password in `DB_ADMIN_PASSWORD` before the reset scripts. The API password is `FAMILY_DB_PASSWORD`.

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` loads `.env`, refuses any `DB_HOST` other than `127.0.0.1` or `localhost` unless `NODE_ENV=production`, and listens on `HOST` and `PORT` (default `127.0.0.1:3000`).

| Database | Source | Used by |
| --- | --- | --- |
| `tendi_family_dev` | `db/tendi-family-dev-db-2026-11-06.sql` | `npm run dev`, manual checks |
| `tendi_family_test` | the same dump, reset before a test run | `npm test` |
| `tendi_family_schema_ref` | `db/tendi_family_module.sql` | `npm run db:verify-schema` |

`db/tendi_family_dev_seed.sql` is the family rows as inserts, for use after a base dump plus the module schema. The November 6 dump already includes those rows. `db/family_backfill_report.csv` lists the expected differences for the unlinked children and is used when link is built.

## What a save will do

A family, member, contact, rights, or link write runs in one transaction: lock the family rows, update the family tables, mirror the 28 old columns for the affected children, and write `audit_logs` (`type` `family`, `actor_type` `staff`, `actor_ref` `tendi-new`). The response includes `affected_child_ids`, the children whose old columns changed. `GET /families/:id/children/:childId/preview` writes nothing: it shows each of the 28 values today and after linking, whether it would change, and whether it is too long for the old column. Link refuses when the child belongs to another family or the family has no active member. Rights refuse a child linked to another family (409 `ALREADY_LINKED`); an unlinked child can get rights before it is linked. A family with linked children cannot be trashed (409 `HAS_LINKED_CHILDREN`, with the child ids); unlink them first. Unlink sets `children.family_id` back to NULL and does not change the 28 values. `GET /families/:id` still hides a trashed family. A trashed membership is revived when that contact is added again. Phone, email, and address saves replace the whole list but keep row ids. An item with an `id` updates that row; an item without one keeps an identical existing row or is inserted; rows no item claims are deleted. Only changed columns are written and audited, so saving an unchanged list writes nothing. An `id` that is not one of the contact's rows, or one listed twice, is 400 `VALIDATION`. A changed primary is demoted before the new one is written. If any step fails, the family tables and the old columns roll back together.

## Hardening

A warmed `PATCH` of household phone on the largest family (family 16, 9 linked children) took 67 ms on this machine, under the 300 ms budget. The test restores the original phone. The slowest five measured routes, in milliseconds:

| Route | ms |
| --- | ---: |
| `GET /api/v1/health` | 110 |
| `PATCH /api/v1/families/:id` | 67 |
| `GET /api/v1/children/:childId/family` | 62 |
| `GET /api/v1/contacts` | 26 |
| `GET /api/v1/families?q` | 17 |

Health was the slow one because it read `information_schema` on every call. It now pings the pool on every call and runs the schema check at most every five minutes. A failed check is logged with the missing tables; the open response is only 503 `SCHEMA`.

Staff auth runs in `onRequest`, so a request without a valid token gets 401 before its body is parsed or validated. Health is registered outside that scope. `last_seen_at` is written at most once a minute per token. The request id is taken from `x-request-id` only when it is 1 to 200 characters of `A-Z a-z 0-9 . _ : -`; anything else gets a new UUID. Rate limits are `RATE_LIMIT_PER_MINUTE` (default 300) per IP and per token, keyed by the token's md5, never the token. Without `REDIS_URL` the counters are in process memory, so each instance counts on its own. With it, every instance shares one count in Redis (see Redis below). If Redis is unreachable the limits let requests through, so a Redis outage does not stop the API. Behind a proxy, set `TRUST_PROXY` so `request.ip` is the client and not the proxy. In production, startup refuses an empty `FAMILY_DB_PASSWORD` and a localhost `CORS_ORIGIN`. Family and contact search are paged (`page` default 1, `pageSize` default 25, maximum 100). Each search is one `UNION` of the name and phone matches, joined to the table and paged with `LIMIT` and `COUNT(*)` in SQL. The contact phone branch embeds `PHONE_LOOKUP_SQL`, which uses `idx_fcp_norm`. The household phone branch has no index (it normalizes `families.household_phone` per row); that needs a schema change if families grow far past today's 375. `GET /relationship-types` returns the whole active dropdown; that list is the set of types, not a search page. Every response object sets `additionalProperties: false`, so a response leaves out fields the schema does not declare. SQL values use `?`. Column and table names that are spliced into a statement come from a fixed list and go through `quoteIdentifier`, or they are constant SQL. The health check's table-name list uses placeholders.

`npm audit` reports 10 moderate findings, all `minimatch` before 11.0.1 (`GHSA-g3hv-75wg-m249`) through ESLint 10 and typescript-eslint 8. Those packages are dev dependencies. The latest release of each pinned major still depends on `minimatch` 10, and the only audit fix downgrades ESLint to 9. Nothing was upgraded.

## Redis

Redis is optional and fail-open (decided 9 November 2026). `REDIS_URL` turns it on. Without it, or while it is down, rate limits, the throttle, and the cache work per process and the API keeps serving. Production logs a startup warning when `REDIS_URL` is unset. There is one client, created in `src/plugins/redis.ts`. It is `app.redis` for the rate limiter, and app code reaches Redis only through `app.cache` (`src/lib/cache.ts`: `get`, `set`, `del`, `claim`). The fallback is `MemoryCache`. Every key starts with `family-api:<database>:`, so a dev server and a test run on one Redis never share entries. `db:dev:reset` and `db:test:reset` delete that database's `cache:` keys after an import.

| Key | What | TTL |
| --- | --- | --- |
| `…:rate-limit:ip:<address>` and `…:rate-limit:…token:<md5>` | Rate-limit counts | 1 minute |
| `…:cache:last-seen:<token id>` | Staff auth writes `admin_api_tokens.last_seen_at` only when it wins this claim, so most requests skip that UPDATE | 60 s |
| `…:cache:relationship-types:active` | The dropdown. Create and patch delete it after they commit. The TTL caps staleness from a read that raced a write, or an edit made with SQL | 60 s |

What is deliberately not cached:
- **The token lookup.** A revoked token or a deactivated account is refused on its next request, including when the PHP app does the revoking. Caching it would have saved one query per request at the cost of that guarantee.
- **Family, contact, and child data.** The mirror and the legacy app read those tables directly, so a cached copy could disagree with what PHP shows, and a contact edit fans out to every household it belongs to.

Measured on this machine (`app.inject`, local MariaDB and Redis), database queries per request dropped from 3 to 1 for `GET /relationship-types`, 6 to 5 for a family search, and 9 to 8 for a family page. Wall time stayed about the same with Redis on, because a local Redis round trip costs about what a local MariaDB one does, and the rate limiter now calls Redis twice per request. The gain is fewer queries on a shared, remote production database, and limits that hold across instances.

## Scripts

`dev`, `build`, `start`, `typecheck`, `lint`, `test` (resets `tendi_family_test` first), `db:dev:reset`, `db:test:reset`, `db:verify-schema`, `export:openapi`, `family:dev-token`, and `family:reconcile` work. `export:openapi` writes `openapi/family.json`. `family:dev-token -- --admin <id>` creates a token for an active account in `DB_NAME` and prints it once; `--revoke <id>` removes tokens with device id `tendi-new-dev`. `family:reconcile` reads `DB_NAME`, prints each difference, and writes `results/reconcile-<date>.json`. It exits with code 1 when any linked child differs. `family:reconcile -- --child <id> --fix --admin <id>` re-mirrors that one child in a transaction, with `@audit_user` set to that active admin so the legacy `ra_*` triggers record who made the fix. It is not scheduled. Both commands refuse any database other than `tendi_family_dev` and `tendi_family_test`.

## Review fixes (B12, 9 November 2026)

A full review found these and fixed them on `family/b12-review-fixes`:

- **CORS.** `@fastify/cors` 11 allows only `GET, HEAD, POST` by default, so a browser refused every PATCH, PUT, and DELETE after the preflight. `CORS_METHODS` now lists all six methods, along with the allowed and exposed headers. `test/unit/cors.test.ts` also fails if a route ever uses a method that is not on the list.
- **Errors.** Values the schema let through but a column refused (MariaDB 1048, 1264, 1265, 1366, 1406) were 500s. They are now 400 `VALIDATION` with the column's path and never the rejected value. Every `sortOrder` input is limited to the `int(11)` range. Two simultaneous creates of one relationship code give 409 `DUPLICATE_CODE`, not 500: at READ COMMITTED, `FOR UPDATE` on a missing row takes no lock.
- **Responses come from the save's transaction.** `finishFamily`, `finishContact`, `readRights`, and `finishType` read on the save's connection before the commit. A failed read rolls the save back, instead of returning a 500 for a save that committed, which a client would then retry and duplicate. A deadlock retry rebuilds the response too. Repositories and read services take `Sql` (a pool or a connection) for this.
- **Validation.** Names are trimmed, and a contact needs a first or last name. A non-empty phone, email, or address list with no primary is 400 `PRIMARY_REQUIRED`; two primaries stay 409 `SECOND_PRIMARY`. Email format is not checked: 84 of the 244 stored emails in the November 6 dump would fail even a lenient check, and replacing the list resends every stored email.
- **OpenAPI.** The error body is the `ApiError` component, and every route documents it for `4XX` and `5XX`. `test/unit/openapi.test.ts` fails when `openapi/family.json` differs from the running app.
- **Operations.** SIGTERM and SIGINT close the app (requests in flight finish, the pool ends) with a 10-second limit (`src/lib/shutdown.ts`). `GET /api/v1/health/live` answers without the database, for a liveness probe; `GET /api/v1/health` stays the readiness check. Development logs go through `pino-pretty`; other environments log JSON. Startup warns when a `RELATIONSHIP_ADMIN_TYPES` entry is not also in `ALLOWED_STAFF_TYPES` (D5).
- **Structure.** Shared enums and sub-objects are in `schemas/common.ts`, and shared row mappers are in `services/mappers.ts`. The mirror loader uses one member query and the shared `groupBy`. The OpenAPI export showed that nothing but the new `sortOrder` bounds changed shape.
- **Tooling.** `npm test` resets `tendi_family_test` first (`pretest`). `MARIADB_BIN` defaults to `mariadb` on PATH outside Windows. `.github/workflows/ci.yml` runs typecheck, lint, unit tests, and build, plus a MariaDB 10.11 job: reset, verify-schema, reconcile, all suites. `README.md` and `CLAUDE.md` were added.

Write SQL still lives in `services/write/*`, `links.ts`, and `relationship-types.ts`, next to the locks and audit rows that must surround it. `repositories/` holds the reads that several services share. Moving the write SQL into repositories is worth doing only alongside a full `npm test` run on MariaDB.

## Open items

- Set `REDIS_URL` wherever more than one API instance runs, so they share one rate-limit count, one `last_seen_at` throttle, and one dropdown cache. It is tested here against Redis 7.0 and in CI against Ubuntu's Redis. Check it once against the production Redis.

- D5: `superadmin` is not in `ALLOWED_STAFF_TYPES`. Relationship-type writes still list `admin` and `superadmin` in `RELATIONSHIP_ADMIN_TYPES`.
- Real staff sign-in waits on the PHP team. Until then, use `family:dev-token`. The API stores the md5 of the bearer token in `admin_api_tokens.token_hash`.
- `/people` is not registered. Nothing in this repo calls it. Add it as a deprecated alias of `/contacts` if Tendi-new still uses that path.
- The original commented section 6 SQL was not in the dump file. Grants are generated from the design's account table.
- **Dumps in git.** `db/*.sql` hold what look like real children's names, birth dates, and addresses, plus md5 `admin.password` hashes. They are in the GitHub history. Decide whether to anonymize them, remove them from history, and change those staff passwords; the CI database job reads them from the repository today.
- **`admin_api_tokens` lookup.** The only index is `UNIQUE(admin_id, token_hash)`, so staff auth's `WHERE token_hash = ?` scans the table. Ask the schema owner for `KEY(token_hash)` before real sign-in issues a token per device.
- **Contract choices before Tendi-new generates types.** `affected_child_ids` is snake_case while every other field is camelCase, and creates return 200 rather than 201. Both follow the build guide today.
