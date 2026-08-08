# working with structured data files

**core principle:** the CLI is the default path — it validates before disk, generates the id,
materializes defaults and commits with the right subject. direct file edits stay first-class,
but then *you* owe every rule below.

## when to use

any time a record is read, created, changed, renamed or removed — a task, a contact, a meeting,
a doc, anything under `data/` or `state/`. load it especially when you catch yourself about to
`mv` a record file, hand-write frontmatter from memory, or set a field you haven't read in the
descriptor.

**not for:** schema changes (`building-dreamteamer` → `references/collections.md`), or system-stored records — skills, agents,
commands, ui-views, collections. those are *sources*: edit the file under the owning
module (`modules/<module>/<kind>/`) and run `npm run compile`; the CLI refuses them on
purpose.

## the verbs

`npm run --silent dt -- help` lists the generic record verbs and their flags. read them there.
but **`help` is not the whole surface** — collections with a purpose-built verb (`collections add`,
`<collection> add-field`, `repos ensure`) don't appear in it, and a verb missing from `help`
is not a verb that doesn't exist. when a skill names a verb, use the verb.

what the help text can't tell you either way:

- **validation is hard and it includes unknown fields.** a typo'd key (`--assinee`) is rejected
  with nothing written, same as a dangling ref, a bad enum value (the error echoes the value it
  got) or an id that misses `id.pattern`. a rejected write leaves no partial state.
- **every write verb commits by itself**, with the right subject — never stack another commit
  on top.
- `set <id> <field>=` with an empty value **removes** the field; array fields take a
  comma-separated value (`--attendees contacts/a,contacts/b`).
- `--json` works on every verb — use it whenever you're going to parse the output.
- `npm run check` validates the whole workspace after the fact: report-only, never rewrites.

## before writing anything

read the compiled descriptor: `.dreamteamer/collections/<collection>.collection.yaml`.
it defines `storage` (path/codec/shape/suffix), `id` (`generate` template + `pattern`), and
`schema` (JSON Schema; the `x-` keywords carry the domain semantics — `x-reference`, `x-body`,
`x-title-template`). It also carries `title` (what to CALL the collection) and `title_template` (how
to label one of its records) — both resolved by compile from the id unless authored.

## writing a record by hand

**default to `dt <collection> add`** — id, defaults, validation and commit in one line. hand-write
only when the CLI can't express the value: a nested map, or a long structured body.

when you do, don't reconstruct the shape from the schema — **`dt <collection> get <existing-id>
--json` prints the exact shape a valid record has**: which fields, which ref forms, dates as
strings. copy a sibling, change what differs, and:

- put the file where the id says: the id IS its path inside `storage.path`, minus suffix and
  extension (folder-shape records are a folder named `<id>` holding the descriptor's `entry`).
  ids are built from **creation-time** values only, never a mutable field, and must satisfy
  `id.pattern`.
- **materialize defaults explicitly** — write `status: todo` even though it's the schema default;
  a file should be legible without its schema.
- `npm run check` is the only validation a hand-write gets. run it before you commit, once:
  `dreamteamer: <collection> add <id>` (or `set <id>`, for an update).

example — `data/tasks/2026-07-25--fix-login-flow.task.md` (`md` codec: frontmatter holds the
fields, the body is the single `x-body: true` field):

```markdown
---
title: Fix login flow
status: todo
assignee: users/ada
due: '2026-07-28'
---
Users report the login button does nothing on mobile.
```

## the hard rules

**never hand-rename or `mv` a record file** — the id IS the path, so a rename silently dangles
every inbound reference; `rename` moves the file and rewrites all refs in one commit. **never
delete a referenced record** (`rm` refuses for a reason — retarget first). **a changed title
never changes the id.** **one mutation, one commit.**

## common mistakes

| mistake | reality |
|---|---|
| `mv data/tasks/old.task.md …/new.task.md` | every inbound ref now dangles. use `dt … rename`. |
| renaming a file because the title changed | the id is not a display name — edit the field. |
| reaching for `--force` to get past the refuse | it leaves the inbound refs dangling. retarget them first — unless `rm` named a *prose* mention (a skill's example, a doc), which isn't a real reference and `check` won't flag. |
| hand-writing a record "because it's quicker" | no validation, no defaults, no id check, no commit. `dt … add` is one line. |
| omitting schema defaults from a hand-written file | the file stops being legible without the schema. |
| unquoted `due: 2026-07-28` | dreamteamer parses with CORE_SCHEMA so it stays a string *here*, but any default-schema YAML reader turns it into a timestamp. quote dates when hand-writing. |
| CLI-editing a skill / agent / command / collection | system sources — edit the module file, then `npm run compile`. |
| committing again after a CLI verb | the verb already committed; you'd sweep unrelated work into it. |

## red flags — stop

- you're about to `mv`, `cp` or `rm` a file under `data/` or `state/` directly
- you're writing a reference you haven't confirmed resolves
- you're editing anything under `.dreamteamer/` (generated, gitignored)
- you finished a bulk edit and haven't run `npm run check`
