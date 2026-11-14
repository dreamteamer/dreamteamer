import { changesCommand } from "./changes/changesCommand.ts"
import { commitCommand } from "./commitCommand.ts"
import { doctorCommand } from "./doctor/doctorCommand.ts"
import { fmtCommand } from "./fmt/fmtCommand.ts"
import { relocateCommand } from "./relocateCommand.ts"
import { resolveCommand } from "./resolveCommand.ts"
import { statusCommand } from "./statusCommand.ts"
import { runExports } from "./exports/runExports.ts"
import fs from "node:fs"
import path from "node:path"
import * as api from "./api.ts"
import { openWorkspace, findWorkspace } from "./api.ts"
import { checkAlone } from "./check/checkAlone.ts"
import { compile, warnIfStale, kindsOf } from "./workspace/compile.ts"
import { check } from "./check/check.ts"
import { targetCommand } from "./targetCommand.ts"
import { emit } from "./lib/emit.ts"
import { relationsCommand } from "./relationsCommand.ts"
import { initCommand } from "./init/initCommand.ts"
import { installCommand } from "./install/installCommand.ts"
import { updateCommand } from "./update/updateCommand.ts"
import { Store } from "./store/Store.ts"
import { splitRef } from "./record/splitRef.ts"
import { canonicalCollection } from "./record/ref.ts"
import { setupCommand } from "./setupCommand.ts"
import type { Flags, Workspace } from "./types.ts"
export const USAGE = `usage: dreamteamer <verb> [<target>] [flags]

  --workspace, -w <name|path>
                   run the verb in another workspace: a record layer this workspace declares, by
                   its git_modules name, or any workspace by path. A path resolves from the
                   directory you typed it in; every other path in the command resolves inside the
                   target. The working directory is unchanged, and the flag reaches this command
                   only: a process it starts resolves its own workspace from its own directory.
  --vault <path>   deprecated — the old spelling of --workspace, still honoured.

record verbs (hard validation — invalid writes are rejected before disk).
A <target> is either a collection name or a <collection>/<id> reference; the reference splits at
the longest DECLARED collection prefix, so finance/transactions/2026/03/coffee is ONE argument:
  list   <collection> [--filter k=v] [--where <json>] [--sort [-]<field>] [--json]
                                              (--filter is ONE condition — repeat it to AND more
                                               (--filter a=1 --filter b=2 wants both);
                                               anything compound goes in one --where, operator
                                               objects e.g. '{"starts":{"_gte":"2026-07-01"}}' —
                                               operators: _eq _neq _lt _lte _gt _gte _in _nin
                                               _null _empty _contains _starts_with _ends_with
                                               _between _regex _and _or, plus _n*/_i* negated and
                                               case-insensitive variants; date-times sort and
                                               compare as instants, across offsets; an enum
                                               sorts in its declared order)
  get    <collection>/<id> [--json]           (--json, and each list --json row, adds $file and
                                               $repo: where the record is read from and the repo
                                               that commits it — null outside every repo here)
                                              [--referrer <collection>/<id>] an id no root holds is
                                               named from the referrer's repo's exports manifest
  add    <collection> ["<title>"] --<field> <value> … [--id <explicit-id>]
                                              (ONE bare positional fills the collection's title
                                               field — the one its record_title opens with — so
                                               dt add task "call the bank" is
                                               dt add tasks --name "call the bank".
                                               a format: binary collection takes --from <path>
                                               instead — the file IS the record, fields derive;
                                               --force replaces an existing file record.
                                               A repeated --<field> is one ELEMENT of an array
                                               field — refused on a scalar one; a single value
                                               still splits on commas)
  set    <collection>/<id> <field>=<value> …  (repeating a pair adds an element, exactly as a
                                               repeated --<field> does)
  rm     <collection>/<id> [--force]
  rename <collection>/<id> <new-id>           (rewrites all inbound refs in one WRITE —
                                               commit publishes the set together)
  reorder <collection>/<id> --after|--before <id> | --top | --bottom
  reorder <collection> --init                 (place every record that has no position yet — the collection's \`type: position\` field)
  values <collection> <field> [--limit n]     (the vocabulary a field actually uses —
                                               what a filter/validator offers as choices)
  history <collection>/<id> [--json]          (git revisions of this record, newest first)
  diff    <collection>/<id> [--hash <sha>]    (the patch one revision applied; defaults to HEAD)
  revert  <collection>/<id> --hash <sha>      (restore the content at <sha> as a pending write)
  next    <collection>[/<id>] [--ids <id>,…]  (which bound commands apply, and in which state:
                                               available / done / not-applicable — what can
                                               happen to this record next)
  relations [<collection>]                    (every two-way pair: owner.field → target.mirror)
  relations rebuild <collection> [--drop <f>] (regenerate mirror VALUES from the owning side;
                                               --drop removes a stale ex-mirror key from records)
  relocate <target> [--dry-run] [--json]      (move record FILES to where the compiled descriptor
                                               puts them — a record stored under another
                                               collection (storage.under) whose folder disagrees
                                               with its owner field, or a file record in a
                                               collection that became shape: folder. Ids and
                                               references never change; a pending edit on a
                                               moved file, or a dangling owner, refuses the whole
                                               plan — commit, or fix the field, first)
  relocate <collection> --to-root [--dry-run]  (the REVERSE: every placed record back into the
                                               collection's own folder, ids unchanged — the step
                                               before removing or changing storage.under)
  resolve '<string>' | <collection>/<id> <field>
                                              (render \${env:NAME} · \${workspaceFolder} ·
                                               \${userHome} — the ONLY substitution point; a
                                               record keeps the template verbatim. An array
                                               field prints one item per line)

system verbs — the SAME verbs, on the entities the compiler materializes (modules, collections,
skills, agents, commands, command-bindings, ui-views, mixins, and any kind an
installed extension adds). ⚠ ONE
difference in POLICY, not in spelling: a SYSTEM write commits itself, because an uncompilable or
unpublished schema is not a state a workspace should sit in; a RECORD write does not — \`commit\`
publishes it. The commit lands in the repo that holds the source, so a write into a git module
commits there.
  add    collections --name <name> [--module <m>] [--namespace <ns>] [--mixins docs,…]
                                              [--id-from '{{ … }}'] [--description "…"] [--suffix <s>]
                                              (--namespace health --name doctors === --name
                                               health/doctors; a module declaring exactly ONE
                                               namespace infers it, and the resolved name is echoed.
                                               --namespace '' means no namespace)
  add    modules --name <id> [--description "…"] [--namespace <ns>] [--extension] [--package <npm name>]
                                              (modules/<id>/ + every kind folder + package.json + README.md,
                                               floored on this engine. --namespace DECLARES it in the module
                                               (§8), so every later \`add collections --module <id>\` infers it.
                                               --extension adds src/extension.js with a one-token setup unit;
                                               --package names it for npm and makes it publishable — the
                                               folder stays the id. Without it, folder = package name = id.
                                               the git shape is \`install --clone <url> [name]\`)
  add    skills --name <id> --description "…"  (skills/<id>/SKILL.md — --description is required,
                                               because an undescribed skill is undiscoverable)
  add    ui-views --route </route> --scope collection --collection collections/<c>
                                              [--id <id>] [display.list.layout=<id>] [k.v=…]
  set    <system>/<id> <field>=<value> …      (collections: description · use_when · title ·
                                               singular · record_title · sensitive · internal ·
                                               display.nav.icon · display.nav.order ·
                                               display.nav.section · display.list.columns ·
                                               display.list.sort, plus module=<m>, which MOVES it.
                                               modules: description · namespaces · dependencies ·
                                               peer_collections, record-shaped (modules/core).
                                               ui-views: dotted keys — display.list.sort=-date. An
                                               empty value REMOVES the key; quote it to write the
                                               empty string itself ('display.list.sort=""').
                                               skills/agents/commands/…: frontmatter keys)
  rm     <system>/<id> [--force] [--dry-run]
  rename <system>/<id> <new-id>               (a collection's rename moves its records, re-suffixes
                                               the files and rewrites every inbound ref, ONE commit)
  reorder <system>/<id> --after|--before <id> (nav ordering — it writes \`display.nav.order\`)
  get    collections/<c> [--module <m>]       (--module prints ONE module's source contribution
                                               rather than the merged descriptor)
  list   modules | collections | skills | …   (id · location · path · namespaces · package name)
  revert <system>/<id>                        (refused: its source is in git —
                                               \`git checkout <sha> -- <path>\` then \`dt compile\`)
  fmt    [<collection>] [--dry-run]           (collection and mixin sources in block style, top-level
                                               keys in canonical order; fields, the keys inside a
                                               field and every comment stay where they are. Sources
                                               under git_modules/ and node_modules/ are skipped)

field verbs — a field is the one sub-entity, and it has verbs of its own (there is no \`fields\`
collection: the ENGINE does not read one, and \`rename-field\` was the only capability it would buy):
  add-field    <collection> --name <field> [--type <type>] [--many] [--required]
                            [--enum a,b] [--default-value v] [--unique] [--mirror-of <field>]
                            [--on-delete restrict|set-null] [--soft] [--sensitive] [--body]
                            [--description "…"] [--module <m>]
                            types: string markdown boolean integer number date datetime url email
                                   reference map position, a collection name (a reference), or
                                   a,b for a union of collections (an object's sub-fields are
                                   authored in the descriptor). --many makes it a list; a
                                   date-time may be written as "2026-07-28 12:00" and the local
                                   offset is stamped on for you.
                            --mirror-of <field> makes this the generated, read-only mirror of the
                            --type collection's <field>, which references this one; a unique key
                            mirrors as one record, any other as a list.
                            --soft lets a reference name a record that does not exist (yet); the
                            value must still name one of its collections.
                            --body marks the field a record's PROSE lands in (the text after the
                            frontmatter): --type markdown, one per collection, and it stays last.
                            A field the collection's module does not own lands in an OVERLAY
                            (--module names the module; it must depend on the owner).
  set-field    <collection> --name <field> [the add-field flags] [--module <m>]
                            (each flag changes the key it names and nothing else; an empty value
                             clears it — --enum= --default-value= — and false clears a switch —
                             --unique false. set-field never moves a field.)
  rm-field     <collection> --name <field> [--module <m>] [--dry-run]
                            (clears the field's VALUES in the same write, and reports the count;
                             prunes it from its own columns, sort, badge and sections, and refuses
                             naming every other position that still names it)
  rename-field <collection> --name <field> --to <new-name> [--dry-run]
                            (rewrites the key in every record AND every position that names the
                             field: the collection's sources, templates, ids.from, display,
                             constraints, storage.under.parent, a mirror's mirror_of, a ui-view's
                             filter and display, a binding's conditions. ONE commit; a position it
                             cannot rewrite is refused by name, and --dry-run lists each one)
  rename-value <collection> <field> <old> <new> [--dry-run]
                            (renames one enum value: the enum, its default, a constraint's const or
                             enum, view filters, binding conditions and every record. ONE commit)

Every <collection> above may be spelled in the SINGULAR: dt add task …, dt get task/<id>,
dt list meeting-analysis, dt add-field task …. The singular is derived from the descriptor
(tasks → task, companies → company) and authored on it as singular: where inflection is
wrong (people → person); compile refuses two collections whose words collide. A REFERENCE
inside a record still names the collection in full — tasks/kickoff, never task/kickoff.

Every verb that MOVES records or CLEARS values takes --dry-run and prints its plan first:
    records N · refs M · descriptors K · values cleared V

workspace verbs:
  init        from a folder to a workspace in ONE command: pins the engine that runs it (exactly),
              writes the skeleton, installs, compiles, checks, runs the safe part of any declared
              module's setup, makes the folder a git repository when it is not one and commits what
              it wrote (inside a repository: the same scoped commit, your staged work untouched).
              Refused before any write: an engine of another version declared, locked or installed
              (never upgraded — dt update --engine), and a path it writes that links out of the
              folder. Re-run it to resume — a repeat changes nothing.
              [--no-git] [--git <remote-url>] (adds origin, never pushes) [--no-compile]
              [--from <dir>] (a preset's missing packages from a folder of tarballs, offline)
              [--input <id>=<value>]… [--allow <kind>]… [--no-input] (a preset's setup, as \`setup\`)
              [--harnesses claude-code,codex,pi,gemini-cli,cursor] [--workspace_module <name>]
  --version   print the engine version (works anywhere)
  install     make THIS checkout ready — the engine, .env (linked from the primary when this is a
              worktree), declared local assets, git modules, compile, and a declared postinstall.
              Idempotent: it prints a board of what it found and what it did
              [--dry-run] plan only  [--json] the board as data
              [--link-env] link .env even into a worktree OUTSIDE the primary root
  install     --hook | --print-adapters
              --hook: read a harness hook's JSON payload from stdin and install the checkout its
              \`cwd\` names — the process cwd is the harness's, never the worktree's
              --print-adapters: print the hook snippet for each declared harness, with every hook an
              installed extension adds. Merging it into the harness's own settings file is the
              operator's act — the engine never writes one
  install     repos/<id> | repos --all [--json]
              materialize an attached repo's working tree ON DEMAND — never as part of making a
              checkout ready; --all is the explicit opt-in, e.g. before going offline
  install     <spec>… [--from <dir>]          bring a MODULE in: a name, name@version, ./file.tgz,
              ./folder (a development link) or a git URL — installs it and every module its
              dreamteamer.dependencies names (refusing, before npm writes anything, a package with
              no dreamteamer key, an engine floor this engine does not meet, a ring, a version
              installed differently, and a package an installed one already provides), pins exact
              versions, compiles, runs the safe part of the module's setup and commits package.json,
              package-lock.json and what setup wrote. Without a version: npm's latest. --from
              resolves names from a folder of tarballs (offline). Setup flags as for \`setup\`:
              [--input <id>=<value>]… [--allow <kind>]… [--no-input]; [--no-commit] [--json]
              Exit 0 done · 1 refused or failed (nothing half-written) · 2 usage · 3 input missing
  install     --clone <url> [name]            attach a git module to this workspace
  update      <name>[@<version>] | --engine   move ONE npm pin forward on purpose: to the latest
              release (or the named version), re-pinned exactly, closure-checked as install is,
              compiled, committed. A downgrade needs [--allow downgrade]; a development link is
              skipped and named; [--from <dir>] resolves from a folder of tarballs; [--no-commit]
  update      pull git_modules clones forward (ff-only on the lockfile ref), rebuild,
              then compile; [<name>] updates just one. dirty clones are skipped
  compile     materialize modules + workspace sources into .dreamteamer (+ harness adapters)
              [--watch] recompile on source changes
  check       validate every record against the compiled descriptors (report-only), then every
              installed extension's own checks. A reference this workspace's own records reach only
              through a record layer is a ⚠ line (a reader without that layer sees it dangle)
              through a record layer is a ⚠ line until its exports manifest lists it; a reference no root
              answers is external when the referring repo's manifest vouches for it
              [--strict-export] makes each unlisted one, and a stale manifest, a violation
              modules/<id> --alone: is that inline module publishable — packed, installed into a fresh
              workspace on this engine with only its declared dependencies, compiled, checked; exit 0
              publishable, 1 refused naming why, 2 usage [--keep] leaves the temp workspace
  exports     write this workspace's dreamteamer-exports.json — each id its records name that no file
              here holds, with its label and the workspace holding it — and commit that one file
              [--layer <name>] that layer's, from this workspace's view  [--dry-run] [--json]
  doctor      what works on this machine — the engine, then each extension's checks — as one board:
              READY / DEGRADED / UNAVAILABLE, each fix on its row. Exit 0 [--strict] exit 1 when
              anything is UNAVAILABLE [--json]
  setup       [<unit>] drive the setup a module declares — resume, repair, verify, sign in. The
              engine names no module: a unit is what an installed package contributes (dt status
              lists them). Inputs: [--input <id>=<value>]… (or <unit>.<id>=; then the environment,
              then the declared default; a terminal asks for what is still missing, [--no-input]
              never asks → exit 3 with the ids). Effects: workspace-file writes run; download,
              network and machine ask y/n in a terminal or run under [--allow <kind>]…; an account
              step (sign-in, consent) runs only under [--authorize], in a terminal. [--verify] runs
              the unit's live check and writes its receipt. [--skip] records the skip in
              package.json (dt setup <unit> clears it). [--json] the result as data.
              Exit 0 done (pending and blocked steps printed) · 1 a unit's apply failed · 2 usage · 3 a required input missing
  status      workspace status: compiled runtime freshness, per-module channel/ref, staleness

  changes     the records created / updated / deleted in every repo that holds records — the
              workspace and each record layer — grouped by collection, each with its path, layer
              and whether it is committed. Its first line is the report a reply ends with
              [--since <sha|YYYY-MM-DD>] (default: HEAD — what is written but not committed;
              a sha or date adds the commits since then, e.g. --since HEAD~1) [--json]
  commit      publish records already written to disk: samples git status over every
              collection's record dirs, one commit PER REPO, subject composed from the
              status letters. Scope it with any number of targets, each either a whole
              <collection> or one <collection>/<id> — the record form is what keeps a
              concurrent session's pending records out of your commit. Ends with the same
              record report \`changes\` prints, for what it published.
              [<collection>|<collection>/<id> …] [-m <subject>] [--dry-run] [--json]
  help        this text

extension verbs — an extension (a workspace module, or a dependency, whose package.json declares
\`dreamteamer.extension\`) adds its own verbs, listed below when this workspace has any.
`

