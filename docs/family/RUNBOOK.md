# Family module: production rollout runbook

How to roll the family module out to production: PLAN.md "Rollout" Phases 2 to 4, gates B, C and the start of the pilot. Each step gives the command, the check after it, the expected output, what to do if the check fails, and who signs off. Rolling back follows PLAN.md "Rollback plan" (summarised at the end).

This document holds no personal data (CLAUDE.md rule 6). Files the steps write that contain personal data (the backup, the backfill review CSV, the full proof diff, smoke-test baselines) stay in the git-ignored `var/` on the operator's machine, or wherever the backup policy says. They are never committed.

**Status: not runnable yet.** The prerequisites below are open, and the steps marked `TODO(Pn)` depend on them. Nothing in this runbook has been run against production.

## Prerequisites

Every item must be closed before step 1, unless the item says otherwise.

| # | Prerequisite | Why | Status |
| --- | --- | --- | --- |
| P0 | **Gate A** passed: all tests pass, D1 to D5 decided, PLAN.md signed off. | PLAN.md "Rollout", Phase 1. | Open: PLAN.md still lists D1 to D4 as Pending. D5 was settled on 2026-10-21 (`admin`, `office`). |
| P1 | **A production mode for the family scripts.** Today `scripts/family/_common.sh` and `scripts/family/lib/db.ts` refuse a non-local `DB_HOST`, a database not named `tendi_family_*`, and a server whose `@@hostname` is not this machine. So `migrate`, `family:backfill`, `family:proof-run`, `family:reconcile` and `db:family:grants` cannot reach production. It needs a separate, reviewed code change, for example an explicit opt-in that names the production database. | Steps 2 to 5 and 7 use these scripts. | Open. |
| P2 | **The migration runner can stop at a version** (proposed: `npm run db:family:migrate -- --to family_009`). Today `up` applies every pending migration. | Step 2 applies 001 to 009 only. | Open. |
| P3 | **The objects the backfill and the proof run need can be installed without any trigger or writing procedure.** These are the bookkeeping tables `family_019` to `family_021`, and the final read-only procedures `sp_family_parent_values`, `sp_family_mirror_values` and `sp_family_preview`. Their final definitions are in `family_022`, plus the DEFINER change in `family_024`. In version order these come after the writing procedures (013 to 015, 017) and the triggers (016, 018). `family_022` also re-creates `sp_family_mirror`, `sp_family_mirror_cai` and the `trg_children_family_bu` trigger on `children`. So `--to` (P2) alone cannot install them first. They need migrations of their own, or a separate proof-only install, decided by the Engineering lead. Committed migrations are never edited. | Step 3 runs before the triggers (Gate B before Phase 3, as PLAN.md orders it). | Open. |
| P4 | **Deploy process for Tendi-new-API and Tendi-new**: where each runs, how a release is built, shipped and rolled back, and where its environment is set. Neither project's `docs/CONTEXT.md` describes it. | Steps 5.2 and 5.4 are placeholders until then. | Open. |
| P5 | **Staff sign-in in production** (Tendi-new-API and Tendi-new CONTEXT.md, open question 1). `/dev-sign-in` is a 404 in production builds, and no other way to get a staff token exists. | The browser checks in step 5.4 and the whole pilot (step 7) need signed-in office staff. Steps 1 to 6 do not. | Open. |
| P6 | **CORS allows PUT, PATCH and DELETE.** `src/app.ts` registers `@fastify/cors` without `methods`, and its default is `GET,HEAD,POST`. Browsers therefore block every PUT, PATCH and DELETE from Tendi-new: rights, phones, addresses, person and member edits. Found on 2026-10-21 by Tendi-new's family E2E suite. | Check 5.2 e and every edit in the Families screens. | Open (one-line fix, not made yet). |
| P7 | **The `family_api` account's host.** `scripts/family/grants.sql` grants to `'family_api'@'localhost'`, which only works if Tendi-new-API runs on the database server. | Step 5.1. | Open: depends on P4. |
| P8 | **The proof run passes on the development copy.** The latest report (`docs/family/family-sync-proof.md`, 2026-10-19, `tendi_family_dev`) is **FAIL**: 1 unexplained difference (child 11153, `notification_mother_phone_method`). | Gate B on production is not worth attempting until the same rules pass on the dump. | Open. |
| P9 | **The migration account.** Migrations run as a user that can write the 28 legacy columns, `family_mirror_lock_log` and `record_audit` (the mirror's DEFINER rule, CONTEXT.md "Family database account"), on MariaDB 10.11.9. | Steps 2 to 4. | Open: needs DBA confirmation. |

## Conventions in the commands

Run from a Tendi-new-API checkout at the release commit, on the operator machine the deploy process names (P4), in bash. Credentials go in client option files, never on the command line, as the repo's scripts already do.

```bash
export PROD_DB='<production tenant database>'            # TODO(P4)
export API_URL='https://<Tendi-new-API host>'           # TODO(P4), no trailing slash
export WEB_URL='https://<Tendi-new host>'               # TODO(P4), no trailing slash
export MYSQL="mysql --defaults-extra-file=$HOME/.tendi-prod.cnf -N -B"   # migration account (P9)
mkdir -p var/rollout
```

Every SQL check runs as `$MYSQL -e "<query>" "$PROD_DB"`. Expected outputs are shown tab-separated, as `-N -B` prints them.

## 1. Pre-checks (before any change)

**1.1 Take the backup.**

```bash
mysqldump --defaults-extra-file=$HOME/.tendi-prod.cnf --single-transaction --routines --triggers --events --hex-blob "$PROD_DB" \
  | gzip > "var/rollout/$PROD_DB-before-family.sql.gz"
sha1sum "var/rollout/$PROD_DB-before-family.sql.gz" | tee var/rollout/backup.sha1
```

Check that it is restorable: restore it into a scratch database on a **non-production** MariaDB 10.11.9 server, then count what came back.

```bash
export SCRATCH="mysql --defaults-extra-file=$HOME/.tendi-scratch.cnf -N -B"
$SCRATCH -e "CREATE DATABASE tendi_family_restorecheck CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
gunzip -c "var/rollout/$PROD_DB-before-family.sql.gz" | mysql --defaults-extra-file=$HOME/.tendi-scratch.cnf tendi_family_restorecheck
$SCRATCH -e "SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'),
                    (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()),
                    (SELECT COUNT(*) FROM children), (SELECT COUNT(*) FROM children_additional_information)" tendi_family_restorecheck
```

Expected: the restore exits 0. The four numbers equal production's (1.2 and 1.3). For the 2026-09-24 dump they were `209  312  753  749`. Then drop the scratch database: `$SCRATCH -e "DROP DATABASE tendi_family_restorecheck"`.

**1.2 Save the current triggers and confirm nothing of the family module exists yet.**

```bash
$MYSQL -e "SHOW TRIGGERS" "$PROD_DB" > var/rollout/show-triggers-before.tsv
$MYSQL -e "SELECT EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER, TRIGGER_NAME
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY 1, 2, 3, 4" "$PROD_DB" \
  > var/rollout/trigger-order-before.tsv
$MYSQL -e "SELECT SUM(TRIGGER_NAME LIKE 'ra\\_%'), COUNT(DISTINCT IF(TRIGGER_NAME LIKE 'ra\\_%', EVENT_OBJECT_TABLE, NULL)),
                  SUM(TRIGGER_NAME LIKE 'trg\\_%'),
                  (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()),
                  (SELECT COUNT(*) FROM schema_migrations WHERE version LIKE 'family\\_%'),
                  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'children' AND COLUMN_NAME = 'family_id'),
                  VERSION()
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()" "$PROD_DB" | tee var/rollout/baseline.tsv
```

Expected: `<ra count>  <ra tables>  0  0  0  0  10.11.9-MariaDB…`. The dump had `312  104`. A different `ra_*` count in production is not a failure in itself: it is recorded, and step 4 must find the same one. Any `trg_*` trigger, routine, `family_` migration row or `family_id` column means a previous attempt was left behind. **Stop**, and find out what it was before going on.

**1.3 Record the row counts.**

```bash
$MYSQL -e "SELECT 'children', COUNT(*) FROM children
           UNION ALL SELECT 'children_additional_information', COUNT(*) FROM children_additional_information" "$PROD_DB" \
  | tee var/rollout/row-counts-before.tsv
```

Expected: two lines with the counts. The dump had `children 753` and `children_additional_information 749`; production today will be close to that.

**1.4 Smoke-test baseline** (for steps 6 and 7). The Office and operations lead picks one test child (`SMOKE_CHILD_ID`) whose parent details can be edited and put back. Before step 2, save that child's registration PDF, and write down where its SMS and statement email go and that the kiosk phone-PIN check-in works. Keep these with the backup (personal data).

**If any check fails:** stop. Nothing has changed yet.

**Sign-off:** Engineering lead.

## 2. Migrations 001 to 009: tables, `children.family_id`, lock log, occupation and employer

Needs P1 and P2.

```bash
npm run db:family:migrate -- --to family_009          # TODO(P1, P2): proposed interface
npm run db:family:migrate:status
```

Expected: `family_001` to `family_009` are applied in one batch, and `family_010` to `family_026` are pending.

Checks:

```bash
$MYSQL -e "SELECT COUNT(*), SUM(family_id IS NULL) FROM children" "$PROD_DB"
$MYSQL -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
             ('families','people','family_members','people_phones','people_addresses','family_member_children','family_mirror_lock_log')" "$PROD_DB"
$MYSQL -e "SELECT EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER, TRIGGER_NAME
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY 1, 2, 3, 4" "$PROD_DB" \
  | diff var/rollout/trigger-order-before.tsv - && echo "triggers unchanged"
```

Expected:

- **Every child has `family_id` NULL:** `<children>  <children>`, both equal to 1.3's `children` count.
- `7`.
- `triggers unchanged`.
- Re-running 1.3 gives the same counts.

**If a check fails:** `npm run db:family:migrate:down` reverts this batch. Re-run 1.2 and 1.3; they must match the baseline again.

**Sign-off:** Engineering lead.

## 3. Backfill (2.1) and proof run (2.2) on production data: Gate B

Needs P1, P3 and P8. No trigger and no writing procedure exists during this step.

**3.1 Install what the backfill and the proof run need.**

```bash
# TODO(P3): the command that installs family_019-021 and the final read-only procedures only
npm run db:family:migrate:status
```

Check:

```bash
$MYSQL -e "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY 1" "$PROD_DB"
$MYSQL -e "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg\\_%'" "$PROD_DB"
```

Expected: exactly `sp_family_mirror_values`, `sp_family_parent_values` and `sp_family_preview`, then `0`.

**3.2 Dry run of the backfill.** The options must be the ones decision D3 settles (the 2026-10-19 local proof used `--group-by-home-phone`, which is not in D3's recommendation). Use the same options in 3.2 and 3.3.

```bash
npm run family:backfill -- --dry-run --database "$PROD_DB"
$MYSQL -e "SELECT (SELECT COUNT(*) FROM families), (SELECT COUNT(*) FROM people), (SELECT COUNT(*) FROM family_member_children)" "$PROD_DB"
```

Expected: the script prints the planned counts ("Households by size", "Review items by reason code") and exits 0. The query prints `0  0  0`: nothing was written.

**3.3 Backfill.**

```bash
npm run family:backfill -- --database "$PROD_DB"
$MYSQL -e "SELECT COUNT(*), SUM(family_id IS NULL) FROM children" "$PROD_DB"
$MYSQL -e "SELECT id, status FROM family_backfill_runs ORDER BY id" "$PROD_DB"
```

Expected:

- The script exits 0 and prints the created counts, plus `Review CSV: var/family-backfill/review-run-<id>.csv (<n> items; contains personal data, keep it out of git)`.
- `<children>  <children>`: still every child unlinked.
- One run with status `done`.

**3.4 Proof run.**

```bash
npm run family:proof-run -- --database "$PROD_DB" --out var/family-proof/production-proof.md
echo "exit $?"
```

Expected:

```
Run <id>: <n> children checked -> PASS
  0 differences: <a>; accepted differences only: <b>; failing: 0
  differences: <d> (failures: 0), preview errors: 0
…
Read-only check: table checksums identical before and after.
exit 0
```

The report `var/family-proof/production-proof.md` (ids and counts only) starts with `## Result: PASS`.

**3.5 Review and repeat.** Office staff work through the review CSV and the full diff in `var/family-proof/`: households merged by a shared phone, typos, a step-parent in a parent slot, conflicting emails. They correct the source data in the legacy child form. Then repeat 3.3 with `--reset` added, and then 3.4, until the result is PASS. `--reset` deletes only the rows earlier backfill runs created.

**Gate B: stop unless the proof run shows 0 unexplained differences:** `-> PASS`, `failing: 0`, `preview errors: 0`, exit 0. Every accepted difference on the report has been read by the reviewers.

**If it does not pass:** do not go on to step 4. The draft families are inert (no child is linked and no trigger exists). They can stay while the data is fixed, or be removed with the next `--reset`.

**Sign-off (Gate B):** Engineering lead and Office and operations lead. Attach `production-proof.md` (no personal data) to the sign-off.

## 4. Procedure and trigger migrations (Steps 1.3 to 1.5)

```bash
npm run db:family:migrate                # TODO(P1): every remaining migration
npm run db:family:migrate:status
```

Expected: every migration from `family_001` to `family_026` shows as applied, and none is pending or failed.

Checks:

```bash
# Order of the triggers on the two legacy tables (SHOW TRIGGERS does not show the order)
$MYSQL -e "SELECT EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER, TRIGGER_NAME
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()
              AND EVENT_OBJECT_TABLE IN ('children', 'children_additional_information') ORDER BY 1, 2, 3, 4" "$PROD_DB"
$MYSQL -e "SHOW TRIGGERS" "$PROD_DB" > var/rollout/show-triggers-after.tsv

# ra_* audit triggers: the same names on the same tables as before
$MYSQL -e "SELECT EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, TRIGGER_NAME FROM information_schema.TRIGGERS
             WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'ra\\_%' ORDER BY 1, 2, 3, 4" "$PROD_DB" \
  | diff <(grep -P '\tra_' var/rollout/trigger-order-before.tsv | cut -f1,2,3,5) - && echo "ra_* triggers unchanged"

$MYSQL -e "SELECT SUM(TRIGGER_NAME LIKE 'trg\\_%'), (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()),
                  (SELECT COUNT(*) FROM children WHERE family_id IS NOT NULL), (SELECT COUNT(*) FROM family_mirror_lock_log)
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()" "$PROD_DB"
```

Expected trigger order. The family triggers come first, so the `ra_*` audit triggers see the final, mirrored values:

```
children                         AFTER   DELETE  1  ra_children_ad
children                         AFTER   INSERT  1  ra_children_ai
children                         AFTER   UPDATE  1  trg_children_family_au
children                         AFTER   UPDATE  2  ra_children_au
children                         BEFORE  UPDATE  1  trg_children_family_bu
children_additional_information  AFTER   DELETE  1  ra_children_additional_information_ad
children_additional_information  AFTER   INSERT  1  ra_children_additional_information_ai
children_additional_information  AFTER   UPDATE  1  ra_children_additional_information_au
children_additional_information  BEFORE  UPDATE  1  trg_cai_family_bu
```

This is the dump's set. If 1.2 recorded other `ra_*` triggers on these two tables in production, they appear too, after the family triggers.

Also expected:

- `ra_* triggers unchanged` (same count as 1.2).
- `17  7  0  0`:
  - 17 `trg_*` triggers: 14 on the six family tables, plus `trg_children_family_bu`, `trg_children_family_au` and `trg_cai_family_bu`;
  - the 7 family procedures;
  - no child linked;
  - an empty lock log.
- 1.3's row counts are unchanged.

**If a check fails:** revert the batch with `npm run db:family:migrate:down`. That drops the procedures and triggers, and the database then behaves as it did before this step. Re-run the checks of step 2.

**Sign-off:** Engineering lead.

## 5. Grants, then Tendi-new-API, then Tendi-new

**5.1 Apply `grants.sql`.** Needs P1 and P7.

```bash
npm run db:family:grants
```

Expected:

```
Account 'family_api'@'localhost': create if missing, set password, revoke all privileges
  <PROD_DB>: grants.sql applied
  <DB_TEST_NAME>: does not exist, skipped
```

`DB_TEST_NAME` must name a database that does not exist on the production server.

Checks:

```bash
$MYSQL -e "SHOW GRANTS FOR 'family_api'@'localhost'"
mysql --defaults-extra-file=$HOME/.tendi-prod-family-api.cnf -e "UPDATE children SET father_phone = father_phone WHERE 1 = 0" "$PROD_DB"
```

Expected:

- The grants are exactly those in `scripts/family/grants.sql`:
  - SELECT on the 6 family tables, `children`, `children_additional_information`, `admin` and `admin_api_tokens`;
  - SELECT (`id`, `name`) on `classes`;
  - INSERT, UPDATE and DELETE on the 6 family tables;
  - UPDATE (`family_id`) on `children`;
  - INSERT on `audit_logs`;
  - UPDATE (`last_seen_at`) on `admin_api_tokens`;
  - EXECUTE on `sp_family_preview`.
- The UPDATE, which touches no row, is refused: `ERROR 1143 (42000): UPDATE command denied to user 'family_api'@'localhost' for column 'father_phone' in table 'children'`.

**5.2 Deploy Tendi-new-API first.** Needs P4 and P6.

```bash
# TODO(P4): build and release command for Tendi-new-API at the release commit
```

The production environment needs these values:

- `NODE_ENV=production`;
- the `DB_*` values for the app account and `FAMILY_DB_USER=family_api` with its password;
- `FAMILY_ALLOWED_STAFF_TYPES` unset, or `admin,office`;
- `CORS_ORIGIN=$WEB_URL`;
- `REDIS_URL` only once a step requires Redis.

Checks:

```bash
curl -fsS "$API_URL/health/family"; echo                                                      # a
curl -fsS "$API_URL/health"; echo                                                             # b
node -e "fetch(process.argv[1]).then(r => r.json()).then(d => { const same = JSON.stringify(d) === JSON.stringify(require('./openapi/family.json')); console.log(same ? 'openapi: match' : 'openapi: DIFFERENT'); process.exit(same ? 0 : 1); })" "$API_URL/openapi.json"   # c
curl -s -o /dev/null -w '%{http_code}\n' "$API_URL/staff/me"                                  # d
for m in PUT PATCH DELETE; do curl -s -i -X OPTIONS "$API_URL/families/1" -H "Origin: $WEB_URL" -H "Access-Control-Request-Method: $m" | grep -i '^access-control-allow-'; done   # e
```

Expected:

- **a:** `{"status":"ok","db":"ok"}` (HTTP 200; a 503 with `"status":"error"` means the `family_api` pool cannot reach the database).
- **b:** `"status":"ok"`.
- **c:** `openapi: match`. The deployed document equals the release commit's `openapi/family.json`.
- **d:** `401`.
- **e:** each method shows `access-control-allow-origin: $WEB_URL`, and `access-control-allow-methods` lists PUT, PATCH and DELETE. This fails today (P6).

**If a check fails:** roll the release back (TODO(P4)). The database is untouched by the deploy.

**5.3 Before deploying Tendi-new: its generated types must match the deployed contract.** In a Tendi-new checkout at its release commit, with Tendi-new-API checked out next to it (`../Tendi-new-API`) at the commit deployed in 5.2:

```bash
git -C ../Tendi-new-API rev-parse HEAD        # must be the commit deployed in 5.2
npm ci
npm run gen:family-types
git diff --exit-code lib/api/generated/family.ts && echo "types match"
grep -n "FAMILY_STAFF_TYPES =" lib/auth/roles.ts
```

Expected: the deployed commit's hash, then `types match` (exit 0, no diff), then `export const FAMILY_STAFF_TYPES = ['admin', 'office'] as const;`. This list must equal `FAMILY_ALLOWED_STAFF_TYPES` in 5.2.

**5.4 Deploy Tendi-new.** Needs P4; the browser checks also need P5.

```bash
# TODO(P4): build with NEXT_PUBLIC_API_BASE_URL=$API_URL (inlined at build time), then release
```

Checks:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$WEB_URL/"
curl -s -o /dev/null -w '%{http_code}\n' "$WEB_URL/dev-sign-in"
```

Expected: `200`, then `404` (the dev sign-in is not in production builds).

In a browser, once P5 exists:

- An `admin` and an `office` staff member see **Families** in the navigation, and `/families` shows the family list.
- A staff member of any other type (for example `teacher`) has no Families link, and `/families` shows "Not authorised".
- The API agrees: `GET $API_URL/staff/me` answers 200 for admin and office tokens, and 403 for the others.

**Sign-off (step 5):** Engineering lead.

## 6. Smoke tests with every child unlinked: Gate C

First confirm that every child is still unlinked:

```bash
$MYSQL -e "SELECT COUNT(*) FROM children WHERE family_id IS NOT NULL" "$PROD_DB"
```

Expected: `0`.

Do each test on the test child from 1.4 (`SMOKE_CHILD_ID`), through the legacy PHP app. These are app actions, not commands.

| # | Test | Expected |
| --- | --- | --- |
| 6.1 | **Legacy child form save.** Change a parent field (for example the father's phone) and a non-parent field, save, then put both back and save again. | Both changes are saved as typed, exactly as before the rollout. `$MYSQL -e "SELECT COUNT(*) FROM family_mirror_lock_log" "$PROD_DB"` prints `0`: the lock does nothing for an unlinked child. The change appears in the child's audit history as before. |
| 6.2 | **SMS send.** Send the usual parent SMS for the test child. | Delivered to the same number as in the 1.4 baseline. |
| 6.3 | **Kiosk phone-PIN check-in.** Check the test child in with the parent's phone and PIN. | Accepted, as in the baseline. |
| 6.4 | **Statement email.** Send the test child's statement. | Sent to the same address as in the baseline. |
| 6.5 | **Registration PDF.** Generate the test child's registration PDF. | The parent fields are identical to the 1.4 baseline PDF. |

**Gate C:** all five tests pass, and the two counts above print `0`.

**If a test fails:** this is a rollback trigger (PLAN.md). Find the cause before anything is linked. With every child unlinked, removing the mirror (`npm run db:family:migrate:down`, last batch) returns the database to its behaviour before step 4.

**Sign-off (Gate C):** Engineering lead and Office and operations lead. The Billing lead signs off 6.4 (statement email).

## 7. Pilot: 5 to 10 families in one branch

Needs Gate C, P5 (office staff sign in) and P6 (rights are saved with PUT).

**7.1 Schedule the nightly reconciliation before the first link** (`docs/family/reconcile-runbook.md`, Linux line):

```bash
30 2 * * * cd /path/to/Tendi-new-API && npm run --silent family:reconcile >> /var/log/tendi/family-reconcile.log 2>&1
```

**7.2 Choose the pilot.** Office staff choose 5 to 10 of the backfill's draft families in one branch. They are reviewed in step 3.5. Record the family ids and child ids (ids only) in the pilot sign-off sheet.

**7.3 Link each child.** An office staff member opens Families, then the family, then **Link child**. They check the rights, read the preview, and link. The dialog's own check must end with "… is linked to …" and "Every value in the old system now matches this family's details". Then, for each linked child (`OFFICE_TOKEN` is that staff member's token):

```bash
curl -fsS -H "Authorization: Bearer $OFFICE_TOKEN" "$API_URL/families/$FAMILY_ID/children/$CHILD_ID/preview" \
  | node -e "let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => { const p = JSON.parse(s); console.log(p.linked_family_id, p.columns.length, p.columns.filter(c => c.changed).length); })"
```

Expected: `<FAMILY_ID> 28 0`. The child is linked to the family, the preview has all 28 mirrored columns (`home_send_notification` is not mirrored), and none would change.

Then:

```bash
$MYSQL -e "SELECT COUNT(*) FROM children WHERE family_id IS NOT NULL" "$PROD_DB"
npm run family:reconcile -- --once --database "$PROD_DB"; echo "exit $?"
```

Expected: the number of pilot children on the sign-off sheet. The reconciliation exits `0`, with `drifted_children` 0 in its `family_reconcile_runs` row.

**7.4 Legacy flows on a linked child.** Repeat 6.2 to 6.5 on one linked pilot child. The output must be identical to before linking.

Then repeat 6.1. Expected: the parent field is put back to the family's value, `family_mirror_lock_log` gains exactly one row for that child and column, and the non-parent field is saved.

**If something fails:** unlink the child (the Unlink button on the family page). Its legacy values stay as they are, and the child form owns them again. Any unexplained drift or changed legacy behaviour is a rollback trigger (below).

**Sign-off (pilot start):** Product owner and Office and operations lead.

Gate D (0 drift for 2 consecutive weeks, legacy flows unchanged) follows from the nightly runs (`docs/family/reconcile-runbook.md`). Who signs it off is not settled yet.

## Rollback (PLAN.md "Rollback plan")

| Scope | Command | Check |
| --- | --- | --- |
| One child | Unlink it on the family page, or `POST $API_URL/children/<id>/unlink` | `SELECT family_id FROM children WHERE id = <id>` gives `NULL`; its 28 values are unchanged |
| All children | `$MYSQL -e "UPDATE children SET family_id = NULL WHERE family_id IS NOT NULL" "$PROD_DB"` | `SELECT COUNT(*) FROM children WHERE family_id IS NOT NULL` gives `0` |
| The mirror | `npm run db:family:migrate:down` (the step 4 batch; TODO(P1)) | 1.2's `trg_*` count and routine count are `0` again |
| The schema | `npm run db:family:migrate:down -- --all` (TODO(P1)) | 1.2's baseline query matches `var/rollout/baseline.tsv`; schema identical to before step 2 |

Rollback triggers: any unexplained reconciliation drift, a legacy flow (SMS, kiosk, statements, PDF) behaving differently for a linked child, or measurably slower saves.

## Sign-off record

| Gate / step | Signs off | Name | Date | Result |
| --- | --- | --- | --- | --- |
| 1. Pre-checks | Engineering lead | | | |
| 2. Migrations 001 to 009 | Engineering lead | | | |
| 3. Gate B (proof run) | Engineering lead, Office and operations lead | | | |
| 4. Procedures and triggers | Engineering lead | | | |
| 5. Grants and deploys | Engineering lead | | | |
| 6. Gate C (smoke tests) | Engineering lead, Office and operations lead; Billing lead for 6.4 | | | |
| 7. Pilot start | Product owner, Office and operations lead | | | |
