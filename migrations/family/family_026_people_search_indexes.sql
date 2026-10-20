-- Family module, step 3.4: indexed family search by person name (prefix match on fname,
-- legacy_full_name; lname is served by idx_people_lname).
ALTER TABLE people
  ADD KEY idx_people_fname (fname),
  ADD KEY idx_people_legacy_name (legacy_full_name);