// Record verbs, split by what their <target> means. `move` and `next` are in NEITHER set: both
// accept either shape, and which one it is has to be decided against the declared collections.
// How many rows a per-record listing prints before it summarises. ONE number, because a report that
// caps one of its lists and not the next reads as a bug in whichever list ran long.

const REF_VERBS = new Set(["get", "set", "rm", "rename", "history", "diff", "revert"])
const COLLECTION_VERBS = new Set(["list", "add", "values"])

// FIELD VERBS (add-field, set-field, rm-field, rename-field, rename-value). Their <target> is a collection and everything else is flags, which is the one shape
// that differs from the record verbs — so they get their own case arm rather than being folded into
// `dispatchRecordVerb`. There is no `schema <op>` table any more: system entities take the record
// verbs, and `targetCommand`'s interceptors are the whole dispatch (§4).

// WORKSPACE VERBS take a closed set of options, and nothing downstream of here would notice a
// misspelling — `dt commit --dryrun` COMMITTED, because `rest.includes('--dry-run')` is false for a
// flag nobody typed correctly. The record/system/field verbs are checked in `collections-cli.js`,
// beside the parser they share; these nine have no shared parser, so the table is here.
// Flags consumed BEFORE dispatch, in bin/dreamteamer.js, so no verb ever sees them. They are real
// and honoured; they are simply honoured earlier than VERB_FLAGS/WORKSPACE_FLAGS can express.
//
// ⚠ Listing one here EXEMPTS it from the "documented flags are accepted by some verb" guard, which
// exists because 0.19.0 shipped a flag that was documented and silently swallowed. The exemption is
// only safe while the behaviour is pinned somewhere else: `--workspace` / `-w` is covered end-to-end in
// test/integration/workspace-flag.test.js and `--vault` in cross-workspace-targeting.test.js. A global
// flag with no such file is the exact defect that guard was written to catch \u2014 add the coverage,
// not the entry.
export const GLOBAL_FLAGS = ["workspace", "vault"]

