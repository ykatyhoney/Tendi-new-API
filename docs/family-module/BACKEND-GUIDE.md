# Family API Backend Build Guide (Fastify 5)

Nov 6, 2026 · David Fried

This guide builds the Family API in Tendi-new-API on Fastify 5.12.8 and Node.js 26, against the family module database of November 6, in 12 Claude Code steps (B0 to B11). The API is the only writer of the family tables and, through its mirror service, of the 28 old parent columns of linked children.

## How to use this guide

Each step is a prompt for Claude Code, started in the **Tendi-new-API** folder. Paste it in plan mode, approve the plan, let it build, then run the verify prompt (end of step B11) before merging.

- **Inputs.** Put these in `<workspace>/db/`: `tendi-family-dev-db-2026-11-06.sql` (the full dev database), `tendi_family_module.sql` (revision 3, the schema), `tendi_family_dev_seed.sql` and `family_backfill_report.csv`.
- **One branch per step,** `family/<step>-<slug>`, never `main`. Push, open a pull request, merge after the verify prompt is green.
- **Existing code.** If Tendi-new-API already has family code from the earlier playbook, B0 and B1 upgrade it and rename it to the new tables. The later steps say "implement or align": keep what matches this guide, change what doesn't.
- **Rules for every step:** npm only, no Docker; local MariaDB 10.11 only (`tendi_family_dev` and `tendi_family_test` on 127.0.0.1), never production; the API never changes a legacy table's structure; no real SMS or email.
- **Not in scope:** the Next.js screens (Tendi-new) and the legacy PHP app.

## Stack and versions

The latest stable releases on npm as of November 6, 2026, pinned to exact versions. Fastify 6 is still an alpha (6.0.0-alpha.6), so the API stays on Fastify 5.

