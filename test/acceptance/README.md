# acceptance — the design's matrix, run as the CLI a person types

`node test/acceptance/run.mjs [--from <dir>] [--driver <dreamteamer.js>] [--only=A1,A3] [--out <dir>]`

Runs the scenarios of `rnd/design-docs/2026-11-12--cli-first-module-lifecycle` (A1–A9, A13) in fresh
temp folders, offline: every module comes from the folder of tarballs `--from` names (default
`$DT_CANDIDATES`), the engine the workspaces pin is the `dreamteamer-<version>.tgz` in that folder, and
the driver (the binary that types the commands) is this checkout's `bin/dreamteamer.js` unless
`--driver` points at an extracted candidate. `HOME` is a temp dir; `test/acceptance/bin/` (a stand-in
`uv` and `ffmpeg`) is prepended to PATH, so nothing downloads and nothing of the operator's is read.

Evidence lands in `--out` (default `test/acceptance/out/<date>/`): `transcript.jsonl` (every command,
its exit code, stdout and stderr), `SHA256SUMS` of every tarball used, `manifest.yaml` and
`package-lock.json` of the A1 workspace, and `summary.json`. Exit 1 if any scenario fails.

When the folder lacks the real modules (`@dreamteamer/tasks`, …), A1 runs with the synthetic provider
(`@probe/setup`) and the fixture modules (`@fix/*`) in their place — the engine's contract is what is
being proved, and the real modules' own suites prove the modules.

**A14, A15** are two engine issues' own reproductions on the published modules. Each runs only when
`--from` holds its tarballs and is skipped, by name, otherwise:

```bash
mkdir /tmp/e2e-from && cd /tmp/e2e-from
npm pack @dreamteamer/google-workspace@0.3.0 @dreamteamer/meetings@0.2.0 @dreamteamer/meetings@0.3.0 \
  @dreamteamer/contacts @dreamteamer/companies @dreamteamer/users @dreamteamer/assets --silent
node <engine>/test/acceptance/run.mjs --from /tmp/e2e-from --only A14,A15
```

A14: `dt doctor` on a 0644 OAuth client file shows a ⚠ row with the `chmod 600` fix, not ✔. A15:
`dt update` of meetings 0.2.0 → 0.3.0 runs the 0.3.0 unit (exit 0, no "needs input: calendar").
