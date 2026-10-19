# Family sync proof run

Generated 2026-10-19 13:45 (local time) by `scripts/family/proof-run.ts` against `tendi_family_dev` (2026-09-24 dump), backfill run 3 (`--group-by-home-phone`). Read-only: every query ran in a READ ONLY transaction and the checksums of the legacy and family tables were identical before and after.

This file holds counts and child ids only. Names and values are in the git-ignored `var/family-proof/family-sync-proof-run-3.csv` (personal data).

## Result: FAIL

Target: the mirror fills the legacy columns exactly as they are filled today. The only accepted differences are: missing children_additional_information row (D4 creates it when linked); parent_email matches neither parent's email, so nobody is payment-responsible; parent shared with siblings: the person's details come from the sibling with the lowest id; household merged by a shared phone: a sibling's parent fills this child's slot.

| | Children | Differences |
| --- | ---: | ---: |
| Checked | 752 | |
| With 0 differences | 684 | |
| With accepted differences only | 67 | 141 |
| **Failing** (any other difference) | **1** | **1** |
| sp_family_preview errors | 0 | |

## How values are compared

`CALL sp_family_preview(child_id, draft_family_id)` gives the 28 values the mirror would write (`home_send_notification` is not mirrored). They are compared with today's `children` and `children_additional_information` values:

- **exact**: identical, NULL equals only NULL. Anything else is a difference, classified by the strictest of:
- **null_vs_empty**: one side NULL, the other `''`.
- **trim_casefold**: strings equal after trimming, collapsing inner whitespace and lower-casing.
- **phone_normalized**: phones different as typed, same normalized number (extension dropped, digits only, last 10).
- **different**: none of the above. Bit and enum columns are compared by value only.

## Differences per likely cause

| Likely cause | Accepted | Differences | Children | Columns | Child ids |
| --- | --- | ---: | ---: | --- | --- |
| Missing children_additional_information row (D4 creates it when linked) | yes | 72 | 4 | father_fname, father_lname, father_home_phone, father_email, father_address, father_occupation, father_employer, father_work_address, father_office_phone, mother_fname, mother_lname, mother_home_phone, mother_email, mother_address, mother_occupation, mother_employer, mother_work_address, mother_office_phone | 522, 674, 681, 686 |
| Household merged by a shared phone: a sibling's parent fills this child's slot | yes | 7 | 5 | father_phone, mother_phone, father_email | 118, 119, 128, 238, 765 |
| Parent shared with siblings: the person's details come from the sibling with the lowest id | yes | 2 | 1 | mother_home_phone, mother_email | 238 |
| parent_email matches neither parent's email, so nobody is payment-responsible | yes | 60 | 60 | parent_email | 238, 273, 274, 350, 351, 384, 436, 450, 494, 495, 496, 497, 498, 499, 502, 503, 510, 523, 524, 525, 526, 527, 531, 532, 533, 541, 542, 545, 546, 549, 558, 559, 560, 563, 570, 573, 589, 613, 614, 615, 616, 661, 667, 670, 671, 675, 676, 677, 678, 680, 684, 685, 687, 710, 712, 725, 11148, 11150, 11153, 11156 |
| Legacy notification setting is NULL; a rights row always has a value | **no** | 1 | 1 | notification_mother_phone_method | 11153 |

## Differences per column

| Column | Table | Differences | NULL vs empty | Whitespace/case only | Phone format only | Different |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `father_name` | children | 0 | 0 | 0 | 0 | 0 |
| `mother_name` | children | 0 | 0 | 0 | 0 | 0 |
| `father_phone` | children | 4 | 0 | 0 | 0 | 4 |
| `mother_phone` | children | 2 | 0 | 0 | 0 | 2 |
| `home_phone` | children | 0 | 0 | 0 | 0 | 0 |
| `parent_email` | children | 60 | 0 | 0 | 0 | 60 |
| `use_father_phone_for_notification` | children | 0 | 0 | 0 | 0 | 0 |
| `use_mother_phone_for_notification` | children | 0 | 0 | 0 | 0 | 0 |
| `notification_father_phone_method` | children | 0 | 0 | 0 | 0 | 0 |
| `notification_mother_phone_method` | children | 1 | 0 | 0 | 0 | 1 |
| `father_fname` | CAI | 4 | 4 | 0 | 0 | 0 |
| `father_lname` | CAI | 4 | 4 | 0 | 0 | 0 |
| `father_home_phone` | CAI | 4 | 4 | 0 | 0 | 0 |
| `father_email` | CAI | 5 | 4 | 0 | 0 | 1 |
| `father_address` | CAI | 4 | 4 | 0 | 0 | 0 |
| `father_occupation` | CAI | 4 | 4 | 0 | 0 | 0 |
| `father_employer` | CAI | 4 | 4 | 0 | 0 | 0 |
| `father_work_address` | CAI | 4 | 4 | 0 | 0 | 0 |
| `father_office_phone` | CAI | 4 | 4 | 0 | 0 | 0 |
| `mother_fname` | CAI | 4 | 4 | 0 | 0 | 0 |
| `mother_lname` | CAI | 4 | 4 | 0 | 0 | 0 |
| `mother_home_phone` | CAI | 5 | 4 | 0 | 0 | 1 |
| `mother_email` | CAI | 5 | 4 | 0 | 0 | 1 |
| `mother_address` | CAI | 4 | 4 | 0 | 0 | 0 |
| `mother_occupation` | CAI | 4 | 4 | 0 | 0 | 0 |
| `mother_employer` | CAI | 4 | 4 | 0 | 0 | 0 |
| `mother_work_address` | CAI | 4 | 4 | 0 | 0 | 0 |
| `mother_office_phone` | CAI | 4 | 4 | 0 | 0 | 0 |

## home_send_notification

Not mirrored: the mirror owns 28 columns and this one stays as stored until production data shows its rule (SCHEMA.md). Stored values across the 752 children checked: 0 = 752. Candidate rules, evaluated on the draft family values, for the production run to decide:

| Candidate rule | Matching children | Of |
| --- | ---: | ---: |
| Always 0 | 752 | 752 |
| Always 1 | 0 | 752 |
| 1 when household_phone is set | 751 | 752 |
| 1 when a parent receives notifications for the child | 752 | 752 |
| 1 when household_phone is set and no parent receives notifications (home line as fallback) | 751 | 752 |
| 1 when household_phone is set and a parent receives notifications | 752 | 752 |

Every stored value is 0, so this dump cannot tell the candidate rules apart.

