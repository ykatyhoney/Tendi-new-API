-- Backfill household report for the latest 'done' run (or SET @run before sourcing).
-- Read-only. Output contains personal data: run locally, do not paste into tickets.
--   mysql tendi_family_dev < scripts/family/reports/backfill-households.sql
-- Phone normalization below is the SQL twin of scripts/family/lib/phone.ts normalizePhone.

SET @run = COALESCE(@run, (SELECT MAX(id) FROM family_backfill_runs WHERE status = 'done'));
SELECT id AS run, options, started_at FROM family_backfill_runs WHERE id = @run;

CREATE TEMPORARY TABLE rpt_multi AS
  SELECT family_id, COUNT(*) AS kids FROM family_backfill_child_map WHERE run_id = @run GROUP BY family_id HAVING kids > 1;

-- 1. Do the children of each multi-child household share an address?
--    all_same: every child has the same (non-empty) address; same_where_filled: the filled ones agree,
--    some are empty; differ: at least two different addresses; none_filled: no address at all.
SELECT source, COUNT(*) AS households,
       SUM(addresses = 1 AND blanks = 0) AS all_same,
       SUM(addresses = 1 AND blanks > 0) AS same_where_filled,
       SUM(addresses > 1)                AS differ,
       SUM(addresses = 0)                AS none_filled
FROM (
  SELECT 'children.address' AS source, h.family_id,
         COUNT(DISTINCT NULLIF(LOWER(TRIM(REGEXP_REPLACE(c.address, '\\s+', ' '))), '')) AS addresses,
         SUM(TRIM(c.address) = '') AS blanks
    FROM rpt_multi h
    JOIN family_backfill_child_map m ON m.run_id = @run AND m.family_id = h.family_id
    JOIN children c ON c.id = m.child_id
   GROUP BY h.family_id
  UNION ALL
  SELECT 'children_additional_information.father_address', h.family_id,
         COUNT(DISTINCT NULLIF(LOWER(TRIM(REGEXP_REPLACE(cai.father_address, '\\s+', ' '))), '')),
         SUM(COALESCE(TRIM(cai.father_address), '') = '')
    FROM rpt_multi h
    JOIN family_backfill_child_map m ON m.run_id = @run AND m.family_id = h.family_id
    LEFT JOIN children_additional_information cai ON cai.child_id = m.child_id
   GROUP BY h.family_id
) t
GROUP BY source;

-- 2. Multi-child households that match a payment_households household by normalized phone
--    (any member phone, or the household phone).
SELECT (SELECT COUNT(*) FROM payment_households) AS payment_households_in_db,
       (SELECT COUNT(*) FROM payment_household_phones) AS payment_household_phones_in_db,
       COUNT(DISTINCT h.family_id) AS multi_child_households_matching,
       COUNT(DISTINCT php.household_id) AS payment_households_matched
  FROM rpt_multi h
  JOIN (
    SELECT fm.family_id, pp.phone_normalized AS n
      FROM family_members fm JOIN people_phones pp ON pp.person_id = fm.person_id
     WHERE pp.phone_normalized <> ''
    UNION
    SELECT f.id, RIGHT(REGEXP_REPLACE(REGEXP_REPLACE(f.household_phone, '(?i)(ext\\.?|x|#).*$', ''), '[^0-9]', ''), 10)
      FROM families f
     WHERE CHAR_LENGTH(REGEXP_REPLACE(REGEXP_REPLACE(f.household_phone, '(?i)(ext\\.?|x|#).*$', ''), '[^0-9]', '')) >= 10
  ) p ON p.family_id = h.family_id
  JOIN payment_household_phones php ON php.phone_normalized = p.n;

