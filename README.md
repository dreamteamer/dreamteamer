# dreamteamer

**dreamteamer is a modular AI workspace builder.**

It gives your coding agents a structured, modular memory. Instead of hiding context in unmanaged prose, dreamteamer stores memory as **plain markdown files with a schema** directly in your git repo. Agents read it natively, and you can browse it as tables, boards, and forms.

No server, no account, no telemetry. Just a lightweight npm package.

---

## Features

- **Structured Memory as Files**: A record is just a markdown file with YAML frontmatter. Your agent opens it like any other file.
- **Strict Validation**: Schemas ensure your agents use agreed-upon terminology. Invalid links, wrong types, or unknown fields are rejected before they touch the disk.
- **Agent Agnostic**: Author a skill or schema once, use it everywhere. Core compiles to Claude Code, Cursor, Gemini CLI, and more.
- **NPM Modularity**: Distribute domain knowledge, skills, and agents using the npm ecosystem you already know. 
- **Visual Editor**: The [VS Code extension](https://github.com/dreamteamer/dreamteamer-vscode) gives you a powerful UI (tables, boards, forms) over your plain text files.

## Getting Started

dreamteamer is a **context package manager**: modules are npm packages that carry collections, skills,
commands and agents, and the engine compiles whatever you install into a workspace your agent harness
reads. Node.js 20+ and npm 7+ are the only prerequisites.

```bash
mkdir my-workspace && cd my-workspace
npx dreamteamer init                      # pin the engine, scaffold, compile, check, git init, commit
npx dreamteamer install @dreamteamer/tasks @dreamteamer/contacts
npx dreamteamer status                    # what is installed, what is set up, what to do next
```

Every line exits 0 and can be run again: a repeat changes nothing. `init` turns the folder into a git
repository and commits what it wrote (`--no-git` to skip, `--git <remote-url>` to add an origin without
pushing); inside an existing repository it only adds a commit scoped to its own files and leaves your
staged work alone. `install` takes any npm spec — a name, `name@version`, a `./file.tgz`, a `./folder`
(a development link), a `github:owner/repo#ref:path` — installs the module **and every module it
declares it needs**, pins exact versions, compiles, runs the module's safe setup, and commits. Without a
version you get the latest release that fits your engine.

**If you're an agent given a link to this repo:** read this README, agree with the user on which folder
becomes the workspace, and run the steps above there. Then have the user open a fresh session in that
folder, where the compiled `using-dreamteamer` skill continues in conversation with the same commands.

## Modules and setup

A module that needs something from you — a folder, an account, a download — ships its own setup, and
the engine drives it through one contract: it never knows the module by name. `install` asks for missing
inputs in the terminal, or takes them as flags in a script; anything that downloads, reaches the network
or changes the machine waits for your `--allow`; signing in to an account is always your own step.

```bash
npx dreamteamer install @dreamteamer/meetings \
    --input 'calendar=me@example.com|mixed|me@example.com'          # merged into .env, never committed
npx dreamteamer install @dreamteamer/recordings \
    --input files_folder=~/hq-files --allow download --allow machine   # transcription models and venv
npx dreamteamer install @dreamteamer/google-workspace --allow machine
#   → google-workspace: configured. To connect the account (opens a browser):
npx dreamteamer setup google-workspace --authorize
npx dreamteamer status
#   setup
#     tasks             ready
#     meetings          configured   1 calendar · account access unverified → dt setup meetings --verify --authorize
#     recordings        configured   models on disk, never ran → dt setup recordings --verify --allow machine
#     google-workspace  ready · verified 2026-11-13
```

`status` is read-only and honest: `ready` means a check actually passed on this machine (and `verified`
names the date a live check did), `configured` means the inputs are in place and says what is still
unverified, `skipped` means you declined it (`dt setup <module> --skip`) and how to come back,
`blocked` names the one thing in the way. `dt doctor` is the same evidence as rows, `--json` and
`--strict` for scripts. `dt setup <module>` resumes, repairs, verifies (`--verify`) or signs in
(`--authorize`); `dt update [<module>[@version] | --engine]` moves a pin forward, never on its own.

A personal HQ is a preset, not a platform: `npx dreamteamer install @dreamteamer/core` brings the
composed set in one line — and installing one of the modules core already provides is refused with the
reason.

| module | what it keeps | setup |
|---|---|---|
| `@dreamteamer/core` | every core noun from one install — users, companies, contacts, engagements, tasks, projects, meetings, recordings, files, assets, workflows | the setup of each module it composes |
| `@dreamteamer/tasks` · `users` · `projects` · `companies` · `contacts` · `engagements` · `assets` · `workflows` · `routines` · `knowledge` | records and the skills that work them | none |
| `@dreamteamer/meetings` | calendar meetings as records | which calendars count as work |
| `@dreamteamer/recordings` | audio and offline transcripts | models, venv, a files folder |
| `@dreamteamer/google-workspace` | one Google account through a local bridge | credentials store, sign-in |
| `@dreamteamer/files` · `search` · `wikis` · `notebooklm` · `perspective` · `git-identities` | mounted folders, local search, wikis, NotebookLM, a person's past work, git identities | a folder, a tool on PATH, a token or a login |
| `@dreamteamer/http` · `web` · `code` · `docker-workspaces` · `worktrees` · `proofs` · `rnd` | a REST api, the UI in a browser, an editor, containers, worktrees, behaviour proofs, the R&D lifecycle | a port, or none |

## How It Works

### 1. Define Records
A record is a file inside your collection directory (e.g., `data/meetings/2026/07/kickoff.meeting.md`):

```yaml
---
title: Kickoff
date: 2026-07-14
attendees: [contacts/ada, contacts/lin]
project: projects/apollo
---
Ada walked through the constraints. Lin owns the spec by Friday.
```

### 2. Enforce Schemas
Your agents read the file directly, but `dreamteamer check` ensures that every reference (like `contacts/ada`) actually resolves. **A schema is an agreement about what things are called.**

### 3. Share & Compose
Because dreamteamer uses npm, you can install domain modules containing collections, skills, and agents. If a module doesn't perfectly fit your needs, you don't fork it—you adapt it locally by overriding just the schema fields you need to change.

## Programmatic Usage

Use dreamteamer in your own scripts or apps:

```javascript
import { openWorkspace, Store } from 'dreamteamer';

const ws = await openWorkspace('.');        // no compile, no writes
const store = new Store(ws);

for (const { id, fields } of store.readAll('notes')) {
  console.log(id, fields.title);
}
```

## Extensions

An extension adds verbs, source kinds or harnesses through one contract
([`references/extensions.md`](skills/using-dreamteamer/references/extensions.md)). It can be a
workspace module (`modules/<id>/package.json` declaring `dreamteamer.extension`) or an installed
dependency.

Behaviour proofs (`@dreamteamer/proofs`), worktrees (`@dreamteamer/worktrees`), the REST API
(`@dreamteamer/http`) and the NotebookLM exporter (`@dreamteamer/notebooklm`) are extension packages;
the local Docker host is the global `dt-docker` bin (`@dreamteamer/docker-workspaces`). A verb typed
without its package prints the install line.

## Agent-Native Documentation

Because this is an agent-native tool, documentation is shipped as skills your agent loads on demand:
- [`skills/using-dreamteamer`](skills/using-dreamteamer) — Core skill for working with records and modeling the workspace.
- [`docs/`](docs/) — Deeper architectural context, upgrade guides, and rationale.

## Contributing

We welcome issues and discussions! For anything larger than a typo, please open a discussion before submitting a PR. This is a deliberately lean codebase and we prefer to agree on shape first. `npm run verify` enforces our size and test budgets. 

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[Apache-2.0](LICENSE) © 2026 Gilad Khen.
