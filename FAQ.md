# dreamteamer — FAQ

## The basics

### What is a context package manager and why do I need one?

A [context package manager](https://www.youtube.com/watch?v=TqJ7Q_c_W1Y) is a tool that helps you construct and maintain agentic workspaces in a **modular, structured, and consistent** manner by treating context as source code, and applying software engineering best practices to context development and maintenance.

You need it because structured context dramatically improves the reasoning, consistency, and reliability of agents in scenarios with repeated tasks.

### How does dreamteamer work?

It keeps a typed data model for your workspace and injects that model, with instructions for using it, into every conversation. The agent then writes well-formed records through the CLI instead of guessing what a "task" or a "contact" looks like and where it goes. An invalid write is rejected before it reaches the disk. See [Under the hood](README.md#under-the-hood).

### Do I need to be a coder to use dreamteamer?

No. dreamteamer applies software engineering best practices under the hood, while you keep talking to your agent in natural language. The [Getting started](README.md#getting-started) prompt for non-coders sets everything up from one message.

### Does dreamteamer replace coding agents?

No, dreamteamer is not a coding agent. It works inside the agents you already use and gives them a more streamlined and predictable workspace to work in.

### What coding agents are supported?

Claude Code, Codex, Cursor, Gemini CLI and Pi. `npx dreamteamer compile` writes each one's own files (skills, agents, commands, instructions) from one source, so every harness sees the same workspace.

### How is this different from just writing a CLAUDE.md or AGENTS.md?

Those files are free text that one harness reads. dreamteamer generates them for you (`CLAUDE.md`, `AGENTS.md` and `GEMINI.md`), and adds what free text cannot:

- **A schema.** Every kind of record has typed fields and relations, and every write is validated against them.
- **One source, every harness.** Skills, commands and agents are written once and compiled for each supported agent.
- **Packages.** A capability is a module you install, update and share, not a paragraph you copy between projects.

You still have a place for your own rules: write them in `DREAMTEAMER.md`, and `compile` copies them into the generated files.

### What is a module?

One npm package that ships a domain: its collections (the kinds of records), and the skills, commands, agents and views that work on them. `@dreamteamer/tasks` is a small one. You install a module, and from then on it is part of what every agent sees. The [modules repository](https://github.com/dreamteamer/dreamteamer-modules) lists the official ones.

### What are common use cases for dreamteamer?

A second brain (tasks, contacts, meetings, files) and an AI software factory (design, plan, build, test and release as records). The [modules repository](https://github.com/dreamteamer/dreamteamer-modules) lists what ships today.

## Using it

### How do I get started?

See [Getting started](README.md#getting-started): one prompt for non-coders, or `npx dreamteamer init` in an empty folder.

### Can I use it on a folder or repository I already have?

Yes. `npx dreamteamer init` inside an existing repository adds one commit of what it wrote and leaves your staged work alone. A repository can hold code and be a workspace at the same time, and existing files that already look like records can be registered where they are instead of being rewritten. [getting-started.md](skills/using-dreamteamer/references/getting-started.md) walks through each case.

### Must I use Git? Do I need to commit and push my data to a remote repository like GitHub?

Git is strongly recommended, and `npx dreamteamer init` creates the repository for you unless you pass `--no-git`. Without Git a workspace still reads, writes, validates and compiles. What you lose is the history, the undo and `npx dreamteamer commit`.

A remote is optional. Nothing is pushed unless you push it: `init --git <url>` adds a remote and never pushes.

### How do I undo a change?

Every record has its Git history, and three verbs read it:

```bash
npx dreamteamer history tasks/buy-milk              # its revisions, newest first
npx dreamteamer diff tasks/buy-milk --hash <sha>    # what one revision changed
npx dreamteamer revert tasks/buy-milk --hash <sha>  # restore the record as it was at that revision
```

`revert` puts the old content back as a new change, which `npx dreamteamer commit` then publishes. History is never rewritten. In practice you just ask your agent to undo it.

### How do I update dreamteamer or a module?

A workspace pins exact versions, so nothing moves until you say so:

```bash
npx dreamteamer update --engine             # the engine, to the latest release
npx dreamteamer update @dreamteamer/tasks   # one module
npx dreamteamer check                       # still clean?
```

`update` re-pins, compiles and commits. [UPDATING.md](UPDATING.md) has one section per release saying what you have to do, which is usually nothing.

### Does it work offline?

Yes. The engine is a local command-line tool: it has no server and needs no account. The network is used when npm or Git fetch something, such as installing or updating a module, or when you push. Even that has an offline path: `npx dreamteamer install <name> --from <folder>` installs from a folder of package tarballs.

Two things outside the engine may still need a connection: your coding agent, and any module whose job is to talk to a service (a calendar sync, for example).

### Do I need the VS Code extension?

No. The CLI and the records are the complete system. The [VS Code extension](https://marketplace.visualstudio.com/items?itemName=dreamteamer.dreamteamer-vscode) draws the same workspace as lists, boards and record pages, for when you would rather look than ask.

### How do I create a module?

See [EXTENDING.md](EXTENDING.md). In short: `npx dreamteamer add modules --name <id> --extension --package <npm name>` scaffolds one, and `npx dreamteamer check modules/<id> --alone` says whether it is publishable. Or ask your agent to build one with you.

## Trust and scale

### Is my data safe? Does it stay private?

dreamteamer runs on your machine and has no server of its own. Your data is plain files in your folder. It leaves your machine when you push it, or when your agent or a module you installed sends it somewhere. Vet a module before you install it, as you would any code you run. See [Security considerations](README.md#security-considerations).

### Why open source? How come it's free?

It is free because there is nothing to charge for: no hosted service, no account, no server. dreamteamer is a command-line tool and a set of file conventions, licensed under [Apache-2.0](LICENSE), so you can use it, change it and build on it, at work included. The official modules carry the same licence. You still pay for whatever your coding agent costs.

It is open source because of what it holds. Your context is your notes, your plans and your decisions, and the tool that sits between them and your agents should be one you can read. The same goes for the data: Markdown and YAML files in a Git repository you own. If you stop using dreamteamer, your files stay readable as they are.

Modules are also meant to be shared, and that only works in the open.

### Is it stable?

dreamteamer is pre-1.0 and moves fast. A release that changes behaviour gets a section in [UPDATING.md](UPDATING.md) saying what an existing workspace has to do. And because a workspace pins exact versions of the engine and of every module, an upgrade happens when you run `update`, not before.

### Can dreamteamer handle large scale engineering projects?

It is designed for them. We don't publish benchmarks, so here is what the design gives a large project, and what it does not.

- **Modules.** Each domain is its own package with its own version. The `@dreamteamer/rnd` module, for example, keeps a software lifecycle as records: products, design docs, implementation plans, tests, reviews and releases.
- **Namespaces.** A module can scope its collections under a prefix (`rnd/issues`), so two domains never fight over a name.
- **Layers.** A workspace can read another workspace's records by listing its repository under `git_modules`. A head-office workspace can read every project's tasks while each project keeps its own repository, and `--workspace <name>` runs any verb inside one of them.
- **Many sessions in parallel.** A write does not commit by itself, and `npx dreamteamer commit` can be scoped to one collection or one record, so agents working in the same folder do not sweep up each other's work.
- **Git.** Branches, reviews and merges work on a workspace the way they work on code.

What it is not: a database server. Records are files and the history is Git, so big and binary files stay outside the records (a record points at them), and how far one repository stretches is Git's answer more than ours. The honest test is to try it on a slice of your project.

### I found a bug or a security problem. Where do I report it?

Bugs and questions go in an [issue](https://github.com/dreamteamer/dreamteamer/issues). For anything larger than a typo, start a discussion before a pull request (see [CONTRIBUTING.md](CONTRIBUTING.md)). Security problems are reported privately: see [SECURITY.md](SECURITY.md).
