# data modeling — from a requirement to a model that stays good

The user states a requirement — "track the clinic's visits", "stop losing lab results" — and is not
a data architect. This reference is what stands between that sentence and a model: it turns the
requirement into collections, fields and relations that are searchable, filterable, legible in any
surface, cheap to keep, and still right a year in. Method and judgment live here; mechanics (the
meta verbs, namespaces, `templates:`, registering an existing folder) live in `collections.md`.

It is long on purpose. It is the reference for the single highest-leverage act in a dreamteamer
workspace — a model outlives every skill and command written against it — and the reader is usually
an agent mid-conversation, which cannot go read a shelf of data-modeling books. Sections are
self-contained; when loaded for one question, read the part that answers it:

| the question | read |
|---|---|
| what kind of database is this, really | Part I |
| a new capability needs modeling | Part II (the interview), then Part XI (a worked example) |
| which module / namespace does it go in | Part III |
| is this a collection, a field, an enum, tags…? | Part IV–V |
| how do these two things point at each other | Part VI |
| will it be usable — lists, forms, pickers, views | Part VII |
| will it stay fast | Part VIII |
| the model exists and is wrong | Part IX (change it) and Part X (what "wrong" looks like) |

---

## Part I — first principles: what kind of database this is

### 1. Records are plain files, and the reader is a person, an agent, and git

A record is one file (`<id>.<suffix>.<ext>`), its fields are frontmatter, its prose is a markdown
body, and the whole store is a git repository. There is no query planner between the reader and the
data — the primary read paths are `cat`, `grep`, `git show`, `git log -p`, and the engine's own
one-pass filters. **Every modeling choice should be tested against those readers**, because they are
what the model is FOR:

- A record must be understandable **alone**, with no schema open beside it. This is why references
  are fully qualified (`health/doctors/dana-levi`, never a bare `dana-levi`): the prefix is a type
  annotation that survives `grep`, a hand-edit, and a `git show` five years later. A DB row is never
  read without its schema; a record is designed to be.
- A record's **diff must mean something**. One logical change should touch few lines in few files,
  because `git log -p` on a record is its audit trail and a noisy diff destroys it.
- A record's **name must sort and file itself**. Ids are paths; a time-prefixed id
  (`2026/07/2026-07-02--intake--dana-levi`) makes `ls` a timeline and keeps any one folder small.

When two designs are otherwise equal, pick the one that reads better in a terminal. That single
tie-breaker decides more below than any other principle — it is why the far side of a relation is
materialised into the file instead of resolved at query time, why enums beat magic numbers, why
descriptions are load-bearing, and why a body is markdown rather than a `content` field of escaped
text.

### 2. The schema serves questions, not data

A model is not a mirror of the domain; it is a machine for answering the questions the workspace
will actually ask. "What is a visit?" is philosophy; "which visits this month have no follow-up
booked?" is a filter — and only the second tells you what the fields are. So every collection is
designed backwards from its questions:

- A question asked by **filtering or sorting** needs a **field**.
- A question asked by **reading one record** is answered by the **body**.
- A question **never asked** is a `description:` on something else, or nothing.

Write the collection's defining question into its `description`. When you cannot name the question,
you have not found a collection — you have found a pile, and a pile is fine as a folder; it does not
need a schema.

### 3. Denormalized on purpose — and exactly two licenses to copy

Classic normalization exists to make writes safe on a system where reads can join. Here reads
cannot join (filters resolve **one hop, outbound only** — see Part VI), the write rate is human-and-
agent scale, and git makes every copy auditable. So the model leans denormalized: a record should
answer its own questions without a join. But "denormalized" licenses exactly two kinds of copy, and
nothing else:

1. **A generated mirror** — the far side of a relation. The engine writes it, maintains it in the
   same write as every change to the owning side, refuses direct writes to it, and `check` reports
   one that has fallen behind — a hand-edited mirror included, since a literal file edit cannot be
   refused, only caught. Cost-free to keep; declare it freely (Part VI).
2. **A denormalized key** — one scalar (almost always a date) copied from a related record so a
   list sorts or an id generates without a join. Manual, so it MUST carry its maintenance contract:
   the field's `description` names the **source** and the **writer** ("denormalized from
   `visit.date` by the intake command"), or it will rot silently.

Everything else — copying a parent's fields onto children, restating a body, duplicating a
vocabulary across collections — is not denormalization, it is a second copy with no keeper. The
test: **who updates this when the source changes, and how would anyone notice if they didn't?** No
answer, no copy.

### 4. Object-oriented in the composition sense

The useful half of object orientation maps cleanly onto a workspace; the inheritance half does not.

| OO idea | its shape here | its non-shape |
|---|---|---|
| an object owns its state | a record owns its fields; the collection is the class | fields about X scattered on Y "for convenience" |
| methods | **command-bindings**: verbs bound to a collection, gated on field state (`can-enter`/`can-exit`) — `dt commands <ref>` lists what applies to a record right now | a workflow engine; procedures copied into descriptions |
| interfaces / mixins | **`templates:`** — a shared field set stamped onto consumers, merged at compile | copy-pasting the same four fields into six descriptors |
| encapsulation | **module ownership** — a concept's fields live with the module that owns the concept | the module that happened to need the field first |
| polymorphism | a **union reference** (`x-reference: [meetings, visits]`) or the open-world `'*'` for evidence/source fields | a `type` field plus fields that only apply to some rows |
| subclassing | **don't.** Two collections + a shared template, or one collection + an enum — decided by the triage test below | `extends:` as taxonomy — it exists for workspace overlays, not for "is-a" |

**The triage test, for "is this one collection with a `kind`, or two collections":** do the members
get triaged on the same questions, by the same person, in the same pass? A lead being sold and a
client being delivered are the same record at two funnel stages — one shape, two collections,
because the *questions* differ ("which should I chase" vs "which is at risk") even though the
fields barely do; a shared template carries the common fields. Conversely, prescriptions for
tablets and for physiotherapy are one collection with a `kind`, because every one gets the same
review. A `kind` enum whose values route to different reviews, different states, or different
required fields is two collections wearing one name — split it.

### 5. The surface is downstream of the descriptor

The engine names no component, no route, no pixel. It projects each descriptor into a presentation
contract — types, specials, options — and any surface that honours the contract renders any model
this method produces (the full table is Part VII §29). The consequence for modeling: **you design
the UI by choosing field shapes, not by asking for widgets.** "I want a dropdown" is not a request
to a UI team; it is `enum:` — or better, nothing, because a low-cardinality free string already
becomes a dropdown through `dt values`. "I want chips" is an array. "I want a page" is `x-body`.
When the rendering is wrong, the fix is almost always in the descriptor, and a fix in the
descriptor fixes every surface at once.

---

## Part II — the method

### 6. The interview — twelve questions, asked of the requirement

Answer from the requirement first; put a question to the user only where the requirement is silent
and the answers genuinely diverge. Most requirements answer eight of the twelve unprompted.

