-- Family module, backfill bookkeeping (scripts/family/backfill.ts). Not read by the mirror or the PHP app.
-- Every family-table row a run created, so --reset deletes exactly those rows and nothing else.
CREATE TABLE family_backfill_rows (
  run_id     INT(11) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  row_id     INT(11) NOT NULL,
  PRIMARY KEY (run_id, table_name, row_id),
  CONSTRAINT fk_fbrows_run FOREIGN KEY (run_id) REFERENCES family_backfill_runs (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