export const WORKSPACE_FLAGS: Record<string, string[]> = {
  init: [
    "name",
    "data_path",
    "harnesses",
    "workspace_module",
    "no-git",
    "git",
    "no-compile",
    "from",
    "input",
    "allow",
    "no-input",
  ],
  update: ["engine", "allow", "from", "no-commit"],
  install: [
    "clone",
    "dry-run",
    "json",
    "link-env",
    "all",
    "hook",
    "print-adapters",
    "from",
    "input",
    "allow",
    "no-input",
    "no-commit",
  ],
  compile: ["watch"],
  check: ["strict-export", "alone", "keep"],
  exports: ["layer", "dry-run", "json"],
  status: ["json"],
  doctor: ["strict", "json"],
  setup: ["input", "allow", "authorize", "verify", "skip", "no-input", "json"],
  changes: ["since", "json"],
  commit: ["dry-run", "json"],
  fmt: ["dry-run"],
  relocate: ["dry-run", "json", "to-root"],
}

/** Every verb this CLI answers itself — the set an extension's `commands` may not claim. The retired
 *  spellings are in it too: they answer with their replacement, and an extension taking one over
 *  would turn a loud translation into a different command. */
export const CORE_VERBS = [
  "init",
  "install",
  "update",
  "compile",
  "check",
  "exports",
  "doctor",
  "status",
  "setup",
  "changes",
  "commit",
  "help",
  "version",
  "--version",
  "-v",
  "list",
  "add",
  "values",
  "get",
  "set",
  "rm",
  "rename",
  "history",
  "diff",
  "revert",
  "reorder",
  "next",
  "add-field",
  "set-field",
  "rm-field",
  "rename-field",
  "rename-value",
  "relations",
  "resolve",
  "relocate",
  "fmt",
  "schema",
  "ensure",
  "update-field",
  "remove-field",
  "commands",
]