1. **Nouns.** Every noun the user would *open, list, or point at* is a collection candidate; a noun
   that only ever appears inside another is a field or a nested object. *A clinic: `visits` is a
   collection; the vitals taken at a visit nest on the visit — until someone asks "blood pressure
   over time", at which point `lab-values` becomes a collection with one value per record, because
   a nested object cannot be filtered across records (Part V §19).*
2. **The question.** Name the question each collection exists to answer and write it into
   `description`. The **grain** — what one record IS — is the largest unit that answers the
   question without unpacking (Part IV §13).
3. **One record.** What is its identity? `id.generate` builds it from creation-time values the
   record OWNS — the domain's own date, never `created` (a back-dated import would file a June
   visit under November); a `YYYY/MM/` prefix when growth is unbounded, and `id.pattern` must then
   admit `/`. And which field says two records are the *same* thing — that is what `x-unique` is
   for, on the reference that must not be claimed twice.
4. **Lifecycle.** What states, what moves a record between them, and what "done" is. `status` is
   the field a board groups by and a command-binding gates on. End of life is a **state**
   (`archived`, `dropped`), not `rm` — `rm` refuses while anything points at the record, and a
   deleted record takes its history's legibility with it.
5. **Stable vs volatile.** A thing and the churning activity about it are two collections
   (`patients` and `visits`; `products` and `issues`). A new *version* of the same thing is **git
   history, never a second record** — one dossier per patient, superseded text visible in
   `git log`, not `dossier-v2`.
6. **Who points at whom, from which side.** The foreign key lives on the many side; scalar or
   array follows cardinality; the far side is one generated keyword away, never a hand-maintained
   field. Declare the inverse when "which X have no Y" will be asked; skip it when only "this Y's
   X" will (Part VI §25).
7. **The forcing field.** One required field whose absence makes the record write-only: `evidence`
   on a defect, `done_when` on a goal, `dose` on a prescription. It is the difference between a
   record and a wish. A collection with no conceivable forcing field is a list — model it as one
   (a `tags` array, a body bullet) and say so in the proposal.
8. **Units and time.** A number without its unit is a latent bug: `amount` + `currency`, `value` +
   `unit`, or the unit in the name (`duration_min`). An instant is `date-time` with its offset; a
   day is `date`; never store an instant in a day field because "it sorts fine today". One
   operator over git: **ownership and permissions are not modelled** — invent no `owner`,
   `created_by`, `assignee` unless multiple humans genuinely write the workspace, and even then
   model the *people* first.
9. **Volume and write rate.** Roughly how many records in a year, and what writes them — a human
   occasionally, a command per event, a sync every fifteen minutes? Ten records need no id prefix
   and no namespace; ten thousand machine-written records need a time-sharded id, a lean
   frontmatter, and a hard look at every inverse that would concentrate writes into one hot file
   (Part VIII §36).
10. **The list.** What columns would the user scan — which four to six fields identify, order, and
    triage a record at a glance? That is `list_fields`, and if you cannot fill it, the fields are
    wrong (Part VII §30).
11. **The module.** Which module owns the *concept* (Part III §8)? In the first hour the answer is
    "the workspace module" and that is correct; the question still gets asked, because the answer
    decides where a later extraction cuts.
12. **What is deliberately NOT modelled.** Every requirement contains entities you should refuse —
    the one-off, the derivable, the thing git already records, the report that is a filter over an
    existing collection. Naming them in the proposal is what makes the model's boundary a decision
    instead of an accident.

### 7. The proposal — the output contract

The interview's output is **not prose**. Show, before anything is written:

1. The **descriptor YAML** per collection, complete — YAML in the proposal cannot drift from what
   gets written.
2. **One sample record each**, as the `dt add` command that creates it, run for real or shown
   verbatim. Seeding one real record before declaring the schema catches half the field mistakes —
   the missing unit, the enum value the domain actually spells differently, the id that comes out
   wrong.
3. The **`dt schema` commands** (or the hand-written descriptor when the collection is
   module-owned or carries comments worth keeping).
4. The **"deliberately not modelled"** list, each with its one-line reason.
5. For each relation: which side owns, whether an inverse is declared, and the answer to "which X
   have no Y" that justifies it.

Then stop. The operator decides what enters their workspace (`before-you-build.md`). After a yes:
write, `compile`, `check`, seed the sample, and only then build the skills and commands that write
the collection — behaviour follows shape.

---

## Part III — architecture: modules, namespaces, boundaries

### 8. What makes a module

A module is the unit of **concept ownership**, and its acceptance test is mechanical: **it compiles
alone in a bare workspace.** Everything else follows from that.

- **A field or collection belongs to the module that owns the CONCEPT, not the module that happens
  to need it first.** A company's LinkedIn page is generic CRM and belongs with the CRM
  collections; a field encoding one workspace's enrichment convention belongs in that workspace's
  own module as an overlay. Asking "who owns the concept" per field is what keeps a later
  extraction a `git mv` instead of a surgery.
- **Self-containment is structural, not aspirational.** No `templates:` and no `extends:` may
  reach into a sibling module — a shared field set is duplicated per module under a scoped name
  (`crm-provenance`, `rnd-provenance`) precisely so each module stays copyable. This is the single
  most expensive boundary mistake known: a module whose descriptors referenced a template living in
  the *consuming* workspace could not compile anywhere else, and nothing said so until someone
  tried.
- **A cross-module relation is a declared dependency.** An inverse stamps a generated field onto
  another module's collection, so compile refuses it unless the declaring module lists the
  target's module in its dependencies — a module may not grow fields on a stranger silently. (The
  workspace module is exempt; it overlays everything by design.)
- **Start in the workspace module; extract on the second consumer, not the first hunch.** The meta
  verbs write the workspace module, and that is the right first home for everything. A module is
  worth extracting when its collections form a closed reference graph, when a second workspace
  wants it, or when its vocabulary has stabilised — not before. Premature extraction buys a
  boundary you will immediately need to breach.
- **A module ships behaviour with its shape.** The skills that write a collection, the commands
  bound to it, and its default views belong in the same module as the descriptor. A collection in
  one module written only by a skill in another is a hidden dependency.
- **Module-shipped entities must not name a person, an account, or a machine path.** Per-install
  values come from `.env` via declared vars; who-did-what lives in a collection the workspace owns.
  A hard-coded `contacts/<someone>` resolves in exactly one workspace on earth.

### 9. Namespaces — one prefix per module, and the empty one

A namespace is a folder-shaped prefix on collection names (`health/doctors` →
`data/health/doctors/`, referenced as `health/doctors/dana-levi`). Use one namespace per domain
module, and give the *commons* — the collections everything else points at — the **empty** prefix,
so the things used daily are spelled shortest (`contacts`, `tasks`, `meetings`). Rules that keep it
sane:

- **`ns == module`.** A namespace that spans modules, or a module that scatters across namespaces,
  makes "who owns this" a lookup instead of a glance.
- A collection drops its module prefix from its bare name **iff** the prefix equals the namespace
  (`health-visits` → `health/visits`); a prefix that names the *subject* rather than the box stays
  in the name (`meeting-summaries` keeps `meeting-` even in the commons — it is about meetings, not
  owned by a "meeting" namespace).
