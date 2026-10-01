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

Scaffold your AI workspace in seconds:

```bash
npm i dreamteamer
npx dreamteamer init      # scaffold a workspace
npx dreamteamer compile   # sources → .dreamteamer (+ harness adapters)
npx dreamteamer check     # prove every record and every link is intact
npx dreamteamer help      # the full command surface
```

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

Behaviour proofs, worktrees, the REST API, the NotebookLM exporter and the local Docker host left core
in 0.31.0 and return as extensions. None is published yet.

## Agent-Native Documentation

Because this is an agent-native tool, documentation is shipped as skills your agent loads on demand:
- [`skills/using-dreamteamer`](skills/using-dreamteamer) — Core skill for working with records and modeling the workspace.
- [`docs/`](docs/) — Deeper architectural context, upgrade guides, and rationale.

## Contributing

We welcome issues and discussions! For anything larger than a typo, please open a discussion before submitting a PR. This is a deliberately lean codebase and we prefer to agree on shape first. `npm run verify` enforces our size and test budgets. 

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[Apache-2.0](LICENSE) © 2026 Gilad Khen.
