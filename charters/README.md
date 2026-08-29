# Charter registry

Copyright © 2026 Steven Kreutzer. All Rights Reserved.

`registry.json` holds **references** to the 58 approved Engine Charters — never
their text. Charter text lives in the approved library; a copy in source would
be a second authoritative document that silently diverges.

Each record carries `integrityHash` (SHA-256 of the source `.docx`), so a
reference is checkable rather than merely a pointer. `charterRecordSchema`
refuses an `ACTIVE` charter without one.

**Generated from:** `The Hive/Constituton and charter/` (approved library,
V1.0). Regenerate when the library changes; the hashes are what detect that it
has.

`ratificationState: APPROVED_SOURCE` — these reference documents approved
outside this repository. Nothing here was authored by the repository.
