# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[security advisory form](https://github.com/dreamteamer/dreamteamer/security/advisories/new),
which reaches the maintainer directly and keeps the details out of public view until there's a fix.

You should get an acknowledgement within a few days. This is a small project maintained by one
person, so please be patient — and if you don't hear back within a week, feel free to nudge by
opening a normal issue that says only "sent a security report", with no details in it.

## Threat model

`dreamteamer` is a local command-line tool and library. It reads and writes files in a workspace you
control, shells out to `git`, and — when you run `dreamteamer start` — binds an HTTP server to
localhost with **no authentication**, on the assumption that only you can reach it.

That last one is a deliberate design decision, not an oversight: the server is a local development
surface. Exposing it to a network is out of scope, and doing so is unsafe.

Worth reporting:

- Path traversal that escapes the workspace root.
- Arbitrary code execution from parsing a record, a descriptor, or a compiled runtime.
- A `compile` or `check` step that writes outside the workspace.
- Anything that makes `dreamteamer start` reachable off-host by default.
- A dependency advisory that is actually reachable from this code.

Not vulnerabilities: the unauthenticated local server (documented above), and anything requiring an
attacker who can already write arbitrary files into your workspace — at that point they own the
workspace regardless.

## Supported versions

The latest published `0.6.x` release. This project has not reached 1.0; older minors do not get
backported fixes.