- Declare the namespace before the first collection compiles — an id is also a slash path, so an
  undeclared prefix is ambiguous and compile refuses it rather than guessing.
- Namespacing an existing collection later is `dt schema rename-collection <old> --namespace <ns>`
  — one commit, every inbound reference rewritten, safe at any point. Cheapest early, though: the
  rewrite is O(records × files), measured at ~3 minutes for a 2,291-record collection — tolerable
  for a one-time migration, not free. So do not agonise up front; just decide sooner rather than
  at ten thousand records.

### 10. Templates vs extends vs copy

Three ways to share shape, in strictly descending order of preference:

| mechanism | what it is | use when | never for |
|---|---|---|---|
| `templates:` | a live shared field set, merged at every compile; precedence template < base < overlay | the same field group on several collections in ONE module — provenance quads, funnel fields, address blocks | reaching across modules |
| `extends:` | a workspace/overlay descriptor adding fields to another module's collection | a workspace tightening or extending a module it installed | taxonomy ("a lead is-a engagement"); removing inherited fields (impossible by design) |
| copy | duplicating fields into a second descriptor | crossing a module boundary (each side owns its copy, scoped name), or when two shapes are about to diverge | "saving time" inside one module — that is `templates:` |

The instinct to resist is building a type hierarchy. When two collections share most fields, the
model wants a shared **template** plus two thin descriptors — or a reference between them — never a
base collection that exists only to be extended. An abstraction with one concrete consumer is a
roadmap, not a model; wait for the second consumer.

### 11. Where records live: `data/`, codecs, shapes

- **`data/` is where records go.** `storage.path` is free-form, so a collection can be pointed
  anywhere in the workspace, but the answer is `data/<collection>` unless you have a reason you can
  state.
- ⚠ **`state/` is DEPRECATED as a convention — do not spend a decision on it.** It was created as
  the home for "operational records": runs, triggers, registries, cursors. All seven of those
  collections were later measured unused and deleted, so its entire reason went with them. The
  mechanism still works end to end (a collection declaring `storage.path: state/<name>` writes,
  lists and checks correctly) and is kept for anyone who wants a second root — but nothing ships
  there, and `dt init` no longer creates the folder.
- **The need it was aimed at is real; records were the wrong answer.** When genuine operational data
  finally arrived — cached provider readings, thousands of append-only rows — it went to a
  gitignored `.cache/<thing>.jsonl`, and that was right: one record per reading would have been
  thousands of files nobody opens individually, churning git for nothing. So the rule is not "put
  machinery in `state/`", it is **do not model machinery as records at all**. In descending order:
  a field on a record that already exists · a line appended to a gitignored cache file · a real
  collection, if and only if you will genuinely list, filter and read the things one at a time.
- **`codec: md` whenever a human reads a body; `yaml` when nobody does.** A record that is all
  fields and no prose (a lab value, a transaction, a cursor) is `yaml` — the body would only ever
  be empty. `json` exists for tool-written records.
- **`codec: file` makes the record an opaque file** — an icon, a logo, an image the UI draws.
  Fields are derived (`ext`, `bytes`), writes go through `add --from <path>`, and `check` guards
  `max_bytes` (default 200 KB). A big binary is not a record: it lives outside the vault under a
  declared var, with an ordinary record carrying the `${env:...}` template that points at it.
- **`shape: folder` when a record is intrinsically several files** (a skill with references beside
  it). Rare; prefer one file until the record itself demands companions.
- **Machine-specific paths are templates, never absolute paths.** `${env:FILES_FOLDER}/…` is inert
  data rendered per machine by `dt resolve`; an absolute path in a record is wrong on every other
  machine, silently. **A files folder is named after the collection or field that indexes it, and
  the path below it is the record id** — `<FILES_FOLDER>/visit-recordings/<record id>.m4a` needs no
  lookup table, which is the point.

### 12. Graduating a module — strip the identity, keep the measurement

A module built inside one workspace accumulates that workspace's identity: names in examples, env
conventions, decision references. Making it reusable is mostly deletion. The rule for what
survives: **a measurement keeps its numbers and loses its source's name** ("a 4,000-record
workspace checks in half a second", not "workspace X does"). Verify the graduation the same way a
module is defined: compile it alone in a virgin workspace, with a synthetic cast in every example.

---

## Part IV — collections

### 13. Grain — what one record is

The grain is the single most consequential choice; everything else is adjustable later, the grain
only by rewriting every record. Choose the **largest unit that answers the collection's defining
question without unpacking** — and test it with the two-question drill:

> For each question the collection exists to answer: can a *filter* answer it, or does something
> have to open records and parse?

