-- Family module, step 3.4: indexed family search (GET /families?q=).
-- household_phone_normalized: families.household_phone normalized like people_phones.phone_normalized
-- (src/lib/phone.ts: extension dropped, digits only, last 10, '' below 10 digits), computed by the
-- database so it can be indexed and never drifts. idx_families_name serves the name prefix search.
ALTER TABLE families
  ADD COLUMN household_phone_normalized VARCHAR(20) AS (
    CASE
      WHEN CHAR_LENGTH(REGEXP_REPLACE(REGEXP_REPLACE(household_phone, '(?i)(ext\.?|x|#).*$', ''), '[^0-9]', '')) >= 10
        THEN RIGHT(REGEXP_REPLACE(REGEXP_REPLACE(household_phone, '(?i)(ext\.?|x|#).*$', ''), '[^0-9]', ''), 10)
      ELSE ''
    END
  ) STORED AFTER household_phone,
  ADD KEY idx_families_household_norm (household_phone_normalized),
  ADD KEY idx_families_name (name);
