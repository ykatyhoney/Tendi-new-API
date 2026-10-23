-- Family module, Gate D (PLAN.md "Rollout": the pilot's save times): one row per Family API write
-- request (POST, PUT, PATCH, DELETE), written by the API itself (src/modules/family/request-timings.ts)
-- and read by GET /families/admin/pilot-stats for the p95 save time. The route is the pattern
-- (e.g. /families/:id/members), not the URL. No personal data.
CREATE TABLE family_api_request_timings (
  id          BIGINT NOT NULL AUTO_INCREMENT,
  method      VARCHAR(10) NOT NULL,
  route       VARCHAR(255) NOT NULL,
  status_code SMALLINT NOT NULL,
  duration_ms DECIMAL(10,3) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_timings_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