/** Verbs an extension answers, and the package it ships in — typed without it, the verb prints the
 *  install line. The container verbs belong to the global `dt-docker` bin, which needs no workspace. */
const VERB_PACKAGES: Record<string, string> = {
  prove: "@dreamteamer/proofs",
  land: "@dreamteamer/worktrees",
  worktree: "@dreamteamer/worktrees",
  serve: "@dreamteamer/http",
  notebooklm: "@dreamteamer/notebooklm",
}
const DOCKER_VERBS = new Set(["start", "stop", "open", "export", "import"])

/** `dt check` on a workspace with its extensions' own violations — what init and install verify with. */
const verify = async (ws: Workspace): Promise<number> => check(ws, { extra: await api.contributedViolations(ws) })

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  try {
    if (cmd in WORKSPACE_FLAGS) {
      const bad = rest
        .filter(a => a.startsWith("--"))
        .map(a => a.slice(2).split("=")[0])
        .find(f => !WORKSPACE_FLAGS[cmd].includes(f))
      if (bad)
        throw new Error(
          `unknown flag "--${bad}" on \`dt ${cmd}\`\n  known: ${WORKSPACE_FLAGS[cmd].map(f => `--${f}`).join(", ") || "(none — this verb takes no flags)"}`
        )
    }
    if (cmd === "--version" || cmd === "-v" || cmd === "version") {
      // works OUTSIDE a workspace — the post-install "did it land?" affordance
      const p = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
      console.log(`${p.name}@${p.version}`)
      process.exit(0)
    }
    if (cmd === "init") {
      // init runs BEFORE a workspace exists — no findWorkspace
      const flags: Flags = {}
      for (let i = 0; i < rest.length; i++)
        if (rest[i].startsWith("--")) {
          const [k, v] = rest[i].slice(2).split(/=(.*)/s)
          flags[k] = v ?? rest[i + 1]
        }
      // boolean flags take no value: a following positional is not theirs
      for (const b of ["no-git", "no-compile", "no-input"]) if (b in flags) flags[b] = true
      process.exit(
        await initCommand(flags, {
          open: openWorkspace,
          argv: rest,
          verify,
        })
      )
    }
    if (!cmd || cmd === "help") {
      // `help` works OUTSIDE a workspace too — a person who just ran `npm i -g dreamteamer` on a
      // bare machine has nothing else to read. Inside one, each installed extension's own usage
      // follows the engine's.
      let ws = null
      try {
        ws = await openWorkspace()
      } catch {
        /* no workspace, or an extension that will not load — plain help */
      }
      emit(USAGE + extensionUsage(ws))
      process.exit(0)
    }
    // `dt check modules/<id> --alone` judges one inline module in a fresh workspace (src/check-alone.ts) —
    // dispatched before the host is opened, because the module's own problem (a missing dependency, a
    // floor above this engine) would otherwise surface as the host's refusal instead of the gate's verdict
    if (cmd === "check") {
      const target = rest.find(a => !a.startsWith("--"))
      if (rest.includes("--alone")) process.exit(checkAlone(findWorkspace(), { target, keep: rest.includes("--keep") }))
      if (target) {
        console.error(
          `✖ check takes no target — did you mean --alone? (dt check ${target} --alone judges one inline module)`
        )
        process.exit(2)
      }
    }
    let ws
    try {
      ws = await openWorkspace()
    } catch (e) {
      // `status` is read-only and always answers: a runtime whose extensions refuse to load (two
      // packages claiming one unit, a bad declaration) is reported as the status, exit 0
      if (cmd === "status") {
        console.log(`✖ extensions did not load — ${String(e.message).split("\n")[0]}`)
        console.log(
          "  the setup section cannot be read until that is fixed; records and the compiled runtime are untouched"
        )
        process.exit(0)
      }
      throw e
    }
    // An EXTENSION'S VERB runs in-process, handed this workspace — the same engine instance, the
    // same loaded extensions. Its exit code is the process's.
    const ext = ws.extensions.find(e => cmd in e.commands)
    if (ext) {
      const code = await ext.commands[cmd].run(ws, rest)
      process.exit(typeof code === "number" ? code : 0)
    }
    switch (cmd) {
      case "install":
        return process.exit(
          await installCommand(ws, rest, {
            open: openWorkspace,
            verify,
            ensureRepos: args => targetCommand(ws, "repos", "ensure", args),
          })
        )
      case "update":
        return process.exit(await updateCommand(ws, rest, { open: openWorkspace }))
      case "compile": {
        const code = compile(ws)
        if (!rest.includes("--watch")) process.exit(code)
        console.log("… watching sources (modules/*, git_modules/*, and the workspace root) — ctrl-c to stop")
        watchAndRecompile(ws)
        return
      }
      case "check":
        return process.exit(
          check(ws, {
            extra: warnIfStale(ws.root).compiled ? await api.contributedViolations(ws) : [],
            strictExport: rest.includes("--strict-export"),
          })
        )
      case "exports": {
        const layers = rest
          .flatMap((a, i) => (a === "--layer" ? [rest[i + 1]] : a.startsWith("--layer=") ? [a.slice(8)] : []))
          .filter(Boolean)
        return process.exit(
          runExports(new Store(ws), { layers, dryRun: rest.includes("--dry-run"), json: rest.includes("--json") })
        )
      }
      // `dt setup [<unit>] …` — the generic driver of the units installed modules declare (src/setup.js):
      // inputs, consent per effect, inspect → plan → apply, the receipt. The engine names no module.
      case "setup":
        return process.exit(await setupCommand(ws, rest, { api }))
      case "doctor":
        return process.exit(await doctorCommand(ws, rest, api))
      case "changes":
        return process.exit(changesCommand(ws, rest))
      case "commit":
        return process.exit(commitCommand(ws, rest))
      case "status":
        return process.exit(statusCommand(ws, rest))
      case "help":
        emit(USAGE)
        return process.exit(0)
      case "list":
      case "add":
      case "values":
      case "get":
      case "set":
      case "rm":
      case "rename":
      case "history":
      case "diff":
      case "revert":
      case "reorder":
      case "next": {
        warnIfStale(ws.root)
        return process.exit(dispatchRecordVerb(ws, cmd, rest))
      }
      // The verb `check`'s stale-mirror message names. It reads the compiled relations, and
      // rebuild WRITES records, so both want the same staleness warning every record verb gets.
      // FIELD VERBS — see the note beside REF_VERBS at the top of this file. Their <target> is a collection and everything else is
      // flags, so they are their own case rather than being folded into `dispatchRecordVerb`.
      //
      // ⚠ THE RETIRED SPELLINGS ARE GONE, not aliased. The 0.12.0 policy: a stale invocation
      // must fail loudly, because a half-working grammar teaches the wrong shape without ever
      // saying so. The `default` arm below names each one — `schema`, `ensure`, `update-field`,
      // `remove-field`, `commands` — and carries its replacement.
      case "add-field":
      case "set-field":
      case "rm-field":
      case "rename-field":
      case "rename-value": {
        warnIfStale(ws.root)
        const [target, ...flagArgs] = rest
        if (!target || target.startsWith("--")) {
          throw new Error(`dt ${cmd} needs a collection: dreamteamer ${cmd} <collection> --name <field> …`)
        }
        // the singular is legal here too: `dt add-field task --name due …`
        return process.exit(
          targetCommand(ws, canonicalCollection(new Store(ws).descriptors, target) ?? target, cmd, flagArgs)
        )
      }
      case "relations":
        warnIfStale(ws.root)
        return process.exit(relationsCommand(ws, rest))
      case "relocate":
        return process.exit(relocateCommand(ws, rest))
      case "resolve":
        return process.exit(resolveCommand(ws, rest))
      case "fmt":
        return process.exit(fmtCommand(ws, rest))
      default:
        // ⚠ NAMED, not just unknown. Every doc, skill and downstream script spelled these
        // `dt schema <op>` for seven releases, so the failure has to carry the translation —
        // an "unknown verb" alone sends the reader to `help` to guess which of thirty verbs
        // replaced the one they typed. No alias layer and no deprecation window: 0.12.0's
        // policy, and the reason it is the right one is that `dt contacts list` failing
        // loudly is what taught the verb-first grammar in one command.
        //
        // ⚠ ONE EXIT CODE FOR ALL OF THEM: 2, the usage code. "You typed a verb that is
        // gone" is one answer, so a script (and an operator) asks it once rather than
        // learning which retirement exits 1 and which exits 2.
        if (cmd === "schema") {
          console.error(
            '✖ unknown verb "schema" — schema verbs are gone since 0.19.0. System entities take the RECORD verbs now:'
          )
          console.error(
            "    dt add collections --name <c> [--module <m>] · dt rm collections/<c> · dt rename collections/<old> <new>"
          )
          console.error(
            "    dt set collections/<c> module=<m> | <scalar>=<v>   · dt get collections/<c> [--module <m>]"
          )
          console.error(
            "    dt add-field <c> … · dt set-field <c> … · dt rm-field <c> … · dt rename-field <c> --name <f> --to <g>"
          )
          console.error("    dt add|set|rm|rename modules/<id> …               · dt add|set|rm|rename ui-views/<id> …")
          console.error(
            "  the full mapping table is in UPDATING.md (0.18.0 → 0.19.0), and `dt help` has the current spellings."
          )
          process.exit(2)
        }
        if (cmd === "ensure") {
          console.error(
            '✖ unknown verb "ensure" — gone since 0.22.0 (decision 309: install is the one verb that makes a thing present and ready):'
          )
          console.error(
            "    dt install                 this checkout — engine, .env, local assets, git modules, compile, postinstall"
          )
          console.error("    dt install repos/<id>      materialize one attached repo · dt install repos --all")
          process.exit(2)
        }
        // The change verbs spell one way. `add · set · rm · rename` are the record verbs, so
        // `update-field`/`remove-field` were a second spelling for one action inside one
        // grammar — the field verbs now say `add-field · set-field · rm-field · rename-field`.
        if (cmd === "update-field" || cmd === "remove-field") {
          const to = cmd === "update-field" ? "set-field" : "rm-field"
          console.error(
            `✖ unknown verb "${cmd}" — gone since 0.22.0 (decision 309: a field verb spells its action the way the record verbs do):`
          )
          console.error(`    dt ${to} <collection> --name <field> …`)
          console.error("    the field verbs are: dt add-field · dt set-field · dt rm-field · dt rename-field")
          process.exit(2)
        }
        // `dt commands <ref>` and `dt list commands` were one word for two things — the read
        // verb and the system entity. `next` also says what it answers.
        if (cmd === "commands") {
          console.error(
            '✖ unknown verb "commands" — gone since 0.22.0 (decision 309: it collided with the `commands` ENTITY, which `dt list commands` reads):'
          )
          console.error(
            "    dt next <collection>[/<id>]   which bound commands apply to this record, and in which state"
          )
          console.error("    dt list commands              the command entities this workspace ships")
          process.exit(2)
        }
        if (VERB_PACKAGES[cmd]) {
          console.error(
            `✖ \`dt ${cmd}\` comes from an extension this workspace does not have — install it as a dependency:\n    npm i ${VERB_PACKAGES[cmd]}`
          )
          process.exit(2)
        }
        if (DOCKER_VERBS.has(cmd)) {
          console.error(
            `✖ \`dt ${cmd}\` is not a workspace verb — containers are managed by dt-docker:\n    npm i -g @dreamteamer/docker-workspaces\n    dt-docker ${cmd} container <name>`
          )
          process.exit(2)
        }
        console.error(`✖ unknown verb "${cmd}" — the verb comes first: dt <verb> [<target>]`)
        emit(USAGE, 2)
        process.exit(1)
    }
  } catch (e) {
    console.error(`✖ ${e.message}`)
    // ⚠ AND ON STDOUT UNDER `--hook`, because that is the whole reason the shim exists.
    // `bin/dt-hook.sh` fails onto stdout with a comment saying why: a hook's stdout is added to
    // the session's context and its stderr is nobody's problem. Every success path here already
    // prints to stdout; every FAILURE went to stderr alone, so a mis-wired hook, a bad payload, a
    // TTY invocation or a refusal was invisible to exactly the reader the shim was built for.
    if (process.argv.includes("--hook")) console.log(`✖ ${e.message}`)
    process.exit(1)
  }
}

