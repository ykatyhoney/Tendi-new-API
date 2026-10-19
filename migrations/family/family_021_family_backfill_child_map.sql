-- Family module, backfill bookkeeping (scripts/family/backfill.ts). Not read by the mirror or the PHP app.
-- child -> draft family of a run, for the step 2.2 proof run (CALL sp_family_preview(child_id, family_id)).
CREATE TABLE family_backfill_child_map (
  run_id    INT(11) NOT NULL,
  child_id  INT(11) NOT NULL,
  family_id INT(11) NOT NULL,
  PRIMARY KEY (run_id, child_id),
  KEY idx_fbcm_child (child_id),
  KEY idx_fbcm_family (family_id),
  CONSTRAINT fk_fbcm_run FOREIGN KEY (run_id) REFERENCES family_backfill_runs (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_fbcm_family FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
