# Upgrade notes, 6 November 2026

B0 scaffolded this repository. There was no existing Family API to upgrade: no `package.json`, no `src/`, and no earlier `people` tables in code. The November 6 dump already uses the new table names (`family_contacts`, not `people`).

## What changed

- Added an ESM TypeScript app: `buildApp()` in `src/app.ts`, `listen({ port, host })` in `src/server.ts`.
- Pinned the stack from the backend guide. Direct dependencies use exact versions.
- Added `@fastify/type-provider-typebox` 6 with the `typebox` package. No `@sinclair/typebox` dependency.
- Validated the environment with `@fastify/env` and a TypeBox schema. Startup refuses a non-local `DB_HOST` unless `NODE_ENV=production`.
- Moved the dump, the seed, and the backfill report into `db/`. Copied the build guide to `docs/family-module/BACKEND-GUIDE.md`.
- `engines` and `.nvmrc` require Node.js 26.

`ajv-formats` 3.0.1 is a direct dependency because `@fastify/type-provider-typebox` 6.3.0 peers on it. ESLint 10.14.0, `@eslint/js` 10.0.1, and typescript-eslint 8.72.1 are dev dependencies so `npm run lint` exists. The guide's version table does not list them.

## What broke

**TypeScript 7.0.2 is not used.** typescript-eslint 8.72.1 (the current release) declares `typescript >=4.8.4 <6.1.0`. TypeScript 7.0.2 is outside that range, so the compiler is pinned to **6.0.3**, the fallback named in the guide. The tool that blocks TypeScript 7 is typescript-eslint.

**This machine is on Node.js 24.12.0.** `npm install` warns `EBADENGINE` because `engines` requires Node 26. Typecheck, lint, and tests were run on Node 24. Install Node 26 before treating the runtime as the one the API ships on. No Node 26 binary was installed onto the machine.

**Update, 9 November 2026:** Node 26.13.0 (LTS) is installed with nvm-windows. Typecheck, lint, all tests, `family:reconcile`, `build`, and the compiled server pass on it. 24.12.0 stays the active nvm version until `nvm use 26.13.0`.

## What's left

- B1: import the dump into `tendi_family_dev` and `tendi_family_test`, create `family_api`, add the pool and `withTransaction`, and verify the schema. Blocked on `tendi_family_module.sql` for the grants and the schema comparison.
- B2 through B11: errors, security, OpenAPI, health, auth, reads, the mirror, writes, link, relationship types, reconcile, and the final walk-through.
- D5 is still open: `superadmin` is not in the default `ALLOWED_STAFF_TYPES`.
- `npm audit` reported 10 moderate findings after install. Those stay for B10, which updates only fixes inside the pinned major versions.