/** Each installed extension's usage block, headed by its package — '' outside a workspace. */
function extensionUsage(ws: Workspace | null) {
  const blocks = (ws?.extensions ?? [])
    .filter(e => Object.keys(e.commands).length)
    .map(
      e =>
        `\n${e.name}@${e.version}:\n${Object.entries(e.commands)
          .map(([verb, c]) => (c.usage ?? `  ${verb}`).replace(/\s+$/, ""))
          .join("\n")}`
    )
  return blocks.length ? `\ninstalled extensions:${blocks.join("\n")}` : ""
}

/** Translate `dt <verb> <target> …` into the noun-verb call the implementation layer takes. */
function dispatchRecordVerb(ws: Workspace, verb: string, args: string[]): number {
  const [target, ...rest] = args
  if (!target) throw new Error(`dt ${verb} needs a target — see \`dreamteamer help\``)
  // A flag in the target slot is a word-order mistake, not a collection: without this,
  // `dt list --json contacts` reported `unknown collection "--json"` and dumped every name.
  if (target.startsWith("--"))
    throw new Error(`dt ${verb} takes its target BEFORE the flags: dreamteamer ${verb} <target> ${target} …`)
  // A collection may be named by its declared name OR its singular (`dt add task …`); the
  // canonical name is what every layer below sees. An unknown word passes through unchanged so
  // the store's own "unknown collection" sentence, which lists what exists, is the one printed.
  const { descriptors } = new Store(ws)
  const canonical = canonicalCollection(descriptors, target) ?? target
  if (COLLECTION_VERBS.has(verb)) return targetCommand(ws, canonical, verb, rest)
  if (REF_VERBS.has(verb)) {
    const { collection, id } = splitRef(descriptors, target)
    return targetCommand(ws, collection, verb, [id, ...rest])
  }
  // the verbs that take EITHER (`reorder`, `next`) from here: a bare collection is legal for both — `move <collection> --init`,
  // `next <collection>`.
  if (descriptors.has(canonical)) {
    return verb === "reorder"
      ? targetCommand(ws, canonical, "reorder", rest)
      : targetCommand(ws, "commands", "for", [canonical, ...rest])
  }
  const { collection, id } = splitRef(descriptors, target)
  if (verb === "reorder") return targetCommand(ws, collection, "reorder", [id, ...rest])
  // `commands for <c>/<id>` split its own target at the FIRST slash, which cannot name a
  // namespaced collection. splitRef can, so the id is handed over as `--ids` — the same
  // `commandsFor(store, collection, ids)` call, reached without re-encoding the reference.
  // An explicit `--ids` from the caller still wins — by NOT injecting ours, not by ordering. It
  // used to rely on "last flag parsed wins", which stopped being true when a repeated flag started
  // promoting to an array instead of overwriting: the pair would now be refused as a double.
  const ours = rest.some(a => a === "--ids" || a.startsWith("--ids=")) ? [] : ["--ids", id]
  return targetCommand(ws, "commands", "for", [collection, ...ours, ...rest])
}

function watchAndRecompile(ws: Workspace): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const trigger = (_: unknown, file: string | Buffer | null): void => {
    if (file && /^\./.test(String(file))) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        compile(ws)
      } catch (e) {
        console.error(`✖ ${e.message}`)
      }
    }, 200)
  }
  // 'system' plus the flat kinds: the classic layout can put sources at the workspace root under
  // either spelling, and a watcher that misses one makes --watch quietly stop recompiling.
  for (const dir of ["system", ...kindsOf(ws), "modules", "git_modules"].map(d => path.join(ws.root, d))) {
    if (fs.existsSync(dir)) fs.watch(dir, { recursive: true }, trigger)
  }
}
