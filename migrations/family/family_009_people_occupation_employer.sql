-- Family module, decision D4: occupation and employer on people, mirrored to children_additional_information.*_occupation / *_employer.
ALTER TABLE people
  ADD COLUMN occupation VARCHAR(150) NOT NULL DEFAULT '' AFTER hebrew_name,
  ADD COLUMN employer   VARCHAR(150) NOT NULL DEFAULT '' AFTER occupation;