| Package | Version | Role |
| --- | --- | --- |
| Node.js | 26 (Active LTS) | Runtime. Fastify 5 needs Node 20 or later; 26 is supported until April 2029 |
| `fastify` | 5.12.8 | Web framework |
| `@fastify/type-provider-typebox` | 6.3.0 | Typed routes from TypeBox schemas |
| `typebox` | 1.4.5 | Schemas. The provider now uses the `typebox` package, not `@sinclair/typebox` |
| `mysql2` | 3.24.6 | MariaDB driver, promise API, one pool |
| `@fastify/sensible` | 6.0.7 | HTTP errors |
| `@fastify/cors` | 11.4.1 | CORS for Tendi-new's origin |
| `@fastify/helmet` | 13.2.0 | Security headers |
| `@fastify/rate-limit` | 11.2.2 | Limits per token and per IP |
| `@fastify/swagger`, `@fastify/swagger-ui` | 9.9.3, 6.1.3 | OpenAPI document and its viewer |
| `@fastify/env` | 7.0.1 | Validated environment variables |
| `@fastify/autoload` | 6.5.1 | Loads plugins and routes by folder |
| `fastify-plugin` | 6.0.1 | Shared plugins |
| `pino` | 10.4.0 | Logging (Fastify's logger) |
| `typescript` | 7.0.2 | Type checking. If a tool in the chain doesn't support 7 yet, use 6.0.3 |
| `tsx` | 4.23.15 | Runs TypeScript in development |
| `vitest` | 5.1.0 | Tests (Node 22, 24 or 26) |
| `@types/node` | 26.6.6 | Node types |
| MariaDB | 10.11 | The tenant database, local install |

**Fastify 5 rules the code must follow:** every `querystring`, `params`, `body` and `response` schema is a full JSON Schema with an explicit `type`; date-time formats need a time zone; a custom logger goes in `loggerInstance`; async plugins never take `done`; use `request.routeOptions`, `request.socket` and `reply.elapsedTime`; `listen({ port })` takes an options object.

## How a save works

A save changes the family tables and the old columns in one transaction.

```text
 1. Tendi-new screen
    PUT /api/v1/contacts/:id/phones with a staff token
        |
        v
 2. Auth and validation
    Token -> admin_api_tokens, staff type, TypeBox schema
        |
        v
 3. One database transaction
    +-------------------------------------------------------+
    | a. Lock the family rows                               |       Legacy PHP app
    |    SELECT ... FOR UPDATE; SET @audit_user = staff id  |       Reads the old columns as today:
    |        |                                              |       SMS, kiosk, billing, PDFs
    |        v                                              |              |
    | b. Write the family tables                            |              | reads
    |    Replace the phone list; phone_normalized is        |              v
    |    computed by the database                           |       Old parent columns
    |        |                                              |       children: 10 columns
    |        v                                              | writes  registration sheet: 18 columns
    | c. Mirror the old columns  ---------------------------|------> (children_additional_information)
    |    @family_mirror = 1; write changed old columns      |              |
    |    of every linked child; flag cleared in finally     |       Two lock triggers
    |        |                                              |       Put back any other write and log it
    |        v                                              |
    | d. Audit                                              |
    |    One audit_logs row per changed column              |
    +-------------------------------------------------------+
        |
        v
 4. Commit and respond
    The updated contact and affected_child_ids
```

If any step inside the transaction fails, everything rolls back, the old columns included, so the PHP app never sees a half-saved family.

## Project layout

ESM TypeScript (`"type": "module"`). `buildApp()` builds the app without listening, so tests use `app.inject()`. Each layer only calls the one below it: routes -> services -> repositories -> the pool.

```text
Tendi-new-API/
├── src/
│   ├── app.ts                   buildApp(): plugins, type provider, routes
│   ├── server.ts                reads env, calls listen({ port, host })
│   ├── config/env.ts            @fastify/env schema (TypeBox)
│   ├── plugins/                 db.ts (pool), auth.ts, errors.ts, security.ts, openapi.ts
│   ├── modules/family/
│   │   ├── schemas/             TypeBox schemas, one file per resource
│   │   ├── routes/              families, contacts, members, rights, links, relationship-types, health
│   │   ├── services/            family, contact, link services; mirror/derive.ts, mirror/write.ts
│   │   ├── repositories/        SQL only, one file per table group
│   │   └── audit.ts             audit_logs writer
│   └── lib/                     withTransaction, phone normalizer, sql helpers
├── scripts/                     db-reset, verify-schema, dev-token, reconcile, export-openapi
├── test/                        unit/, api/, db/, fixtures/
├── openapi/family.json          exported contract for Tendi-new
├── docs/CONTEXT.md              how this project works, kept current
├── .env.example                 every variable, no secrets
└── package.json                 exact versions, engines: node >=26 <27
```

**npm scripts:** `dev`, `build`, `start`, `typecheck`, `lint`, `test`, `test:unit`, `test:api`, `test:db`, `db:dev:reset`, `db:test:reset`, `db:verify-schema`, `family:dev-token`, `family:reconcile`, `export:openapi`.

## Database

The schema belongs to `tendi_family_module.sql`; the API reads and writes data but never creates, alters or drops tables. Both local databases are built from the dev dump, which already holds 375 families, 732 contacts and 624 linked children.

| Database | Built from | Used by |
| --- | --- | --- |
| `tendi_family_dev` | `tendi-family-dev-db-2026-11-06.sql` | `npm run dev`, manual testing, Tendi-new |
| `tendi_family_test` | The same file, reset before each test run | `npm test` |

**The `family_api` account.** Created with section 6 of `tendi_family_module.sql` as `family_api@localhost`, password in `.env`. It may write the family tables, update only `children.family_id` and the 28 parent columns, insert missing `children_additional_information` rows, read `children`, `classes`, `branches`, `admin_api_tokens` and six columns of `admin`, and insert into `audit_logs`. It can't delete relationship types or read `admin.password`. The lock triggers let a write to the 28 columns through only from this account with `@family_mirror = 1`.

**Pool settings:** mysql2 promise pool, `charset: 'utf8mb4'`, `dateStrings: true` (the legacy tables hold `0000-00-00` dates), `timezone: 'Z'`, `supportBigNumbers: true`, `namedPlaceholders: true`, `connectionLimit` from env (default 10). Read `bit(1)` columns as numbers (`col + 0`).

**What the database already enforces** (the API maps each failure to a clear error, section on errors):

| Rule | How | MariaDB error -> API |
| --- | --- | --- |
| One primary phone, email, address per contact | Unique key on `primary_family_contact_id` | 1062 -> 409 `SECOND_PRIMARY` |
| A name only on an "Other" type | Checks `chk_fcp/fce/fca_type_label` | 4025 -> 400 `TYPE_LABEL_NOT_ALLOWED` |
| Relationship from the list | Foreign key to `relationship_types` | 1452 -> 400 `UNKNOWN_RELATIONSHIP` |
| One membership per contact per household | Unique `uniq_fm` | 1062 -> 409 `ALREADY_MEMBER` |
| One rights row per member per child | Unique `uniq_fmc` | 1062 -> 409 `DUPLICATE_RIGHTS` |
| No hard delete of used rows | Foreign keys ON DELETE RESTRICT | 1451 -> 409 `IN_USE` |
| `phone_normalized` | Computed by the database; never sent by the API | — |

To change a primary, clear the old primary first in the same transaction, then set the new one.

## API routes

All routes sit under `/api/v1`, need a staff bearer token, and are tagged `family` with an `operationId` in the OpenAPI document. **Staff** = the types in `ALLOWED_STAFF_TYPES` (admin and office; superadmin is decision D5). **Relationship admins** = `RELATIONSHIP_ADMIN_TYPES` (admin, superadmin). Every write returns `affected_child_ids`: the linked children whose old columns it re-mirrored.

| Method | Path | Purpose | Who |
| --- | --- | --- | --- |
| GET | `/health` | Pool and schema check | No token |
| GET | `/families?q=&page=&pageSize=` | Search by family name, contact name or any phone; paged | Staff |
| POST | `/families` | Create a household | Staff |
| GET | `/families/:id` | Household with members, their phones, emails and addresses, linked children and rights | Staff |
| PATCH | `/families/:id` | Name, household phone, status | Staff |
| POST | `/families/:id/members` | Add a contact (existing by id, or new) with a relationship | Staff |
| PATCH | `/families/:id/members/:memberId` | Relationship, main contact, order | Staff |
| DELETE | `/families/:id/members/:memberId` | Remove (status trash) | Staff |
| GET | `/contacts?q=` | Find an existing contact to link, by name or phone | Staff |
| GET | `/contacts/:id` | A contact with every household they belong to | Staff |
| PATCH | `/contacts/:id` | Name, Hebrew name, occupation, employer, note | Staff |
| PUT | `/contacts/:id/phones` | Replace the phone list: type, type_label, channel, primary, order | Staff |
| PUT | `/contacts/:id/emails` | Replace the email list | Staff |
| PUT | `/contacts/:id/addresses` | Replace the address list | Staff |
| PUT | `/families/:id/children/:childId/rights` | Rights per member for one child | Staff |
| GET | `/families/:id/children/:childId/preview` | The 28 old values today and after linking | Staff |
| POST | `/families/:id/children/:childId/link` | Link the child and write the 28 values | Staff |
| POST | `/children/:childId/unlink` | Set `family_id` back to NULL; values stay | Staff |
| GET | `/children/:childId/family` | The child's family, or its draft family if not linked | Staff |
| GET | `/relationship-types` | The dropdown, active types in order | Staff |
| POST | `/relationship-types` | Add a type | Relationship admins |
| PATCH | `/relationship-types/:code` | Rename, reorder, deactivate; the 4 parent types are locked (409) | Relationship admins |

The routes say **contacts**, not people, to match the design review. If Tendi-new already calls `/people`, keep `/people` as a deprecated alias until its screens move over (B4).

## The mirror service

One pure function, `deriveLegacyValues(child, family)`, turns the family tables into the 28 old parent values; one writer, `writeMirror(tx, childIds)`, writes them. Every write route calls the writer inside its own transaction, so the family record and the old columns always change together.

**Father** = the active member whose relationship type has `parent_slot = 'father'`: lowest `slot_rank` first (`father` before `step_father`), then lowest `sort_order`, then lowest member id. **Mother** likewise.

**On `children` (10 columns)**

| Old column | Value |
| --- | --- |
| `father_name`, `mother_name` | `legacy_full_name` of the father / mother |
| `father_phone`, `mother_phone` | Their mobile: the primary phone if it is a mobile, else the first mobile, else empty. Home, work and other phones never fill these |
| `home_phone` | `families.household_phone` |
| `parent_email` | Primary email of the member marked payment-responsible for this child, else of the household's main contact |
| `use_father_phone_for_notification`, `use_mother_phone_for_notification` | That parent's `receives_notifications` for this child |
| `notification_father_phone_method`, `notification_mother_phone_method` | That parent's `notify_method` for this child |

**On `children_additional_information` (18 columns, 9 per parent)**

| Old column (father_* and mother_*) | Value |
| --- | --- |
| `*_fname`, `*_lname` | `family_contacts.fname`, `lname` |
| `*_email` | The parent's primary email |
| `*_home_phone` | The parent's home phone (primary first), else `families.household_phone` |
| `*_office_phone` | The parent's work phone (primary first) |
| `*_address` | The parent's home address (primary first), its parts joined: `line1, line2, city, state zip`, empty parts left out |
| `*_work_address` | The parent's work address, joined the same way |
| `*_occupation`, `*_employer` | `family_contacts.occupation`, `employer` |

**Rules for every write**

1. An empty slot writes empty values the way the old column stores them today, and the defaults `0` and `voice` for the flags and methods. `home_send_notification` is never touched.
2. A value longer than its old column is refused with 409 `VALUE_TOO_LONG`, naming the column. Never cut a value short.
3. A linked child without a `children_additional_information` row gets one.
4. Only columns whose value changes are written.
5. Before writing: `SET @family_mirror = 1`. After, in a `finally` block: `SET @family_mirror = NULL`. The lock triggers let the write through only from `family_api` with the flag set.
6. Affected children: a family, member or rights change re-mirrors that family's linked children; a contact, phone, email or address change re-mirrors the linked children of every family the contact belongs to.
7. Each transaction starts with `SELECT ... FOR UPDATE` on the family rows it touches, so two saves on one family run one after the other. On MariaDB error 1213 (deadlock; Galera in production) retry the whole transaction once.

**Parity check:** in the dev database, `deriveLegacyValues` must return today's stored values for all 624 linked children. They were linked only where those values matched, so any difference is a bug in the TypeScript. `family_backfill_report.csv` lists the expected differences for the 83 unlinked children with family data.

## Auth, errors, audit and logging

**Staff auth.** `Authorization: Bearer <token>`. The API takes the md5 of the token, finds it in `admin_api_tokens.token_hash`, joins `admin`, and requires `admin.status = 'active'` and a staff type in `ALLOWED_STAFF_TYPES`. Unknown token or inactive account: 401. Wrong staff type: 403. It sets `request.staff = { adminId, type, name }` and updates `last_seen_at`. For local work, `npm run family:dev-token -- --admin <id>` creates a token for an active admin and prints it once; it refuses any database except `tendi_family_dev` and `tendi_family_test`. Real sign-in waits for the PHP team's answers on how tokens and passwords are stored.

**Errors.** One shape for every error: `{ statusCode, code, error, message, details? }`. Validation errors are 400 `VALIDATION` with the field paths in `details`. MariaDB errors are mapped by the table in the Database section; anything else is a 500 that logs the SQL error and returns no SQL to the client.

**Audit.** Every write adds `audit_logs` rows in the same transaction, one per changed column: `type 'family'`, `table_name`, `table_id`, `action` (insert, update, delete), `col_name`, `old_value`, `new_value`, `user_id` = the staff id, `actor_type 'staff'`, `actor_ref 'tendi-new'`. The transaction also runs `SET @audit_user = <staff id>`, so the legacy `ra_*` triggers on `children` and `children_additional_information` record the mirror's writes under the right person.

**Logging.** Pino, JSON in production and pretty in development. Each log line carries the request id (from `x-request-id`, or generated) and the staff id. The `authorization` header, tokens and passwords are redacted. Never log contact details at info level.

**Security plugins.** Helmet; CORS only for the origins in `CORS_ORIGIN`; rate limits per token and per IP; request bodies capped at 100 KB; the OpenAPI viewer at `/docs` only outside production.

**Environment variables** (validated at start-up, listed in `.env.example`): `NODE_ENV`, `PORT`, `HOST`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `FAMILY_DB_USER`, `FAMILY_DB_PASSWORD`, `DB_POOL_SIZE`, `CORS_ORIGIN`, `ALLOWED_STAFF_TYPES`, `RELATIONSHIP_ADMIN_TYPES`, `LOG_LEVEL`. Start-up refuses a `DB_HOST` other than 127.0.0.1 or localhost unless `NODE_ENV=production`.

## Testing

Vitest 5 against a real MariaDB: `tendi_family_test`, rebuilt from the dev dump by `npm run db:test:reset` before a run. No mocks for the database. Files run one at a time (`fileParallelism: false`), and each test that writes runs in a transaction it rolls back, or resets the rows it touched.

| Suite | What it proves |
| --- | --- |
| `test:unit` | `deriveLegacyValues` for each case: father only, mother only, step-parent in the slot, both parents, two payment-responsible members, contact in two households, no mobile, home phone but no mobile, an "Other" phone with a name, a value too long for its column |
| `test:db` | Schema matches `tendi_family_module.sql`; parity for all 624 linked children; `family_api` can't update a non-parent column of `children`; the lock puts back a root write to a linked child's parent column and logs it |
| `test:api` | Every route through `app.inject()`: 200 path, 400 validation, 401, 403, 404 and every 409 code; each write updates the old columns of its affected children in the same transaction and returns `affected_child_ids`; a failed write leaves both the family tables and the old columns unchanged |

Also: two concurrent edits to one family both succeed one after the other; a 9-child family edit completes in under 300 ms locally; the exported `openapi/family.json` matches the running app.

## Build steps B0 to B5

Paste each prompt into Claude Code in the Tendi-new-API folder, in plan mode. Put this guide in `docs/family-module/BACKEND-GUIDE.md` first (this file, renamed), so the prompts can refer to it.

### B0 Upgrade or scaffold

```text
Read CLAUDE.md, docs/CONTEXT.md and docs/family-module/BACKEND-GUIDE.md (sections "Stack and versions" and "Project layout"). Work on branch family/b0-stack from an up-to-date main.
If this project already exists: upgrade to exactly the versions in "Stack and versions" (Node 26 in engines and .nvmrc; replace every @sinclair/typebox import with typebox or the re-export from @fastify/type-provider-typebox), then fix what Fastify 5 breaks, using the rules listed under the table. If it doesn't exist: scaffold it as in "Project layout", ESM TypeScript, with buildApp() in src/app.ts and listen in src/server.ts.
Use exact versions in package.json (no ^ or ~), npm only, no Docker. If a tool fails with TypeScript 7, use 6.0.3 and tell me which tool.
Write docs/UPGRADE-2026-11.md: what changed, what broke, what's left. Run typecheck, lint and every test suite.
```

**Done when:** `npm ls` shows the pinned versions, and typecheck, lint and all existing tests pass.

### B1 Databases, account and table names

```text
Read BACKEND-GUIDE.md "Database". The schema comes only from ../db/tendi_family_module.sql (revision 3) and the data from ../db/tendi-family-dev-db-2026-11-06.sql. Branch family/b1-database.
1. npm run db:dev:reset and db:test:reset: create tendi_family_dev / tendi_family_test (utf8mb4, utf8mb4_general_ci) and import the dev dump with the mariadb client. Refuse any host but 127.0.0.1 or localhost and any other database name.
2. Create family_api@localhost with the grants in section 6 of tendi_family_module.sql on both databases, password from .env.
3. If this project has its own migrations for the family tables, retire them: the family schema comes only from tendi_family_module.sql. Add npm run db:verify-schema, which compares columns, types, generated columns, indexes, foreign keys with their rules, check constraints and the two lock triggers of a database with a fresh build of the 2026-09-24 dump plus tendi_family_module.sql, and fails on any difference.
4. Rename in code, tests and docs: people -> family_contacts, people_phones/emails/addresses -> family_contact_phones/emails/addresses, person_id -> family_contact_id, primary_person_id -> primary_family_contact_id. Search to prove nothing uses the old names.
5. src/plugins/db.ts: one mysql2 promise pool as family_api with the settings in "Pool settings", and lib/withTransaction(fn) that every write uses.
Run db:verify-schema on both databases and show me the output.
```

**Done when:** `db:verify-schema` passes on both databases and a search finds no old table or column names.

### B2 App core: config, errors, security, OpenAPI, health

```text
Read BACKEND-GUIDE.md "Auth, errors, audit and logging" and "API routes". Branch family/b2-core.
1. config/env.ts: @fastify/env with a TypeBox schema for every variable listed; .env.example with all of them and no secrets; the DB_HOST guard.
2. The TypeBox type provider for the whole app; Ajv with removeAdditional: false, useDefaults: true, and coerceTypes only for querystring and params.
3. plugins/errors.ts: the single error shape; validation errors as 400 VALIDATION with field paths; the MariaDB error mapping from the "Database" section (match on the error number and the key or constraint name); 500 for anything else, logged with the request id, no SQL in the response.
4. plugins/security.ts: helmet, CORS from CORS_ORIGIN, rate limits per token and IP, a 100 KB body limit, x-request-id in and out, pino redaction of authorization and tokens.
5. plugins/openapi.ts: @fastify/swagger with an operationId and the tag family on every route, the viewer at /docs outside production, and npm run export:openapi writing openapi/family.json.
6. GET /api/v1/health: pings the pool and checks that children.family_id and the 9 family tables exist.
Tests for the error mapping (one per MariaDB error in the table), the env guard, and health.
```

**Done when:** `/api/v1/health` answers, `/docs` shows the API, and the error tests pass.

### B3 Staff auth and roles

```text
Read BACKEND-GUIDE.md "Auth, errors, audit and logging" (Staff auth). Branch family/b3-auth.
1. plugins/auth.ts: a preHandler on every family route except health. Bearer token -> md5 -> admin_api_tokens.token_hash, join admin; require status active and a type in ALLOWED_STAFF_TYPES; set request.staff = { adminId, type, name }; update last_seen_at. 401 for unknown tokens and inactive accounts, 403 for other staff types. A requireRelationshipAdmin guard for RELATIONSHIP_ADMIN_TYPES.
2. scripts/dev-token.ts as npm run family:dev-token -- --admin <id> (and --revoke <id>): creates an admin_api_tokens row (device_id tendi-new-dev, app_version dev) for an active admin and prints the token once. It refuses any database except tendi_family_dev and tendi_family_test.
3. Never log tokens.
Tests: valid token, unknown token 401, inactive admin 401, teacher 403, office allowed, relationship admin guard.
```

**Done when:** the auth tests pass and a dev token opens `/api/v1/families` on the dev database.

### B4 Read routes

```text
Read BACKEND-GUIDE.md "API routes". Branch family/b4-read. Implement or align, with TypeBox schemas for params, querystring and response (full JSON Schemas):
1. GET /families?q=&page=&pageSize=: only active families; q matches families.name, family_contacts fname, lname and legacy_full_name, and any phone (when q has 7 or more digits, normalize it to its last 10 digits and match family_contact_phones.phone_normalized and families.household_phone). Return id, name, household_phone, member names with relationship, linked children (id, fname, lname, class) and counts. pageSize at most 100. Show me the EXPLAIN of the phone search: it must use idx_fcp_norm.
2. GET /families/:id: the household with members (contact, relationship and its label, is_primary, sort_order), each contact's phones (type, type_label, channel, primary), emails and addresses, the linked children, and the rights rows per member per child. 404 for unknown or trashed.
3. GET /contacts?q= and GET /contacts/:id (with every household they are in).
4. GET /children/:childId/family: the linked family, or the draft family whose rights rows include the child, marked linked or draft.
5. GET /relationship-types: active types in sort_order.
6. If Tendi-new calls /people today, add /people as a deprecated alias of /contacts with a Deprecation header.
API tests against tendi_family_test with real families from the dev data.
```

**Done when:** every read route has schemas and tests, and the phone search uses `idx_fcp_norm`.

### B5 The mirror service

```text
Read BACKEND-GUIDE.md "The mirror service" carefully. Branch family/b5-mirror.
1. services/mirror/derive.ts: deriveLegacyValues(child, family) as a pure function implementing every rule in that section, returning the 10 children values and the 18 children_additional_information values. Look up old column lengths from information_schema once at start-up.
2. services/mirror/write.ts: writeMirror(tx, childIds): loads what it needs, derives, compares with the stored values, creates a missing children_additional_information row, refuses a too-long value with 409 VALUE_TOO_LONG naming the column, writes only changed columns, sets @family_mirror = 1 before and NULL in a finally block, and returns the ids it changed.
3. services/mirror/affected.ts: affectedChildIds for a family change and for a contact change, per rule 6.
4. Unit tests for every case in the "Testing" table, and the parity test: for all 624 linked children in tendi_family_test, deriveLegacyValues equals the stored values. Print any difference with the child id, column and both values.
Do not wire the writer into routes yet.
```

**Done when:** the unit tests pass and the parity test reports 0 differences for the 624 linked children.

## Build steps B6 to B11

### B6 Family, member and contact writes

```text
Read BACKEND-GUIDE.md "API routes", "The mirror service" (rules 5 to 7) and "Audit". Branch family/b6-writes. Implement or align, every write inside withTransaction:
1. POST /families, PATCH /families/:id (name, household_phone, status).
2. POST /families/:id/members (existing contact by id, or a new contact with its fields), PATCH and DELETE (status trash) /families/:id/members/:memberId. A relationship must be an active relationship_types code. Setting is_primary clears the household's other main contact in the same transaction.
3. PATCH /contacts/:id (fname, lname, hebrew_name, occupation, employer, note). Editing fname or lname sets legacy_full_name to "fname lname".
4. PUT /contacts/:id/phones, /emails, /addresses: replace the whole list. Validate: at most one primary, and exactly one when the list isn't empty; type_label only when the type is other, trimmed, at most 50 characters; phone_normalized is never accepted. Clear the old primary before setting the new one.
5. Each write: SELECT ... FOR UPDATE on the families it touches, the change, writeMirror for affectedChildIds, audit_logs rows per changed column, SET @audit_user = staff id; retry once on error 1213. Respond with the updated resource and affected_child_ids.
API tests: each route, each 409 code, and that a write to a contact in two households re-mirrors the linked children of both. A failed write changes nothing in either the family tables or the old columns.
```

**Done when:** every write route passes its tests, and editing a linked parent's mobile changes `children.father_phone` for every linked sibling in the same transaction.

### B7 Rights, preview, link and unlink

```text
Read BACKEND-GUIDE.md "API routes" and "The mirror service". Branch family/b7-link.
1. PUT /families/:id/children/:childId/rights: the rights rows for every member of the family for this child (receives_notifications, notify_method, may_collect, collect_from, collect_to with collect_to >= collect_from, is_emergency, is_payment_responsible). Re-mirrors the child if linked.
2. GET /families/:id/children/:childId/preview: the 28 values today and after linking, each marked changed or not, and any too-long value. Writes nothing.
3. POST /families/:id/children/:childId/link: refuses with 409 when the child is linked to another family or the family has no active member. In one transaction: SET @family_mirror = 1, set children.family_id, writeMirror for the child (creating its children_additional_information row if missing), audit, clear the flag in finally.
4. POST /children/:childId/unlink: sets family_id back to NULL under the flag; the 28 values stay.
Tests on the dev data: link one of the 83 unlinked children with family data and compare the result with its row in family_backfill_report.csv; link then unlink a child and check the values stay; a root UPDATE of a linked child's father_name is put back and logged in family_mirror_lock_log.
```

**Done when:** preview, link and unlink pass their tests, and linking writes exactly the values the preview showed.

### B8 Relationship types

```text
Read BACKEND-GUIDE.md "API routes". Branch family/b8-relationship-types.
POST /relationship-types (code: lowercase letters and _ only, at most 32; label at most 64; sort_order) and PATCH /relationship-types/:code (label, sort_order, status), both for relationship admins only. father, mother, step_father and step_mother are locked: renaming or deactivating them is 409 LOCKED_TYPE. Codes never change and types are never deleted. An inactive type is not accepted for new members; existing members keep it. Audit every change. Tests for each rule.
```

**Done when:** the rules are tested and the dropdown route only returns active types.

### B9 Reconciliation check

```text
Read BACKEND-GUIDE.md "The mirror service". Branch family/b9-reconcile. Add npm run family:reconcile: for every linked child, compare deriveLegacyValues with the stored 28 values and report each difference (child, column, stored, derived) as a table and as results/reconcile-<date>.json. It never writes and exits with code 1 when there is any difference. Add a --child <id> --fix option that re-runs writeMirror for one child in a transaction, for use after a manual SQL change. No scheduled job.
```

**Done when:** a run on the dev database reports 0 differences, and a deliberate SQL change to one contact's phone shows up as a difference.

### B10 Hardening and performance

```text
Branch family/b10-hardening.
1. Two concurrent saves to one family both succeed, one after the other (test with Promise.all against app.inject).
2. A save on the largest family in the dev data (9 children) takes under 300 ms locally; report the timings of the slowest five routes.
3. Check every SQL statement uses placeholders, every list route is paged, and every response schema leaves out fields it doesn't declare.
4. Run npm audit and update anything flagged that has a fix within the pinned major versions.
5. Update docs/CONTEXT.md: how to start, the databases, the account, the mirror, the lock, the scripts.
```

**Done when:** the concurrency and timing checks pass and `docs/CONTEXT.md` is current.

### B11 Final check

```text
On main after merging B0 to B10: npm run db:test:reset, db:verify-schema, typecheck, lint, test (all suites), family:reconcile, export:openapi. Then start the API on tendi_family_dev, get a dev token, and walk through: search a family by phone, open it, add a grandmother with an "Other" phone named "Grandma's cell", edit the father's mobile, preview and link an unlinked child, unlink it. After each step, show the old columns of the affected children. Report anything that differs from BACKEND-GUIDE.md.
```

**Done when:** every command passes and the walk-through matches the guide. Tendi-new can then regenerate its types from `openapi/family.json`.

### Verify a step (run after each step, before merging)

```text
Check the work on this branch against docs/family-module/BACKEND-GUIDE.md and the step's prompt. List: what the step asked for and whether each item is done; any change outside the step's scope; npm run typecheck, lint and test results; any use of the old table names; any SQL without placeholders; any write outside withTransaction or without writeMirror and audit. End with a merge / don't merge verdict and the reason. Change nothing.
```

## Open items

- [ ] **D5:** does `superadmin` join `admin` and `office` in `ALLOWED_STAFF_TYPES`? Config only, no code change.
- [ ] **Real staff sign-in:** waits for the PHP team to confirm how `admin_api_tokens.token_hash` and `admin.password` are made and whether tokens expire. Until then, dev tokens only.
- [ ] **One main contact per household:** not enforced by the database yet. The API enforces it (B6); a database rule needs `fk_fm_family` changed to ON UPDATE RESTRICT.
- [ ] **`/people` alias:** remove it once Tendi-new calls `/contacts`.
- [ ] **Confirm with Mr. Khan:** the `family_contacts` names, keeping `phone_normalized`, and the two lock triggers.

## Sources

- Package versions: the npm registry (`npm view <package> version`), checked November 6, 2026; Fastify's `next` tag is 6.0.0-alpha.6.
- Fastify V5 Migration Guide (https://fastify.dev/docs/latest/Guides/Migration-Guide-V5.md): Node 20 minimum, full JSON Schemas, `loggerInstance`, `routeOptions` and the other changes listed under the stack table.
- Node.js release lines (https://endoflife.date/nodejs): Node 26 is the Active LTS, security support until April 30, 2029.
- @fastify/type-provider-typebox on npm (https://www.npmjs.com/package/@fastify/type-provider-typebox): version 6 takes `typebox` as its peer dependency.
- The database: `tendi_family_module.sql` (revision 3), `tendi-family-dev-db-2026-11-06.sql`, and the Tendi Family Module design document of October 29, 2026.
