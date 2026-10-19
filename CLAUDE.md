# Tendi-new-API

## Family module

The shared workspace rules are in `../CLAUDE.md`. Conventions for this project are in `docs/CONTEXT.md`.

1. This project owns the family database objects (migrations, procedures, triggers), the backfill scripts and the Family API.
2. Any change to a family route's request or response shape must update the TypeBox schemas, re-export `openapi/family.json` (`npm run export:openapi`), and be called out in the pull request description as a frontend-facing change.
3. Never drop, rename or change the type of an existing column. The 11 parent columns on `children` and the 18 on `children_additional_information` are written only by the database mirror for linked children.
4. The Family API writes only to `families`, `people`, `family_members`, `people_phones`, `people_addresses`, `family_member_children` and `children.family_id`, plus the `audit_logs` row required by rule 5.
5. Every family write runs in one transaction and writes an `audit_logs` row.
6. Family documents this project produces (proof report, runbook) go in `docs/family/`.
7. Anything that sets `children.family_id` (linking, unlinking, link/lock demos, fixtures, tests, API calls) runs only against `tendi_family_test`, never `tendi_family_dev`. Setting it fires the mirror, which overwrites the child's 29 legacy columns. `tendi_family_dev` must keep the dump's legacy values for the backfill and the proof run.
