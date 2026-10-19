-- Family module, backfill bookkeeping (scripts/family/backfill.ts). Not read by the mirror or the PHP app.
-- One row per backfill run (the batch id). status 'reset' = its rows were deleted by --reset.
CREATE TABLE family_backfill_runs (
  id          INT(11) NOT NULL AUTO_INCREMENT,
  status      ENUM('done','reset') NOT NULL DEFAULT 'done',
  options     VARCHAR(255) NOT NULL DEFAULT '',
  summary     MEDIUMTEXT NULL,
  started_at  DATETIME NOT NULL,
  finished_at DATETIME NULL,
  reset_at    DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_fbr_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