*The clinic's lab results.* "Show LDL over ten years" and "everyone's latest vitamin D" are the
questions. A panel-shaped record (one visit's bloods as a nested table) answers neither without
unpacking — so the grain is **one measured value**: one analyte, one patient, one date. The panel
is reconstructed by filtering patient+date; the timeline by patient+analyte. Twenty records where
one "document" would have been — and both questions are now one filter each. The reverse also
holds: a `visits` record is NOT split into one-record-per-symptom, because no question filters
across symptoms — they are read within one visit, so they stay inside it.

Grain heuristics:

- A record should be **claimable by one sentence**: "the LDL measured for Dana on 2026-07-02". If
  the sentence needs "and", the grain may be too coarse.
- If two questions need two grains, the finer grain wins and the coarser one becomes a filter —
  never model both (that is a copy with no keeper, §3).
- **Events are finer than you think; entities are coarser.** A payment, a measurement, a message
  is one record per occurrence. A person, a company, a product is one record per identity — with
  the churn pushed into an events collection beside it (§16).

### 14. Identity — ids that stay true

The id is the record's address in every reference, filename, and URL. It cannot be casually changed
(rename rewrites every inbound reference — supported, but a commit-sized event), so derive it from
what is true at creation and stays true:

- **Creation-time values the record owns.** The domain's own date plus a slug of the name is the
  workhorse: `{{ date | date }}--{{ name | slug }}`. Never write-time (`created`) for domain
  events, never a mutable field (a title that gets edited), never an external id that might be
  re-keyed.
- **A time prefix for unbounded growth**: `{{ date | date:YYYY/MM }}/…` shards the folder by
  month, keeps `ls` fast and scannable, and files the record where a human would look. The
  `id.pattern` must then admit `/`.
- **A subject prefix when the collection partitions by an anchor**: `<patient>/<date>--<analyte>`
  puts everything about one patient under one folder — right when the dominant access is "all of X
  for this person", wrong when it is time-global.
- **`id.pattern` must accept everything `id.generate` can produce.** Non-latin names slug to a
  deterministic short hash, so `[a-z0-9-]` holds; test with a real awkward title before shipping.
- **Sameness is a relation property, not an id property.** "One summary per meeting" is
  `x-unique: true` on the summary's `meeting` reference — enforced by `check`, naming both records
  on a collision — not a convention about ids that nothing enforces.

### 15. Lifecycle — states as data

A `status` enum is the collection's spine: the board groups by it, bindings gate on it, and "what
needs attention" is a filter over it. Design it deliberately:

- **States are observations, not aspirations.** Each value should be assignable by looking at the
  record and the world — `identified / first-contact / active-discussions / converted / dropped`
  can each be verified; `almost-done` cannot.
- **Separate axes stay separate fields.** Funnel stage and temperature ("is it moving right now"),
  readiness and whether-a-human-acted — collapsing two judgments into one enum makes both
  unreadable. Two enums, each honest, beat one that lies.
- **Terminal states, not deletion.** `archived`/`dropped` keep the record filterable and its
  inbound references valid. `rm` is for mistakes, not lifecycle — and it refuses while anything
  points at the record (`x-on-delete: restrict` is the default posture for exactly this reason).
- **The transition is a verb.** When moving between states has steps, that is a command bound to
  the collection with `can-enter`/`can-exit` gates on the fields — not a fatter enum, and not
  prose in the description hoping to be followed.
- **Never enum against data that already violates it.** Declaring `enum:` over a field whose
  records hold other values makes `check` fail on every one; clean first, then narrow (Part IX).

### 16. Stable vs volatile, singletons, documents vs entities

Three recurring shapes, each with a rule:

- **The thing / the activity about the thing.** `patients` (stable identity, edited in place) and
  `visits` (append-only events pointing at a patient). Mixing them — visit notes accumulating on
  the patient record — destroys both: the entity's diff becomes noise and the events lose their
  grain. The stable record carries only what is *currently true*; everything dated hangs off it.
- **The singleton-per-subject document.** One living dossier per patient, one page per engagement:
  enforce it with `x-unique` on the subject reference, edit in place, and let git hold every
  superseded version. The alternative — dated versions as records — is right only when versions
  are *compared* as data ("what changed between Q1 and Q2 reports"), which is rare.
- **Documents vs entities.** A brief, a report, an analysis is a *document*: its value is the
  body, its fields exist to file and find it (date, subject references, status). An entity's value
  is its fields. Do not force documents into entity shapes — a document collection with fifteen
  required fields will simply stop being written — and do not let an entity's facts hide in a
  body where no filter can reach them.

### 17. The forcing field

One required field whose absence makes the record pointless: `evidence` on a defect (a claim
without a repro is a rumour), `done_when` on a goal (a goal without a test is a mood), `dose` on a
prescription. It does the work review would: the writer must have the thing, not the intention.
Requiredness is for the forcing field and identity inputs — **not** for everything that is "nice
to have", because every extra `required` is a record that cannot be captured quickly and therefore
will not be captured at all. Capture-fast collections (inbox-like: raw ideas, unfiled notes) may
have *no* required field beyond a name — deliberately, stated in the description — and a digestion
step downstream.

### 18. Descriptions and `use_when` — the model is also the prompt

In an agent-operated workspace, descriptor prose is not documentation; it is **retrieval surface**.
Collection descriptions are compiled into the orientation block every session loads, and field
descriptions are what an agent reads before writing a value. So:

- A collection's `description` carries the question it answers **and the neighbour it is NOT**:
  "the person, never the org — that is `companies`". Confusable pairs each point at the other.
- A field's `description` says what the value MEANS, names the source when the value is copied
  from elsewhere, and states the convention an agent must follow ("empty means unmatched — the
  matching command's queue").
- `use_when` is authored **only** when an agent that fully understood the description would still
  not reach for the collection — a search-here-first trigger, a write-here-when situation. It is
  prose; nothing fires on it; and a `use_when` restating the description costs every session
  tokens while diluting the few that carry real signal.
- Descriptions are the cheapest UX in the system: the same line is the tooltip in every surface,
  the agent's guidance, and the future maintainer's note. Budget a real sentence per field.

---

## Part V — fields

### 19. The ladder: collection · reference · enum · vocabulary · tags · nested — measured, not guessed

For every value, walk down until a rung holds. The measurements are two commands, not taste.

| the value… | model as | the measure |
|---|---|---|
| has fields of its own, a lifecycle, or is opened alone | a **collection**, pointed at with `x-reference` | — |
| is one of a small set the domain itself defines and closes | **`enum`** | `dt values <c> <f>` shows ≤ ~10 distinct values AND their counts sum to ≥ 80 % of the records — `values` reports distinct counts (never fill; compute fill against the record count), and echoes a declared enum verbatim without counts |
| is a vocabulary the workspace grows as it goes | **free string** — `dt values` derives the dropdown from the data, so a moving set needs no schema change and `check` never fails on a new value | the set is still moving, or predates any enum |
| is a loose label with no attributes | **`tags`** — an array of free strings. The moment labels read like `key:value`, that is a field wanting to exist: promote it | — |
| repeats inside one record and is never referenced from outside | **nested** `array` of `object`, with `x-title-template` on `items` so rows get a label | the costs are real: not filterable across records (a non-operator filter key means a reference hop, so a nested key narrows to nothing), skipped by `dt values`, unusable as a list column — the form and the body are its only readers |

Two hard "nevers": never declare an `enum` against records that already violate it (§15), and
never create a `tags` *collection* — a label with no attributes does not earn records, and the day
it grows attributes it becomes a real collection with a real name.

The promotion paths all run upward and are all cheap except the last: a free string becomes an
enum by declaration once the vocabulary settles; a tag becomes a field; a nested object becomes a
collection **only by a one-shot migration script**, which is why question 1 of the interview errs
toward collections whenever cross-record questions are conceivable.

### 20. Every field attribute, and what it does downstream

Property order matters: **it is the form order**, and the `x-body` field goes last.

| attribute | decide by | what it drives downstream |
|---|---|---|
| `type` + `format` | the JSON type; `date` vs `date-time` honestly (§21) | the control every surface picks: date / datetime widgets, toggle, number, textarea for `format: markdown` |
| `title` | authored only when title-casing the name reads wrong (`ui-views` → `UI Views`) | the label everywhere; no surface invents its own casing |
| `description` | §18 | tooltip + agent guidance |
| `required` | the forcing field and identity inputs, nothing else (§17) | the asterisk; a write missing it is refused before disk |
| `enum` | the ladder | a dropdown; `check` enforcement |
| `default` | what is true when unstated — not what is common | prefilled on create; also documents the neutral value |
| `x-reference` | Part VI | the record picker, labelled by the target's `title_template`; `check` and `rename` follow it |
| `x-inverse` / `x-inverse-of` / `x-unique` / `x-on-delete` | Part VI | the generated mirror; cardinality; delete behaviour |
| `x-body: true` | the ONE long prose field | the markdown body; rendered as the page, last |
| `x-title-template` (on `items` of nested arrays) | give repeating rows a human label | the row label in the list editor |
| `templates:` (collection level) | a field set shared within the module | identical rows across collections, maintained in one file |

What is deliberately absent: computed fields (a skill or command keeps a denormalized key, §3),
field-level permissions (one operator over git), validation beyond JSON Schema plus the `x-`
keywords (a rule the schema cannot express belongs in the writing command's gate, where it can
refuse with a sentence).

### 21. Time, money, measures

- **`date-time` for instants, `date` for days, never one in the other.** The engine compares
  date-times across offsets correctly; a day stored as midnight lies about precision and breaks
  "same day" filters across timezones.
- **Denormalized date keys are the sanctioned copy** (§3): a child record carrying the parent's
  date so lists sort and ids generate without a join — with the source and writer named in the
  description.
- **Money is `amount` + `currency`**, always, even when "it's all one currency today" — the first
  foreign invoice is not the moment to migrate. Same for measures: `value` + `unit`, or the unit
  in the field name (`duration_min`, `weight_kg`) when it is genuinely fixed.
- **Timestamps the engine already keeps are not fields.** `last-modified` is injected from git
  into every list; creation is derivable from history. Author a date field only when it carries
  *domain* time (the visit's date, not the record's).

### 22. Naming

Names are read hundreds of times per write; optimize for the reader:

- **Collections: plural, hyphenated, the word the user says** — `lab-values`, `visits`. The
  record suffix derives as the singular (`<id>.lab-value.md`). A collection is for what *recurs*;
  a one-off is a record in some existing collection, not a new box.
- **Fields: `snake_case`; a reference named for the target's singular** (`visit`, `doctor`), the
  mirror for the owner's plural (`visits`). Name the **role, not the instance**: `person`, not
  `staff-member`; `source_account`, not the bank's name.
- **No abbreviations the user does not say aloud.** `qty` saves three characters and costs every
  future reader a beat.
- **Confusable pairs get contrasting names AND contrasting descriptions** — `expense_transactions`
  vs `reimbursement_transactions`, each saying which it is not.
- **Rename early.** A wrong name compounds daily, and `rename-collection` rewrites every inbound
  reference in one commit. There is no field rename verb, so field renames cost a script — one
  more reason to spend a minute on the name now.

---

## Part VI — relations

### 23. The model: one owner, a generated mirror, declared from either side

A relation has exactly one **owning field** — the foreign key, on the many side — and optionally a
**generated mirror** on the far side. The engine writes the mirror into the compiled descriptor
(`readOnly`, with a hint naming the owner), maintains its values in the same write as every change
to the owner, **refuses direct writes to it** naming the field to set instead, and `check` reports
one fallen behind as stale with the repair command. You author one side; the other is kept.

Two source spellings, byte-identical once compiled — choose by where the sentence reads best:

```yaml
# A — on the owning side (the foreign key):
# collections/visits.collection.yaml
doctor: { type: string, x-reference: health/doctors, x-inverse: visits }

# B — on the far side, as an authored field that names whose mirror it is:
# collections/health/doctors.collection.yaml
visits:
  type: array
  x-inverse-of: visits.doctor        # <owner collection>.<owner field> — split at the LAST dot
  items: { type: string, x-reference: visits }
  description: Every visit this doctor has seen — generated; set `doctor` on the visit.
```

Spelling B's one real advantage: **the mirror keeps a hand-written `description`** in the file a
reader opens, where spelling A's generated mirror gets a mechanical one. In a workspace where
descriptions feed the agents' orientation block, that is reason enough to prefer B. B also
composes with shared templates: when the owning field comes from a `templates:` set used by
several collections, an `x-inverse` on the template would generate the same mirror name from each
consumer and collide — B declares each mirror on its own target, touching no shared file.

Cardinality closes from the shapes, and one-to-many is **never authored** — it is always the
mirror of a scalar:

| owning field | far side | kind |
|---|---|---|
| scalar `x-reference` | array mirror | many-to-one |
| scalar + `x-unique: true` | scalar mirror | one-to-one |
| array `x-reference` (+ inverse) | array mirror | many-to-many |

A **scalar spelling-B mirror closes backwards**: declaring the far side as a scalar means the
foreign key is one-to-one, and compile stamps `x-unique: true` onto the owner for you.

`x-on-delete` says what removing a *target* does to records pointing at it: `restrict` (default)
refuses the `rm` and names them; `set-null` clears the foreign keys — refused at compile when the
key is `required` or a list with a floor above one, because a delete must not manufacture invalid
records.

### 24. Choosing the shape — a decision table

| the relationship, in a sentence | model |
|---|---|
| each visit has one doctor; a doctor has many visits | scalar `doctor` on visits (+ inverse when §25 says yes) |
| each meeting has at most one summary, ever | scalar `meeting` on summaries + `x-unique` — sameness enforced, collisions named by `check` |
| an analysis covers several meetings; a meeting may be analysed repeatedly | array on the analysis (+ inverse) — many-to-many with no junction |
| the link itself has fields (a dosage, a role, a start date) | a **junction collection**: an ordinary collection with two references and the edge's own fields. Only when the edge genuinely carries data |
| the field may point at one of several collections | a union: `x-reference: [meetings, visits]` — the stored value's prefix disambiguates |
| evidence/source pointing anywhere | `x-reference: '*'` — open world, `check` verifies existence only, **no inverse possible** |
| an org's parent org | self-reference — legal, mirrors and all (`parent` → `subsidiaries`) |
| A and B reference each other with different meanings | two independent relations — never one field doing double duty |

### 25. Direction — when to declare the inverse, when to skip it

The inverse is cost-free to *maintain* (the engine keeps it) but not free to *have*: it is lines in
every target record, churn in the target's diff whenever an owner changes, and a write to the
target's file on every link change. Decide per relation:

**Declare it when:**
- "which X have no Y" will be asked — the empty mirror is the only thing that makes absence
  filterable (`--where '{"summary":{"_empty":true}}'`);
- the target record is *read* with its children in mind (a doctor's page should list the visits);
- a surface will show the far side as chips or a count.

**Skip it when:**
- only the outbound direction is ever asked ("this visit's doctor", never "doctors with no
  visits");
- **fan-in would swamp the record** — measure it before declaring:
  `dt list visits --where '{"doctor":{"_eq":"health/doctors/dana-levi"}}'` piped to a count. A
  mirror of 40 refs on a record with 12 lines of its own frontmatter has inverted the record's
  purpose; past a few hundred the file is majority-mirror and every reader pays for it;
- **the owning side is machine-written on every sync** — each sync write also touches the target,
  making it a hot file under concurrent sessions (Part VIII §36);
- the target is a `codec: file`, runtime-generated, or bodyless-`md` collection — compile refuses
  the mirror anyway, with the reason.

Leaving a reference one-way is not a compromise; for evidence fields, `'*'` fields, and
high-fan-in event streams it is the design.

### 26. Denormalized keys vs mirrors

Both put related information on this side of a hop; they answer different needs and do not
substitute:

| | generated mirror | denormalized key |
|---|---|---|
| holds | references to the far side | one scalar copied from the far side |
| maintained by | the engine, same write | whichever skill/command writes the record — named in the description |
| exists for | "which have none", chips, the far list | sorting and id generation without a join |
| staleness | `check` reports; `relations rebuild` repairs | rots silently unless the writer is disciplined |

The classic pairing on an event record: a reference to the parent **and** the parent's date as a
denormalized sort key — the reference for identity and filters, the date because a list of ten
thousand events cannot resolve ten thousand hops to sort. Copy *keys*, never *content*: the parent
body readable from the child is what the reference is for.

### 27. Integrity — what the machine holds, so the model can rely on it

Design against the enforcement that exists, not the enforcement you wish existed:

- `check` verifies: every reference resolves; mirrors agree with owners (else `stale`, naming
  `dreamteamer relations rebuild <collection>`); `x-unique` collisions (naming both claimants);
  enums, requireds, id patterns.
- The store maintains mirrors on `add`/`set`/`rm`/`revert`; refuses writes to mirrors; `rm`
  honours `x-on-delete`, detaches its own mirrors, and refuses on unmanaged inbound references.
- `dt commit <collection>/<id>` sweeps the TARGET-side partners the named record's own write
  dirtied — the mirrors its foreign-key change touched — so one logical change is one commit. A
  dirty **owner** on the far side is never swept, whoever wrote it: the commit refuses and names
  both records, so you scope the commit to the pair rather than publishing half of someone else's
  work — or half of your own.
- Schema ops clean up after themselves: dropping an inverse clears the generated values it
  orphans; removing a populated field clears its values, reporting the count, with the previous
  version in git.

What no machine holds: the discipline of a denormalized key (§26), the honesty of a status enum
(§15), and the grain (§13). Those live in descriptions and review.

---

## Part VII — UX: designing for the surface without naming one

### 28. The contract

The engine emits, per field, a presentation row — type, label, description, options, and `special`
markers; per collection — title, icon, order, list fields, per-record title template. A surface
renders the contract; the model *is* the UI design. This is what keeps the engine detached from
any particular extension while still letting a modeler decide how things will look.

### 29. Shape → projection — the full table

| descriptor shape | the engine emits | any surface shows |
|---|---|---|
| `x-body: true` | type `text`, special `dt-body`, edit `input-rich-text-md` | the record's page, rendered last |
| scalar `x-reference` | special `dt-relation-path` | a record picker, values labelled through the target's `title_template` |
| array `x-reference` | type `json`, specials `dt-relation-path`, `dt-relation-list` | a multi-picker; chips |
| generated mirror | `readonly: true`, `inverse_of`, the hint, special `dt-relation-mirror` | read-only chips + the hint; **never an editable control, the create form included** |
| `enum` | `edit_options.choices` | a dropdown |
| plain array of strings | type `json`, edit/view `tags` | chips |
| array of objects | type `json`, edit/view `list`, fields + `items.x-title-template` | a repeating-row editor |
| object with properties | type `json`, edit/view `nested` | a sub-form |
| `boolean` / `integer` / `number` | `boolean` / `integer` / `float` | toggle / number inputs |
| `format: date` / `date-time` | type `date` / `timestamp` | date / datetime controls |
| `format: markdown` (not the body) | type `text` | a textarea |
| `description` | `meta.description` | the tooltip |
| low-cardinality free string | *(no schema mark)* — `dt values` supplies the vocabulary | a dropdown of observed values, most-used first |

Three consequences worth designing with: a **mirror is knowable by its special**, so a surface can
disable the control with a reason instead of letting a write bounce; a **free string is already a
dropdown** wherever the surface asks `values`, so enums are for *closed* sets, not for getting a
picker; and everything here degrades to plain text gracefully, because the record is plain text —
the projection adds affordances, never meaning.

### 30. Lists — the record's row

`list_fields` is the model's answer to "what does a scanning human need": **four to six columns** —
the name, the sort key, the status, the relation you filter by. The engine injects `last-modified`
itself. More columns is not more information; it is a horizontal scrollbar. A field that would
usually be empty in a list, and any body or nested table, does not go in one. A ui-view's
`columns` **replaces** `list_fields` — and a column naming a field the schema lacks is dropped
silently, so check the descriptor's real names when writing views.

### 31. The record's face: `title_template`, icons, order

- `title_template` is how a record is labelled *everywhere it is referenced* — pickers, chips,
  lists, links. Authored once on the collection, inherited by every reference field pointing at
  it (a union inherits only when every member agrees). Compile derives one from
  `title`/`name`/`subject`; **a derivation to `{{ id }}` is a smell** meaning no name-like field
  exists — add one, because ids make terrible chips.
- `icon` (one material-symbols name) and `order` place the collection in any nav; the nav groups
  by owning module. These are cheap and worth setting — an unnamed generic glyph in a tree of
  twenty collections costs a glance every time.

### 32. Forms — property order is the design

The form is the schema, top to bottom. So: identity first (name, date, the references that file
the record), then state (status and its axes), then detail, then the body last — which
`templates:` respects by inserting shared fields before `x-body`. Progressive disclosure is
achieved by what you *don't* make a field (§2: read-once information belongs in the body) and by
defaults (a field with a good default is a field nobody has to touch). Required-field discipline
(§17) is form design: every asterisk is friction at capture time.

### 33. Views — when a `ui-view` earns existence

The default rendering — a table of `list_fields` over the whole collection — is itself an ordinary
default view; a named ui-view exists to be *different* from it. One earns its keep when it encodes
a recurring question (`/views/visits/unbilled`), a different layout genuinely fits the data
(kanban by `status`, calendar by a date field, map by a location), or a filtered slice is
someone's daily surface. A view that restates the fallback is a record to maintain for nothing.
Layouts come from the registered set (`table`, `cards`, `kanban`, `calendar`, `map`, plus
module-declared); filters are operator objects (`{status: {_eq: todo}}`), and a saved view is an
ordinary record — diffable, agent-writable, one per recurring question rather than one per mood.

### 34. Searchable and filterable — the model side of "find it"

- **Filters reach one hop outbound** — any field on the record, and through a reference to the
  target's fields (`{"doctor": {"specialty": {"_eq": "cardiology"}}}`), arrays with any-match
  semantics. They do not reach inbound (that is what mirrors are for) and never two hops (that is
  what denormalized keys are for). Model so every recurring question lands within one hop.
- The operator set is rich (`_eq`…`_between`, `_contains`, `_starts_with`, case-insensitive
  variants, `_empty`/`_nempty`, `_regex`, `_and`/`_or`) — but **an unknown key or a dangling
  reference narrows to nothing** rather than erroring, so a filter's field names deserve the same
  care as code.
- **Grep is the other search engine.** Qualified references make every relation greppable
  (`grep -r 'health/doctors/dana-levi'` finds every record pointing at her); prose wikilinks
  (`[[collection/id|label]]`) keep body mentions findable too. A model whose links are bare names
  has opted out of both.

---

## Part VIII — performance: what actually costs

### 35. The cost model

Reads walk files. To first order: **`get` resolves through the collection's id map** — built once
per process by walking the collection directory (readdir, no parsing), O(1) per hit after that —
so a cold `get` costs a directory walk, never a parse of every record; **`list`, `check`,
`values`, and any filter are O(records in the collection)** — every record parsed, one pass; a
one-hop filter adds resolution of the referenced records it actually touches. Writes are O(1)
files touched (the record, plus its relation partners), and a scoped commit is O(what changed).
Orders of magnitude, measured on a real workspace: ~4,000 records across ~70 collections **checks
in about half a second** and compiles in a third of one; a single paired write (both sides of a
relation maintained) lands in ~0.2 s; regenerating ~100 mirror values is ~0.2 s. The practical
meaning: at personal-workspace scale, **model for legibility first — the performance budget is
fat**. The shapes below are the ones that actually spend it.

### 36. Hot files and fan-in — the real concurrency cost

Git is the transaction log, and its unit is the file. Two writers touching *different* files merge
trivially; two writers touching the *same* file are a conflict, and the engine's own commits are
pathspec-scoped precisely to keep strangers out of each other's commits. The modeling
consequences:

- **A mirror concentrates writes.** Every link change on an owner also writes the target's file. A
  target with hundreds of inbound links, or owners written by a fifteen-minute sync, makes that
  one target file a contention point *and* a churn magnet in history. That is the §25 rule from
  the performance side: skip the inverse on machine-written high-fan-in relations, or hang a small
  stats record beside the anchor instead.
- **Event streams append; entities update.** An append-only collection (one new file per event)
  has no hot files at all — which is why the stable/volatile split (§16) is also the concurrency
  design.
- **Do not renumber.** Manual order uses a fractional index per moved record (`sort_field`, moved
  by `dt move <collection>/<id> --after|--before <id> | --top | --bottom`) because renumbering a
  list is a multi-file commit against git for no information.

### 37. Growth — sharding and splitting

- **Shard folders by time in the id** (`YYYY/MM/`) once a collection will outgrow a few hundred
  records — for the humans and the tooling both; a 10,000-entry directory helps nobody.
- **Split a collection when the questions split**, not when the count grows: an archive collection
  is almost always wrong (one more place to look, and filters on `status`/date already answer
  "active"). The exception is a *hot working set* pattern where a sync rewrites recent records
  constantly — then a stable/volatile split of the collection itself can be justified, and should
  be written up as such.
- **Frontmatter lean, body fat.** Every list and filter parses frontmatter; nothing scans bodies
  unless asked. A machine-written collection with 40 frontmatter fields pays 40 fields × N records
  on every list — push the read-once payload into the body or an attached file.

### 38. What not to optimize

No indexes to design, no query plans to hint, no caches to invalidate — do not invent them. A
"summary table" collection maintained beside the real one is a copy with no keeper (§3); a
mirrored count field is a denormalized key nobody asked for; a nightly "rebuild" script is a smell
that the model, not the machinery, is wrong. When something is actually slow, measure which pass
is slow (`time` the command) before modeling around it — the honest fixes are usually "shard the
folder", "lean the frontmatter", or "drop the unread inverse", in that order.

---

## Part IX — evolution: changing a model that already holds records

### 39. Additive first

Widening is always safe and needs no ceremony: a new optional field, a new enum value, a new
collection, a new inverse on an existing reference (declare it, then `relations rebuild` backfills
every mirror in one command — no script). Ship the widening, backfill opportunistically, narrow
later if ever.

### 40. Narrowing — clean, then declare

A new `required`, a tightened `enum`, a pattern change: `check` will flood on every pre-existing
violation, so the order is fixed — measure (`dt values`, a filter for the outliers), clean the
data, *then* narrow the schema. Narrowing first "to see what breaks" makes every later `check`
useless until the flood is drained.

### 41. Renames

- **Collections**: `dt schema rename-collection <old> <new>` — descriptor, records, filenames and
  every inbound reference in one commit. Safe, and cheapest early — the rewrite is
  O(records × files), measured ~3 minutes at ~2,300 records — so do it the day the name is wrong,
  not the year after.
- **Fields**: there is no rename verb, deliberately (a rename that rewrites every record is a
  migration, and pretending otherwise invites half-renames). The honest sequence: add the new
  field; a one-shot script moving the values (committed with the records it rewrote, the commit
  message being the ledger); `schema remove-field` the old one — which clears any leftovers and
  reports the count.
- **Values** (an id, a reference target): `dt rename <collection>/<old> <new>` rewrites inbound
  references; qualified prose wikilinks are followed, bare-name prose is not — one more reason
  references in bodies are written qualified.

### 42. Migrations are scripts, run once, committed with their effects

There is no migration framework — one shipped, went unused by every real schema change, and was
removed. A shape change across existing records is a one-shot script: written, run, verified with
`check`, committed together with the records it rewrote and a commit message saying what it did.
The message is the only ledger, so write it like one. Before any of it: does the change actually
need a migration, or is it additive (§39) plus a `relations rebuild`?

---

## Part X — anti-patterns: what wrong looks like

Each smell, with its fix. These are lint-shaped on purpose.

| smell | what it means | fix |
|---|---|---|
| a string field with ≤ 10 distinct values, ≥ 80 % fill, no enum | a vocabulary that has settled | declare the enum (after §40's cleaning) |
| a field at 0 % fill after fifty records | modelling an intention, not a practice | delete it, or find why writers skip it |
| an array whose values look like `<collection>/<id>` with no `x-reference` | a relation the machine cannot see | add `x-reference` — `check` and `rename` start working |
| `title_template` derived to `{{ id }}` | no name-like field | add one; ids make terrible chips |
| two collections sharing most fields, no reference between them | a hidden relation or a false split | reference, template, or merge — decided by the triage test (§4) |
| a `kind` enum whose members are triaged on different questions | two collections wearing one name | split |
| a scalar reference with fan-in > 1, no inverse, and a saved view asking "which have none" | the question exists, the mirror doesn't | declare the inverse |
| a body used as a list column | prose where a field belongs | extract the field the column actually wanted |
| a number with no unit beside it | a latent unit bug | `value` + `unit`, or the unit in the name |
| a nested object someone tries to filter on | grain too coarse (§13) | promote it to a collection |
| a `tags` value shaped `key:value` recurring | a field wanting to exist | promote it |
| a required field writers routinely fake (`unknown`, `-`) | requiredness as wish (§17) | make it optional and let emptiness be the signal |
| `status: almost-done` | aspiration in an enum (§15) | states you can observe |
| a second record that is "v2" of an existing one | versioning by copy | edit in place; git holds the old version |
| a collection nothing points at and no view lists | a model without questions (§2) | delete it, or find its question |
| an `owner`/`assignee` field in a single-operator workspace | imported enterprise reflex | delete; git already says who wrote what |
| a copied field with no source named in its description | a copy with no keeper (§3) | name source + writer, or drop the copy |
| an absolute machine path in a record | breaks on every other machine | a `${env:VAR}` template + a declared var |
| a "misc"/"notes" collection growing unrelated shapes | a pile wearing a schema | leave piles as capture collections *by design* (§17), and digest into real ones |

---

## Part XI — worked example: the clinic, end to end

The requirement, verbatim: *"track the clinic's visits and what gets prescribed, and stop losing
lab results."*

**The interview, compressed.** Nouns: patients, doctors, visits, prescriptions, lab results — five
candidates; "symptoms" appear only inside a visit, and nobody filters on them → body prose.
Questions: "what happened with this patient" (visits, by patient, newest first); "what is Dana
currently on" (prescriptions filtered by patient + status); "LDL over time" (lab-values by patient
+ analyte — the grain question, settled as one value per record). Identity: a visit is
`date + patient`; a lab value is `patient + date + analyte`, and its id leads with the patient
because the dominant access is per-person. Lifecycle: prescriptions are the only state-bearing
collection (`active / stopped / completed`); visits are events, done the moment they are written.
Stable/volatile: `patients` stable, everything else events pointing at it. Relations: all the
event collections point at `patients`; visits also at `health/doctors`; prescriptions at the
visit that issued them. Inverses: `patients.visits` yes ("patients not seen this year" is a real
question) — but **not** `patients.lab_values`: fan-in measured in the hundreds per patient would
drown the record, and the per-person question is already answered by the lab-values id prefix and
a filter. Forcing fields: `dose` on a prescription; `value` + `unit` on a lab value. Volume: tens
of visits a week — `YYYY/MM` sharding on visits and prescriptions, patient-prefix on lab-values,
none on patients. Module: `clinic`, namespace `health`, commons untouched.

**The proposal** (two of the five descriptors — the ones that carry the lessons):

```yaml
# modules/clinic/collections/health/lab-values.collection.yaml
name: health/lab-values
description: >-
  ONE measured value — one analyte, one patient, one date. The grain is deliberately a single
  value, because the questions are "LDL over time" and "everyone's latest vitamin D", and a
  panel-shaped record answers neither without unpacking. A panel is a filter on patient+date.
storage: { path: data/health/lab-values, codec: yaml, shape: file, suffix: lab-value }
id:
  generate: "{{ patient | basename }}/{{ date | date }}--{{ analyte | slug }}"
  pattern: "^[a-z0-9-]+/\\d{4}-\\d{2}-\\d{2}--[a-z0-9-]+$"
schema:
  type: object
  required: [patient, date, analyte, value, unit]
  properties:
    patient:
      type: string
      x-reference: health/patients
      description: Whose blood. First id segment, so one folder holds one person's history.
    date:
      type: string
      format: date
      description: The draw date — the lab's own, never the filing date.
    analyte:
      type: string
      description: >-
        What was measured, lowercase (ldl, hdl, vitamin-d) — a vocabulary, not an enum: labs keep
        inventing panels, and `dt values` is the dropdown.
    value:
      type: number
      description: The number alone — the unit is beside it, never inside it.
    unit:
      type: string
      description: mg/dL, mmol/L, % — from the lab report, verbatim.
    flag:
      type: string
      enum: [low, normal, high]
      description: The lab's own flag when printed; empty when the report shows none.
    source:
      type: string
      description: >-
        Where this value came from — a report file template or a visit reference — so a
        surprising number can be re-checked.
order: 33
list_fields: [patient, date, analyte, value, unit, flag]
icon: labs
```

```yaml
# modules/clinic/collections/health/prescriptions.collection.yaml   (the relation lessons)
name: health/prescriptions
description: >-
  One drug prescribed once — what, how much, and whether it is still running. "What is this
  patient currently on" is a filter (patient + status=active), which is why status is a field and
  not a sentence in the body.
storage: { path: data/health/prescriptions, codec: md, shape: file, suffix: prescription }
id:
  generate: "{{ date | date:YYYY/MM }}/{{ date | date }}--{{ patient | basename }}--{{ drug | slug }}"
  pattern: "^\\d{4}/\\d{2}/\\d{4}-\\d{2}-\\d{2}--[a-z0-9-]+--[a-z0-9-]+$"
schema:
  type: object
  required: [patient, drug, dose, date]
  properties:
    patient:
      type: string
      x-reference: health/patients
      description: Who takes it.
    visit:
      type: string
      x-reference: health/visits
      description: >-
        The visit that issued it — empty for a renewal issued between visits, which is itself the
        signal that a renewal happened outside a consult.
    drug:
      type: string
      description: Generic name, lowercase — a vocabulary.
    dose:
      type: string
      description: 'The forcing field: a prescription without a dose is a rumour. As written — "20mg once daily".'
    date:
      type: string
      format: date
      description: Issued when — also the id's filing date.
    status:
      type: string
      enum: [active, stopped, completed]
      default: active
      description: Observable states only — stopped is a decision, completed is the course run out.
    notes:
      type: string
      format: markdown
      x-body: true
      description: Why prescribed, reactions, the story — read within one record, never filtered.
order: 32
list_fields: [patient, drug, dose, status, date]
icon: pill
```

```yaml
# and on health/patients — the far sides, spelling B so each mirror documents itself. One
# prerequisite the snippet depends on: patients is `codec: md` and its descriptor declares an
# x-body field (its `notes`) — a bodyless-md collection cannot hold a mirror (§25's refusal).
    visits:
      type: array
      x-inverse-of: health/visits.patient
      items: { type: string, x-reference: health/visits }
      description: Every consult, generated — set `patient` on the visit. Empty means never seen.
    prescriptions:
      type: array
      x-inverse-of: health/prescriptions.patient
      items: { type: string, x-reference: health/prescriptions }
      description: Everything ever prescribed, generated. "Currently on" is this filtered to active.
```

**One sample record, seeded before declaring** — the step that catches the unit nobody mentioned:

```
dt add health/lab-values --patient health/patients/dana-levi --date 2026-07-02 --analyte ldl \
      --value 138 --unit mg/dL --flag high --source "health/visits/2026/07/2026-07-02--intake--dana-levi"
→ data/health/lab-values/dana-levi/2026-07-02--ldl.lab-value.yaml
```

**Deliberately not modelled:** appointments (the calendar owns scheduling; a visit is written when
it *happens*) · symptoms as fields (read within one visit — body prose) · a `patients.lab_values`
inverse (fan-in; the id prefix already files them per person) · a `doctors.patients` relation (it
is derivable through visits and would be a copy with no keeper) · invoices (a different module's
concept — declared out of scope rather than half-modelled).

Why this model holds up, checked against the parts: every recurring question is a one-hop filter
(I §2, VII §34) · the grains differ per collection and each was chosen by its question (IV §13) ·
the one risky inverse was measured and refused (VI §25) · every number carries its unit (V §21) ·
the statuses are observable (IV §15) · the module compiles alone and touches no commons (III §8).

---

## Appendix — the modeler's checklists

**Proposing (before writing anything):**

- [ ] every collection's `description` names its question and its confusable neighbour
- [ ] grain chosen per collection by the two-question drill, stated in the description when non-obvious
- [ ] ids from creation-time owned values; patterns admit what generate produces; time-sharded where unbounded
- [ ] each relation: owner side chosen, inverse declared-or-refused *with the reason*, on-delete stated
- [ ] forcing field per collection — or the collection declared a capture pile on purpose
- [ ] units beside every number; `date` vs `date-time` honest
- [ ] `list_fields` scannable at 4–6 columns; `title_template` never `{{ id }}`
- [ ] module ownership stated; no cross-module template/extends; namespace == module
- [ ] the deliberately-not-modelled list exists
- [ ] one sample record per collection, shown as its `dt add`

**Reviewing an existing model:** run the smells table (Part X) top to bottom; measure before
declaring (`dt values`, fan-in counts, fill rates); prefer the additive fix; and when a change
rewrites records, it is a one-shot script committed with its effects, whose commit message is the
ledger.
