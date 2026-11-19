// The text `dt help` prints (and the usage echoed on exit 2). Core verbs only — each installed
// extension's own usage block is appended at runtime by `cli.ts`. Tests read the verbs and flags
// documented here and hold the dispatch to them, so a verb or flag added in one place and not the
// other fails the suite.

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
  reorder collections/<c> …                 (refused since 0.49: the nav's order is nav.yaml — the
                                               sidebar's Move entries or a hand edit; display.nav.order
                                               compiles and moves no row)
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
              dreamteamer.dependencies names, and a module preset's members at the versions it pins
              (refusing, before npm writes anything, a package with no dreamteamer key, an engine
              floor this engine does not meet, a ring, and a version installed differently), pins
              exact versions, compiles, merges the shipped nav fragments into nav.yaml, runs the
              safe part of the module's setup and commits package.json, package-lock.json, nav.yaml
              and what setup wrote. Without a version: npm's latest. --from resolves names from a
              folder of tarballs (offline). Old nav settings with no nav.yaml refuse a package that
              ships a nav fragment until migrated; [--allow nav-reset] starts from the fragments.
              Setup flags as for \`setup\`: [--input <id>=<value>]… [--allow <kind>]… [--no-input];
              [--no-commit] [--json]
              Exit 0 done · 1 refused or failed (nothing half-written) · 2 usage · 3 input missing
  install     --clone <url> [name]            attach a git module to this workspace
  update      <name>[@<version>] | --engine   move ONE npm pin forward on purpose: to the latest
              release (or the named version), re-pinned exactly, closure-checked as install is,
              compiled, committed; a module preset moves its installed members to its new pins.
              A downgrade needs [--allow downgrade]; old nav settings with no nav.yaml refuse a
              module update until migrated, or [--allow nav-reset]; a development link is skipped
              and named; [--from <dir>] resolves from a folder of tarballs; [--no-commit]
  update      pull git_modules clones forward (ff-only on the lockfile ref), rebuild,
              then compile; [<name>] updates just one. dirty clones are skipped
  compile     materialize modules + workspace sources into .dreamteamer (+ harness adapters)
              [--watch] recompile on source changes
  check       validate every record against the compiled descriptors (report-only), then every
              installed extension's own checks. A reference this workspace's own records reach only
              through a record layer is a ⚠ line until its exports manifest lists it (a reader
              without that layer sees it dangle); a reference no root answers is external when the
              referring repo's manifest vouches for it. nav.yaml: a name that resolves to nothing or
              is listed twice is a ⚠ line, never a violation
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
  run         <module> [<script> [<arg>…]]   run a script a module declares (dreamteamer.scripts) by
              NAME, never by its path inside the package: on this node, at the workspace root, every
              argument after the script passed to it untouched, its exit code returned. The module is
              its package name or its id; modules/<id> and a git_modules clone shadow the installed
              package, as for extensions. Without a script: list the module's scripts.
              Exit: the script's · 1 no such module, script or file · 2 usage

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

extension verbs — an extension (a module that also ships code: its package.json declares
\`dreamteamer.extension\`) adds its own verbs, listed below when this workspace has any.
`
