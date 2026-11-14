# dreamteamer — FAQ

### What is a context package manager and why do I need one?

A [context package manager](https://www.youtube.com/watch?v=TqJ7Q_c_W1Y) is a tool that helps you construct and maintain agentic workspaces in a **modular, structured, and consistent** manner by treating context as source code, and applying software engineering best practices to context development and maintenance.

You need it because structured context dramatically improves the reasoning, consistency, and reliability of agents in scenarios with repeated tasks.

### Do I need to be a coder to use dreamteamer?

No, you don't need to be a coder to use dreamteamer. It is designed to apply software engineering best practices under the hood, while you continue to maintain your conversation in natural language.

### What coding agents are supported?

Claude Code, Codex, Cursor, Gemini CLI and Pi. `npx dreamteamer compile` writes each one's own files (skills, agents, commands, instructions) from one source, so every harness sees the same workspace.

### Does dreamteamer replace coding agents?

No, dreamteamer is not a coding agent. It works within your existing coding agents to provide a more streamlined and predictable agentic workflow.

### How does dreamteamer work?

It keeps a typed data model for your workspace and injects that model, with instructions for using it, into every conversation, so the agent writes well-formed records through the CLI instead of guessing. See [Under the hood](README.md#under-the-hood).

### How do I get started?

See [Getting started](README.md#getting-started): one prompt for non-coders, or `npx dreamteamer init` in an empty folder.

### What are common use cases for dreamteamer?

A second brain (tasks, contacts, meetings, files) and an AI software factory (design, plan, build, test and release as records). The [modules repository](https://github.com/dreamteamer/dreamteamer-modules) lists what ships today.

### How do I create a module?

See [EXTENDING.md](EXTENDING.md). In short: `npx dreamteamer add modules --name <id> --extension --package <npm name>` scaffolds one, and `npx dreamteamer check modules/<id> --alone` says whether it is publishable.

### Must I use Git? Do I need to commit and push my data to a remote repository like GitHub?

Git, yes: a workspace is a Git repository, and its history is how changes are tracked and undone (`npx dreamteamer init` creates the repository unless you pass `--no-git`). A remote, no: nothing is pushed unless you push it. `init --git <url>` adds a remote and never pushes.

### Is my data safe? Does it stay private?

dreamteamer runs on your machine and has no server of its own. Your data is plain files in your folder; it leaves your machine when you push it, or when your agent or a module you installed sends it somewhere. See [Security considerations](README.md#security-considerations).

### Why open source? How come it's free?
(content pending)

### Can dreamteamer handle large scale engineering projects?
(content pending)
