Inline-module fixtures for `dt check modules/<id> --alone` (cr-dt-007, task 5). Each is copied into a
workspace's `modules/` by test/integration/check-alone.test.js. `alone-ok` depends on `alone-base`
(an inline dependency the gate must pack too); `alone-needs-input` ships a unit with a required input
(install exits 3, still publishable); `alone-missing-dep` names a dependency nothing here holds;
`alone-floor-above` floors on an engine that does not exist.
