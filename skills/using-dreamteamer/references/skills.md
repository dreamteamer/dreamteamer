# skills — knowledge that finds its moment

A folder-shape record: `modules/<module>/skills/<name>/SKILL.md`. The folder name IS the id, and
extra files (references, scripts, assets) travel with the folder.

A skill has three readers, and the author is the least important one. You — usually an agent
writing down something just learned — write it once. The **finding reader** is a future session
scanning one line to decide whether to load it, usually while already mid-problem. The **following
reader** is that same session two minutes later, attention split between the skill and the task,
taking every sentence literally. Every craft rule below serves one of those two, and when a rule
seems fussy, ask which reader it protects.

| the question | read |
|---|---|
| should this be a skill at all | when a skill exists |
| will anyone find it | discovery — the description |
| how big, how split | architecture |
| what shape should the guidance take | the form matches the failure |
| the writing itself | body craft |
| it ships to strangers | portability |
| shipping, testing, keeping it true | lifecycle |

## when a skill exists — and when it must not

**Create** when a technique wasn't intuitively obvious, will recur, and applies beyond one record.
The test is concrete: would a fresh session, facing this situation cold, do it wrong or slowly?
If yes, and the situation recurs, that gap is a skill. **And look first** (`before-you-build.md`):
the capability may already exist in an installed module under a name you didn't guess — a
duplicate beside it is worse than the gap.

**Don't create** for:

- **One-off fixes** — just do them. A narrative of how you solved something once is a story, not a
  skill; keep the *technique* if it generalizes, drop the episode.
- **Workspace conventions** — `CLAUDE.md` is loaded always and needs no trigger; a convention in a
  skill is a convention a session might not load.
- **Anything a validator can enforce** — automate it and save prose for judgment calls. A regex in
  `check` never gets skimmed past; a sentence does.
- **What the model already knows.** A skill restating general knowledge costs its index line in
  every session for nothing. Skills carry what is *local*: this workspace's conventions, this
  tool's measured traps, the limit someone paid a day to find.

## discovery — the description is a trigger, never a summary

How a skill is found differs by harness, and both routes run through the same line. claude-code
discovers skills natively — the harness reads each description and offers the skill when it
matches. Every other harness gets the descriptions compiled into the committed orientation block
(`AGENTS.md`, `GEMINI.md`, `.cursor/rules/…`) as a trigger index. Two consequences: the description
travels into committed files (one line, third person, nothing sensitive), and it is the **only**
thing any session sees before deciding to load.

So the description states **when to load** — symptoms, situations, verbs — and never what the skill
contains:

```yaml
# ✖ workflow summary — the agent may follow this line and never read the body,
#   silently skipping every step the summary dropped
description: transcribes audio via whisper then fills the speaker map then commits

# ✔ trigger only
description: use when a meeting recording or pasted transcript needs to land in its meeting record
```

The failure mode is measured, not theoretical: a description that summarizes the process becomes a
shortcut the agent takes *instead of reading the skill*. The body becomes documentation nobody
opens.

Pack the line with what a stuck session would actually search or think: **error strings, symptoms,
synonyms, tool names**. "Use when `compile` reports a name collision" finds its reader; "helps with
module issues" finds nobody. Name the skill verb-first (`writing-x`, `detecting-y`,
`ingesting-recordings`) — gerunds read as the action the session is trying to take.

## architecture — the digest and the territory

The economics: every consumer pays the full line count of what it loads, every time. A skill's
`SKILL.md` is the **map** — routing plus the rules that apply everywhere — and per-topic depth
lives in `references/<topic>.md`, loaded only when that topic is live. A session then pays for the
map, not the whole territory. `using-dreamteamer` is built this way, and this
file is itself an example: you loaded it because its routing table named it.

- Keep `SKILL.md` under ~500 words where you can; a digest that grows past that is usually holding
  a topic that wants its own reference.
- Give the digest a **routing table** (`the question | read`) so the split is navigable, not just
  smaller.
- The folder shape is the point: references, scripts and assets travel with the folder through
  compile and extraction.
- Two situations with two different *triggers* are two skills — a session searching for one should
  not have to load the other. Two aspects of one trigger are one skill with two references.

## the form matches the failure

Before writing, name the failure the future reader will actually have. The form that fixes one
failure type does nothing for another:

| the future reader's failure | skill type | the form that works |
|---|---|---|
| doesn't know the technique | technique | ordered steps, one excellent example, runnable commands |
| doesn't recognize the situation | pattern | recognition cues, when-NOT-to-apply, a counter-example |
| can't hold the syntax or limits | reference | tables, trap notes, and pointers at the live authority |
| knows the rule and skips it under pressure | discipline | the rule, its loopholes named and forbidden, an excuse→reality table, a red-flags list |

