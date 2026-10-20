-- Family module, Phase 4 pilot: one summary row per nightly reconciliation run
-- (scripts/family/reconcile.ts). The job only reads the mirrored columns; it never fixes data.
-- run_date + trigger_source let a scheduled run skip a night that already has one.
CREATE TABLE family_reconcile_runs (
  id               INT(11) NOT NULL AUTO_INCREMENT,
  run_at           DATETIME NOT NULL,
  run_date         DATE NOT NULL,
  trigger_source   ENUM('scheduled','manual') NOT NULL DEFAULT 'scheduled',
  linked_children  INT(11) NOT NULL,
  drifted_children INT(11) NOT NULL,
  lock_log_rows    INT(11) NOT NULL,
  details          JSON NULL,
  PRIMARY KEY (id),
  KEY idx_reconcile_night (run_date, trigger_source),
  KEY idx_reconcile_run_at (run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