-- 3. Every household with 5 or more children.
SELECT f.id AS family_id, f.name, f.household_phone, h.kids,
       (SELECT GROUP_CONCAT(CONCAT(c.id, ' ', c.fname, ' ', c.lname, ' [', c.status, '] ', c.address)
                            ORDER BY c.id SEPARATOR ' | ')
          FROM family_backfill_child_map m JOIN children c ON c.id = m.child_id
         WHERE m.run_id = @run AND m.family_id = f.id) AS children,
       (SELECT GROUP_CONCAT(CONCAT(fm.relationship, IF(fm.is_primary, '*', ''), ': ',
                                   IF(p.legacy_full_name <> '', p.legacy_full_name, CONCAT_WS(' ', p.fname, p.lname)),
                                   ' <', p.email, '> ',
                                   COALESCE((SELECT GROUP_CONCAT(CONCAT(pp.label, ' ', pp.phone) ORDER BY pp.sort_order SEPARATOR ', ')
                                               FROM people_phones pp WHERE pp.person_id = p.id), '(no phone)'),
                                   COALESCE(CONCAT('; ', (SELECT GROUP_CONCAT(CONCAT(pa.kind, ' ', pa.line1) SEPARATOR ', ')
                                                           FROM people_addresses pa WHERE pa.person_id = p.id)), ''))
                            ORDER BY fm.sort_order SEPARATOR ' | ')
          FROM family_members fm JOIN people p ON p.id = fm.person_id
         WHERE fm.family_id = f.id) AS members,
       (SELECT GROUP_CONCAT(CONCAT(fmc.child_id, ':', fm.relationship,
                                   IF(fmc.receives_notifications, ' notify ', ' '), fmc.notify_method,
                                   IF(fmc.is_payment_responsible, ' pays', ''))
                            ORDER BY fmc.child_id, fm.sort_order SEPARATOR ', ')
          FROM family_member_children fmc JOIN family_members fm ON fm.id = fmc.member_id
         WHERE fm.family_id = f.id) AS rights
  FROM rpt_multi h JOIN families f ON f.id = h.family_id
 WHERE h.kids >= 5
 ORDER BY h.kids DESC, f.id;

-- 4. Distinct normalized parent phones per area code, across every legacy parent phone column of
--    non-trash children. The anonymized range 555-0100..555-0199 holds only 100 numbers per area code.
CREATE TEMPORARY TABLE rpt_phones AS
  SELECT RIGHT(REGEXP_REPLACE(REGEXP_REPLACE(v.phone, '(?i)(ext\\.?|x|#).*$', ''), '[^0-9]', ''), 10) AS n, v.child_id, v.lname
    FROM (
      SELECT c.id AS child_id, c.lname, c.father_phone AS phone FROM children c WHERE c.status <> 'trash'
      UNION ALL SELECT c.id, c.lname, c.mother_phone FROM children c WHERE c.status <> 'trash'
      UNION ALL SELECT c.id, c.lname, c.home_phone FROM children c WHERE c.status <> 'trash'
      UNION ALL SELECT c.id, c.lname, cai.father_home_phone FROM children c JOIN children_additional_information cai ON cai.child_id = c.id WHERE c.status <> 'trash'
      UNION ALL SELECT c.id, c.lname, cai.mother_home_phone FROM children c JOIN children_additional_information cai ON cai.child_id = c.id WHERE c.status <> 'trash'
      UNION ALL SELECT c.id, c.lname, cai.father_office_phone FROM children c JOIN children_additional_information cai ON cai.child_id = c.id WHERE c.status <> 'trash'
      UNION ALL SELECT c.id, c.lname, cai.mother_office_phone FROM children c JOIN children_additional_information cai ON cai.child_id = c.id WHERE c.status <> 'trash'
    ) v
   WHERE CHAR_LENGTH(REGEXP_REPLACE(REGEXP_REPLACE(v.phone, '(?i)(ext\\.?|x|#).*$', ''), '[^0-9]', '')) >= 10;

SELECT LEFT(n, 3) AS area_code,
       COUNT(*) AS phone_values,
       COUNT(DISTINCT n) AS distinct_numbers,
       COUNT(DISTINCT IF(n REGEXP '^[0-9]{3}55501[0-9]{2}$', n, NULL)) AS distinct_in_555_01xx,
       ROUND(COUNT(DISTINCT IF(n REGEXP '^[0-9]{3}55501[0-9]{2}$', n, NULL)) / 100 * 100) AS pct_of_555_01xx_used,
       COUNT(DISTINCT child_id) AS children,
       ROUND(COUNT(DISTINCT child_id) / COUNT(DISTINCT n), 1) AS children_per_number
  FROM rpt_phones
 GROUP BY area_code
 ORDER BY phone_values DESC;

-- Numbers shared by children with different surnames (a collision signal).
SELECT COUNT(*) AS numbers_shared_across_surnames
  FROM (SELECT n FROM rpt_phones GROUP BY n HAVING COUNT(DISTINCT LOWER(TRIM(lname))) > 1) x;
