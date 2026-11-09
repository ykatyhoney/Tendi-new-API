# Tendi Family API

Fastify 5 API for Tendi's family module. It is the only writer of the family tables and, through its mirror, of the 28 old parent columns on linked children that the legacy PHP app still reads.

```bash
nvm use 26             # Node 26, see .nvmrc
npm install
cp .env.example .env   # set DB_ADMIN_PASSWORD and FAMILY_DB_PASSWORD
npm run db:dev:reset   # local MariaDB 10.11 only
npm run dev            # http://127.0.0.1:3000, OpenAPI viewer at /docs
```

| Command | What it does |
| --- | --- |
| `npm run test:unit` | Unit tests. No database needed. |
| `npm test` | Resets `tendi_family_test`, then runs every suite. |
| `npm run db:verify-schema` | Compares both local databases with `db/tendi_family_module.sql`. |
| `npm run family:reconcile` | Compares every linked child's 28 old columns with the derived values. |
| `npm run export:openapi` | Writes `openapi/family.json`. A unit test fails when it is out of date. |

- [docs/CONTEXT.md](docs/CONTEXT.md): how the project works today: databases, the account, the mirror, locking, scripts, open items.
- [docs/family-module/BACKEND-GUIDE.md](docs/family-module/BACKEND-GUIDE.md): the build guide and its rules.
- [openapi/family.json](openapi/family.json): the contract Tendi-new generates its types from.
