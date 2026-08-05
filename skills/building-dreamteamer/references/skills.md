# skills

A folder-shape record: `modules/<module>/skills/<name>/SKILL.md`. The folder name IS the id,
and extra files (references, scripts, assets) travel with the folder.

## create — and don't

**Create:** a technique that wasn't obvious, will recur, and applies beyond one record.
**Don't:** one-off fixes (just do them), workspace conventions (`CLAUDE.md`), or anything a
validator can enforce mechanically — automate that instead and save prose for judgment calls.

## the description is a TRIGGER, never a summary

The description is what a session scans to decide whether to load the skill. It must state **when to
use it** — symptoms, situations, verbs — and must NOT summarize the workflow: a description that
summarizes the process becomes a shortcut the agent follows *instead of reading the skill*, silently
skipping the steps the summary dropped.

```yaml
# ✖ workflow summary — the agent may follow this and never read the body
description: transcribes audio via whisper then fills the speaker map then commits
# ✔ trigger only
description: use when a meeting recording or pasted transcript needs to land in its meeting record
```

Third person, lead with "use when", pack in searchable keywords (error strings, symptoms, synonyms,
tool names). Name = verb-first gerund (`writing-x`, `detecting-y`).

## body craft

- **Lean.** Aim under ~500 words in `SKILL.md`; concrete over complete — what to read first, the
  exact shape to produce, the runnable commands. Cross-reference sibling skills instead of repeating
  them.
- **Progressive disclosure for anything larger.** Keep `SKILL.md` as the digest — routing plus the
  rules that apply everywhere — and put per-topic detail in `references/<topic>.md` that the digest
  points at by name. A session then pays for the map, not the whole territory. `building-dreamteamer`
  and `using-dreamteamer` are both built this way.
- **One excellent example** beats many mediocre ones; real, adapted from a live workspace.
- **Discipline skills** (rules under pressure) must close loopholes explicitly: name the workarounds
  and forbid them, add a rationalization table ("excuse → reality") and a red-flags list. A rule
  without its loopholes named will be rationalized around.
- Flowcharts only for genuinely non-obvious decisions; tables for reference.
- **Write down the traps.** The most valuable line in most of these skills is a measured failure
  mode — a limit, a silent-success bug, a stale-config symptom — because it transfers perfectly and
  cost someone a day to find. Include the measurement; drop the identities around it.

## no personal or account data

Skills ship with modules and are read by any operator — never bake in secrets, keys, names, emails
or account-specific paths. Per-install values go through `.env` (gitignored); the skill names the
variable it reads and what happens when it is missing.

## heavy assets

Models, caches and venvs live in dot-prefixed subfolders (`.models/`, `.cache/`, `.venv/`) with a
**skill-local `.gitignore`**. Compile skips dot-prefixed names, and local ignore rules travel with
the folder through extraction.

⚠ **Runnable assets must be referenced at their SOURCE path**, not under `.claude/skills/…` — that
is generated output, wiped and rebuilt every compile, and anything with local dependencies
(a `package.json`, a venv) only works where it was installed. Note the cost: a source path embeds
the module name, so renaming a module means updating every skill that names its own scripts.

## verify before calling it done

Compile, check, and — for any skill whose misreading would cost real work — **dispatch a
fresh-context subagent with a realistic task** and watch whether it finds, loads and follows the
skill correctly. What it gets wrong is what the skill still fails to say; fix and re-run. Reading
your own skill proves nothing.

**The reference bar:** the superpowers plugin skillset. Study a few of its skills before writing
one — its structure (overview / when-to-use with symptoms / quick reference / common mistakes), its
discipline patterns and its lean prose are the standard dreamteamer skills are held to.