**Discipline skills** deserve the extra machinery because a rule without its loopholes named will
be rationalized around — under time pressure an agent negotiates with "don't X" and wins. Name the
workarounds ("don't keep it as reference", "don't adapt it while testing"), list the excuses beside
their realities, and give a red-flags list the reader can self-check against.

**The reverse trap:** prohibitions backfire on *shaping* problems. When the failure is output of
the wrong shape — a bloated prompt, a buried verdict — a list of don'ts measurably produces more of
the unwanted content, because each "don't" is something to negotiate with. State what the output
IS: its parts, in order. A recipe leaves nothing to negotiate.

## body craft

- **Lean and concrete over complete.** What to read first, the exact shape to produce, the
  runnable commands — real ones, copy-pasteable, not pseudo-syntax. Prose that explains *why*
  earns its place only where the why prevents a wrong turn.
- **One excellent example** beats many mediocre ones — adapted from a live workspace, identities
  swapped for a synthetic cast.
- **Tables for reference; flowcharts only for genuinely forking decisions.** A numbered list is not
  a flowchart's job.
- **Write down the traps, with the measurement.** The most valuable line in most skills is a
  measured failure mode — a limit, a silent-success bug, a stale-config symptom — because it
  transfers perfectly and cost someone a day to find. Keep the numbers, drop the identities.
- **Say what done looks like.** A skill that never states its end condition leaves the follower to
  decide when to stop, which is how half-applied procedures happen.
- **Point at authorities instead of copying them.** "Run `--help`", "read the descriptor" — prose
  drifts, the descriptor cannot (the digest's read-the-descriptor rule). Copy a fact into a skill only when the
  skill adds judgment to it.
- **Cross-reference sibling skills by name**, never restate them (the digest's never-duplicate rule: two copies drift).

## portability — a skill ships to strangers

Skills ship with modules and are read by any operator on any machine:

- **Never bake in secrets, keys, names, emails or account-specific paths.** Per-install values go
  through `.env` (gitignored); the skill names the variable it reads and what happens when it is
  missing.
- **Machine-specific paths are `${env:VAR}` templates**, resolved per machine — an absolute path is
  silently wrong everywhere else.
- **Heavy assets** (models, caches, venvs) live in dot-prefixed subfolders (`.models/`, `.cache/`,
  `.venv/`) with a **skill-local `.gitignore`** — compile skips dot-prefixed names, and local
  ignore rules travel with the folder through extraction.
- ⚠ **Runnable assets must be referenced at their SOURCE path**, never under `.claude/skills/…` —
  that is generated output, wiped and rebuilt every compile, and anything with local dependencies
  (a `package.json`, a venv) only works where it was installed. The cost is real and worth
  stating: a source path embeds the module name, so renaming a module means updating every skill
  that names its own scripts.

## lifecycle — shipping, testing, keeping it true

- **Compile makes it real; the next session makes it live.** A running session does not see the
  skill you just wrote. Say so.
- **Verify with a fresh context, not your own eyes.** For any skill whose misreading would cost
  real work, dispatch a fresh-context subagent with a realistic task and watch whether it finds,
  loads and follows the skill. What it gets wrong is what the skill still fails to say; fix and
  re-run. Reading your own skill proves nothing — you already know what you meant. Discipline
  skills get the harder version: a scenario with pressure in it (time, sunk cost), because that is
  when the rule will actually be tested.
- **Update when reality moves.** A stale skill is worse than none, because it is *trusted*: a
  renamed verb or a changed limit in a skill sends every future session down the old path
  confidently. When you catch a skill lying, fixing it is part of the task you are on, not a
  follow-up.
- **Retire what nothing loads.** A skill nobody uses still costs its line in every session's index.
  Fold it into a sibling or delete it; git keeps the text.

**The reference bar:** the superpowers plugin skillset. Study a few of its skills before writing
one — the structure (overview / when-to-use with symptoms / quick reference / common mistakes), the
discipline patterns, and the lean prose are the standard dreamteamer skills are held to.

## common mistakes

| mistake | reality |
|---|---|
| a description that summarizes the workflow | it becomes a shortcut — the body is never read and steps are silently skipped |
| a description without the reader's search terms | error strings, symptoms and synonyms are how a stuck session finds it |
| everything in one `SKILL.md` | every load pays for all of it — digest + references, routed by a table |
| a narrative of one debugging session | keep the technique, drop the episode |
| a skill for what `check` could enforce | automate it; prose is for judgment |
| copying a fact the descriptor already holds | prose drifts, the descriptor cannot — point at it |
| a discipline rule with no loopholes named | it will be rationalized around under pressure |
| don't-lists for output shape | prohibitions invite negotiation — state what the output IS |
| personal names, keys, or absolute paths in the body | skills ship to strangers; `.env` + `${env:VAR}` |
| scripts referenced under `.claude/skills/` | generated output — wiped next compile; use the source path |
| verified by reading it yourself | dispatch a fresh context with a real task; its mistakes are your gaps |
| telling the operator it works now | it works in their **next** session |
