# Family API

This service is the only writer of the family tables and, through its mirror, of the 28 old parent columns on linked children. The legacy PHP app keeps reading those columns. The API never changes a legacy table's structure.

The build steps and the rules for each one are in [family-module/BACKEND-GUIDE.md](family-module/BACKEND-GUIDE.md).

## Current state

B0 is the Fastify scaffold. B1 adds the local databases, the `family_api` account, one mysql2 pool, and `withTransaction()`. There is still no auth and no family route. `GET /api/v1/health` is not implemented.

## Databases

Reset and schema checks use `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` from `.env` (the MariaDB admin). The API process uses only `family_api`.

```bash
npm run db:dev:reset
npm run db:test:reset
npm run db:verify-schema
```

`db:dev:reset` and `db:test:reset` drop and recreate `tendi_family_dev` or `tendi_family_test` (`utf8mb4` / `utf8mb4_general_ci`), import `db/tendi-family-dev-db-2026-11-06.sql`, and grant `family_api` on every local family database that exists. They refuse any host other than `127.0.0.1` or `localhost`, and any database name other than those two.

`db/tendi_family_module.sql` is the 2026-09-24 dump with family revision 3 applied. It has no `CREATE USER`. `db:verify-schema` imports it into `tendi_family_schema_ref` and compares columns, generated columns, indexes, foreign keys and their rules, check constraints, and the two lock triggers. The account grants follow the design's section 6 table: full access to the seven family tables, no delete on `relationship_types`, update only `children.family_id` and the 28 parent columns, insert on `children_additional_information`, read on `classes`, `branches`, and `admin_api_tokens`, six columns of `admin` (not `password`), and insert on `audit_logs`. The account is created for both `localhost` and `127.0.0.1` because the pool connects to `DB_HOST`.

The pool is one mysql2 promise pool: `utf8mb4`, `dateStrings: true`, `timezone: 'Z'`, `supportBigNumbers`, named placeholders, and `bit(1)` values as numbers. `withTransaction()` commits or rolls back, clears `@family_mirror` and `@audit_user` before releasing the connection, and retries once on error 1213.

## How to start

Requirements: Node.js 26 (`engines` and `.nvmrc`) and local MariaDB 10.11. Put the MariaDB admin password in `DB_ADMIN_PASSWORD` before the reset scripts. The API password is `FAMILY_DB_PASSWORD`.

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

From B6 onward, a write runs in one transaction: lock the family rows, update the family tables, mirror the 28 old columns for the affected children, and write `audit_logs`. If any step fails, the family tables and the old columns roll back together.

## Scripts

`dev`, `build`, `start`, `typecheck`, `lint`, `test`, `db:dev:reset`, `db:test:reset`, and `db:verify-schema` work. Dev tokens, reconcile, and the OpenAPI export still exit with a message until their step is built.

## Open items

- D5: `superadmin` is not in `ALLOWED_STAFF_TYPES`. Relationship-type writes still list `admin` and `superadmin` in `RELATIONSHIP_ADMIN_TYPES`.
- Real staff sign-in waits on the PHP team. Dev tokens arrive in B3.
- The original commented section 6 SQL was not in the dump file. Grants are generated from the design's account table.
