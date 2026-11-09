# Tendi Family API: working rules

Read [docs/CONTEXT.md](docs/CONTEXT.md) first. The build guide is [docs/family-module/BACKEND-GUIDE.md](docs/family-module/BACKEND-GUIDE.md).

## Hard rules

- npm only, no Docker. Local MariaDB 10.11 only (`tendi_family_dev`, `tendi_family_test` on 127.0.0.1). Never production.
- The API never creates, alters, or drops a table. The schema belongs to `db/tendi_family_module.sql`; schema changes go to its owner.
- No real SMS or email.
- Exact dependency versions (no `^` or `~`). Node 26.
- Work directly on `main`. No feature branches. This replaces the build guide's one-branch-per-step rule (decided 9 November 2026).

## How a write works

Every write runs in `withStaffTransaction()` (READ COMMITTED; see the comment in `src/lib/with-transaction.ts` for why that is required), and in this order:

1. Lock the family rows with `lockFamilies()` (ascending id) or `lockContactFamilies()`, then the contact or child row.
2. Change the family tables. Write only changed columns, and audit each one with `writeAudit()`.
3. `writeMirror(connection, affectedChildIds…)` for the affected linked children.
4. Build the response on the same connection (`finishFamily`, `finishContact`, `readRights`, `finishType`), so a failed read rolls the save back instead of reporting a 500 for a committed write.

## Layout

- `src/modules/family/schemas/`: TypeBox. Shared enums and sub-objects live in `common.ts`; reuse them.
- `src/modules/family/repositories/`: read SQL shared by several services. Functions take `Sql` (a pool or a transaction connection).
- `src/modules/family/services/`: reads compose repositories and map rows with `mappers.ts`. `services/write/*`, `links.ts`, and `relationship-types.ts` hold their write SQL next to the locking and audit that must surround it.
- `src/modules/family/services/mirror/`: `derive.ts` is pure; `load.ts` reads; `write.ts` writes under `@family_mirror = 1`.
- Errors: throw `ApiError(status, CODE, message, details?)`. MariaDB errors are mapped in `src/lib/db-errors.ts`. Every route documents the `ApiError` body for 4XX and 5XX.

## Before you finish

```bash
npm run typecheck && npm run lint && npm run test:unit
npm run export:openapi   # after any route or schema change; test/unit/openapi.test.ts checks it
npm test                 # needs local MariaDB; resets tendi_family_test first
```
