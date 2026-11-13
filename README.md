# dreamteamer

dreamteamer is a lightweight, open source, cross-harness **context package manager** for humans and AI agents. All major AI coding agents are natively supported, including Claude Code, Codex, Cursor, Gemini, Pi and more.

#### What is a context package manager and why do I need one?

A context package manager is a tool that helps you construct and maintain  agentic workspaces in a **modular, structured, and consistent** manner by treating context as source code, and applying software engineering best practices to your AI agents' working context. You need it because structured context dramatically improves the reasoning, consistency, and reliability of agents in scenarios with repeated tasks. Read our [FAQ](FAQ.md) for more details.

dreamteamer ships with a base set of [modules](https://github.com/dreamteamer/dreamteamer-modules) for common use cases such as second brains and AI software factories, and you can easily extend existing modules or create your own through natural language conversation.  See [EXTENDING.md](EXTENDING.md) for more details on how to create your own modules.

## Getting started

### For humans (non coders)
In Claude Code (or any other agent harness), paste the following prompt, replacing `my-workspace` and `~/Documents` with your desired values:

```markdown
create a new folder names "my-workspace" under my "~/Documents" folder.

Read the [dreamteamer README](https://github.com/dreamteamer/dreamteamer) and initialize a blank new private dreamteamer workspace in that folder. Ensure I have all the prerequisites to run dreamteamer on my machine.

Read the [dreamteamer modules README](https://github.com/dreamteamer/dreamteamer-modules), then interview me for my goals and needs, and suggest an optimal set of packages that can help me accomplish them. Help me set up the packages properly, along with all the required dependencies and configurations.

Verify that the workspace works by running `npx dreamteamer status` and making sure it reports everything as expected. 
```
Then start a new session in your newly created folder (some agents may already switch to it automatically). Continue your conversations with the agent in this folder as you would normally. You can start by asking:

```
I'm new to this workspace, explain in simple and concise terms what I can already do here.
```

To import any existing data into your newly created workspace:

```markdown
Help me import relevant data from my machine into this workspace. Ask me questions as needed to understand the data and how to import it, and let me know what permissions you need. 
```

To expand the workspace with additional capabilities: 

```markdown
I'm trying to do XXX - how can I leverage dreamteamer to help me accomplish this? What changes should I make to the workspace and what modules should I install or create? Walk me through the process step by step.
```

### For agents (and code-savvy humans)

#### Prerequisites
```bash
node -v # >=24.x.x
npm -v # >=11.x.x
git --version # >=2.39.x
```

Note: some modules may have additional prerequisites. The `npx dreamteamer install` command will ask you for permissions to install prerequisites as needed.

#### Installation

```bash
mkdir my-workspace && cd my-workspace
npx dreamteamer init

# optional - install some pre-built modules from https://github.com/dreamteamer/dreamteamer-modules
npx dreamteamer install @dreamteamer/tasks @dreamteamer/contacts 

npx dreamteamer status
npx dreamteamer help    # every verb and flag
```

### For VSCode users

Install the [dreamteamer VSCode extension](https://marketplace.visualstudio.com/items?itemName=dreamteamer.dreamteamer-vscode) and use the `Dreamteamer: Create Workspace` command to create a new workspace.

## Under the hood

Warning: technical details ahead. Non technical users may safely skip this section.

dreamteamer works by maintiaing a well-defined data model for your workspace, and injecting the model schema along with guided instructions on how to use it, into every conversation. This operates similarly to the way Claude code and other harnesses inject skill names and their descriptions. 

For example, say you maintain a [task list](https://github.com/dreamteamer/dreamteamer-modules/tree/main/modules/tasks). Now when you ask something like "create a task to buy milk", the agent runs a CLI command like `npx dreamteamer add task --name "buy milk"` to compose a well structured task entry, instead of trying to guess what a `task` means in this context, how it looks like, and where to write it. This is the key driver for consistency and reliability of agents over time and across sessions.

On top of that, every dreamteamer workspace or package is also a [GIT repository](https://git-scm.com/book/en/v2/Getting-Started-What-is-Git%3F). The GIT log becomes your personal time machine - so you (and more importantly, your AI agents) can track how your workspace evolves, make changes in a granular manner, and revert to previous states if something goes wrong. You can also fork, clone, branch, and merge dreamteamer workspaces and the data stored inside them, creating infinite possibilities for exploration and collaboration.

The best way to gain a deeper understanding of dreamteamer is to read the [using-dreamteamer skill](skills/using-dreamteamer/SKILL.md).

### Key concepts and design philosophy

Designed by coders, for both humans and AI agents, dreamteamer is built with decades of software engineering best practices in mind. 

- **Core engine design goals**
  - [x] **AI native** - built from the ground up with AI agents in mind 
  - [x] **Lean core** - minimal design, everything else is an optional add-on
  - [x] **Adaptive and extensible** - allow users to easily extend dreamteamer with their own modules and data models
  - [x] **Standards-first approach** - markdown, frontmatter, AJV, and GIT are the foundation of dreamteamer.
  - [x] **Friendly for both agents and humans** - data and instructions are stored in plain text
  - [x] **Harness-agnostic** - compile agent instructions from a single source of truth into formats that can be used by any supported agent harness
- **Context engineering principles**
  - [x] **Schema-first** - treat context as data that conforms to a schema, and provide the schema to AI agents with every conversation.
  - [x] **Relational** - allow easy expression of One-to-one, one-to-many, and many-to-many relationships between data entities.
  - [x] **Schema-validated** - all data and relationships are validated against a schema with `npx dreamteamer compile`, errors are reported and corrected by the agents 
  - [x] **Rich metadata** - annotate the data model with rich metadata about usage, relationships, validation, display, and more, to provide context and guidance to AI agents
  - [x] **Modular** - allow users to group related data models and agents into modules that can be shared and reused
  - [x] **Layered schemas** - allow user to override or extend collections and fields from imported modules
  - [x] **Layered data** - allow users to import both schema-only modules and provide their own data, or import both modules with schema+data.
  - [x] **Persistent and durable** - store all state in the package data folder
  - [x] **Non-destructive data authoring** - commit and push every data state change with GIT, revert as needed.
  - [x] **Auditable** - track all data state changes through GIT commit log.
  - [x] **Versioned** - allow multiple versions of schemas and data, switch between versions at will
- **Developer experience**
  - [x] **CLI driven** - All functionality is exposed through a CLI
  - [x] **Programmable** - import dreamteamer into your js/ts scripts, work with the same interface 
  - [x] **AI primitives** - skills, agents, and commands are first class citizens in every engine module
  - [x] **Extensible** - allow users to easily extend dreamteamer with their own modules and data models
  - [x] **Portable** - sync changes through git, move between machines, and parallelize work across agents and harness instances
- **User experience**
  - [x] **Conversational** - all engine and installed modules functionality exposed through natural language commands 
  - [x] **Presentational** - every data entity exposes display metadata in its schema, making it immediately presentable to arbitrary UI clients. [ui-views](collections/ui-views.collection.yaml) provide out-of-the-box configurable list and item views for every entity. The [dreamteamer-ui](https://github.com/dreamteamer/dreamteamer-modules/tree/main/modules/ui) package provides core set of UI elements. The [dreamteamer-vscode extension](https://marketplace.visualstudio.com/items?itemName=dreamteamer.dreamteamer-vscode) provides built views for vscode, and the [dreamteamer-web](https://github.com/dreamteamer/dreamteamer-web) module shows identical UI in agent desktop apps such as Claude Desktop and Codex.  
  - [x] **Collaborative** - leverage GIT to collaborate on workspaces and share changes with other users, AI agents, or in parallel across multiple sessions and machines.
  
### Security considerations

When using dreamteamer, [standard AI agents security measures](https://code.claude.com/docs/en/security) apply. dreamteamer itself does not introduce new vulnerabilities, it allows you to do the same things you could already do with your AI agents, in a well-governed, auditable and consistent manner. You should continue to apply the same security considerations you would apply when using your AI agents. This includes never sharing credentials, tokens, API keys, or any other sensitive information with your agents, and always being mindful of the data you share with them. Private workspaces should be treated as such, and appropriate access controls should be put in place.

When installing new modules, always vet them first, and make sure you trust the author, understand what they do and what permissions they require. The dreamteamer org curates a selection of high quality community modules that adhere to our coding standards. See the [modules repository](https://github.com/dreamteamer/dreamteamer-modules) for more details. Official modules include "dreamteamer" in their name, and are always served under the dreamteamer org github and npmjs namespace.

Note: some modules may require elevated permissions or access to sensitive information (for example, access to arbitrary locations on your filesystem, cloud storage, APIs, etc.). Only grant such permissions after carefully vetting the module and making sure you understand and trust what it does. You should treat dreamteamer modules as you would treat any other code you run on your system, and apply the same security considerations.  

If you've encountered a security issue or have any concerns, please report it through the appropriate channels - see [SECURITY.md](SECURITY.md) for more details on dreamteamer security practices.

## Contributing

We welcome issues and discussions! For anything larger than a typo, please open a discussion before submitting a PR. This is a deliberately lean codebase and we prefer to agree on shape first. `npm run verify` enforces our size and test budgets. 

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[Apache-2.0](LICENSE) © 2026 Gilad Khen and the dreamteamer org.
