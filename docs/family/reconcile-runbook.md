# Family reconciliation: runbook

Nightly check for the Phase 4 pilot (PLAN.md "Rollout", gate D: 0 drift for 2 weeks). It reports drift and never fixes data.

## What a run does

1. **Takes the lock.** `GET_LOCK('<database>:family:reconcile', 0)`. If another run holds it, this run prints "skipping" and exits 0.
2. **Skips a repeat.** In nightly mode, if a `scheduled` run already exists for today (`family_reconcile_runs.run_date = CURDATE()`), the run prints "skipping" and exits 0. Steps 1 and 2 together give one run per night, even with several scheduler hosts.
3. **Compares.** In a `READ ONLY` transaction, for every child with `children.family_id IS NOT NULL`, it compares `CALL sp_family_preview(child_id, NULL)` with the 28 mirrored columns as stored (`home_send_notification` is not mirrored). Any value that is not identical is drift, and so is a preview error.
4. **Counts lock-log activity.** It counts `family_mirror_lock_log` rows from the last 24 hours (legacy writes the lock reverted), per table and column.
5. **Records the run.** It writes one `family_reconcile_runs` row with `linked_children`, `drifted_children`, `lock_log_rows` and `details` (JSON):
   - for each drifted child: `child_id`, `family_id`, and each drifted column's stored and mirror values, up to 200 children;
   - the lock-log counts.
6. **Raises the alert.** If any child drifted, it prints a `WARNING` (`scripts/family/reconcile/alert.ts`, the single alert hook) and exits 2.

Exit codes: 0 means no drift (or skipped), 2 means drift, 1 means error.

## Schedule

| Host | How |
| --- | --- |
| Windows (dev machine) | `powershell -File scripts/family/schedule-reconcile.ps1 [-At 02:30]` registers the user task "Tendi family reconcile". It appends output to `var/family-reconcile/nightly.log`, and the last exit code shows as the task's "Last Run Result". Remove it with `Unregister-ScheduledTask -TaskName 'Tendi family reconcile' -Confirm:$false`. |
| Linux (production, Phase 4) | `30 2 * * * cd /path/to/Tendi-new-API && npm run --silent family:reconcile >> /var/log/tendi/family-reconcile.log 2>&1` |
| On demand | `npm run family:reconcile -- --once`, recorded as `manual`. It does not count as the night's scheduled run. Add `--database <name>` to target another local `tendi_family_*` database. |

## Reading results

```sql
SELECT id, run_at, trigger_source, linked_children, drifted_children, lock_log_rows
  FROM family_reconcile_runs ORDER BY id DESC LIMIT 14;          -- the last two weeks (gate D)
SELECT JSON_DETAILED(details) FROM family_reconcile_runs WHERE id = <run>;
```

## When a run reports drift

Drift means a mirrored column no longer equals what the family tables derive. For example, someone wrote the column with `@family_mirror` set, the mirror failed, or the data was edited outside the mirror. The job changes nothing, so:

1. **Find the cause** from `details`: which child, which columns, and the stored value next to the mirror value.
2. **Decide which side is right.** If the family data is right, a person re-runs the mirror for that child: `CALL sp_family_mirror(<child_id>)`, with `@audit_user` set to their admin id. If the stored value is right, fix the family data through the Family API, and the mirror follows.
3. **Count the night against the gate.** Any drift resets the "0 drift for 2 weeks" count of gate D. Per PLAN.md "Rollback plan", unexplained drift is a rollback trigger.

## Still to come

- **Alerting.** No alerting or email exists in this backend yet; the alert is a warning plus exit code 2. Wire the real channel in `scripts/family/reconcile/alert.ts`.
- **Redis lock (Step 2.3).** Replace `GET_LOCK` with `SET <prefix>:family:reconcile NX EX 3600`, using the Redis client and key prefix chosen then.
