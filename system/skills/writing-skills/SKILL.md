---
name: writing-skills
description: use when creating or editing a skill record — a reusable technique, workflow, or reference agents load on demand (folder-shape record, SKILL.md entry)
---

# writing skills

a skill is a folder-shape record: `modules/<module>/system/skills/<name>/SKILL.md` — the
workspace's own go in the workspace module (`modules/hq3/system/skills/…` here), never a root
`system/` (compile error) and never under `.dreamteamer/` (compiled output). the folder name IS
the id; extra files (references, scripts) travel with the folder.

## when to create — and not

create: a technique that wasn't obvious, will recur, and applies beyond one record.
don't create: one-off fixes (just do them), workspace conventions (CLAUDE.md), anything a
validator can enforce mechanically (automate it instead — save prose for judgment calls).

## the description is a TRIGGER, never a summary

the description is what a session scans to decide whether to load the skill. it must state
**when to use it** — symptoms, situations, verbs — and must NOT summarize the skill's
workflow: a description that summarizes the process becomes a shortcut the agent follows
*instead of reading the skill*, silently skipping the steps the summary dropped.

```yaml
# ✖ workflow summary — the agent may follow this and never read the body
description: transcribes audio via whisper then fills the speaker map then commits
# ✔ trigger only
description: use when a meeting recording or pasted transcript needs to land in its meeting record
```

third person, lead with "use when", pack in searchable keywords (error strings, symptoms,
synonyms, tool names). name = verb-first gerund (`writing-x`, `detecting-y`).

## body craft

- lean: aim under ~500 words; concrete over complete — what to read first, the exact shape
  to produce, the runnable commands. cross-reference sibling skills instead of repeating them.
- **one excellent example** beats many mediocre ones; real, adapted from this workspace.
- discipline skills (rules under pressure) must close loopholes explicitly: name the
  workarounds and forbid them, add a rationalization table ("excuse → reality") and a
  red-flags list. a rule without its loopholes named will be rationalized around.
- flowcharts only for genuinely non-obvious decisions; tables for reference.

## no personal or account data

skills ship with modules and are read by any operator — never bake in secrets, keys, or
account-specific paths. per-install values go through `.env` (gitignored); the skill names
the variable it reads.

## heavy assets

models/caches/venvs live in dot-prefixed subfolders (`.models/`, `.cache/`, `.venv/`) with a
**skill-local `.gitignore`** (see `transcribe-recordings` for the pattern). compile skips
dot-prefixed names, and local ignore rules travel with the folder through extraction.

## verify before calling it done

run `npm run compile` (the skill isn't live until then), `npm run check`, and — for any skill
whose misreading would cost real work — dispatch a fresh-context subagent with a realistic
task and watch whether it finds, loads, and follows the skill correctly. what it gets wrong
is what the skill still fails to say; fix and re-run. reading your own skill proves nothing.

**the reference bar:** the superpowers plugin skillset (claude-code plugin) — study a few of its skills before writing one; its structure (overview / when-to-use with symptoms / quick reference / common mistakes), discipline patterns (rationalization tables, red-flag lists, hard gates) and lean prose are the standard dreamteamer skills are held to (decision #20).
