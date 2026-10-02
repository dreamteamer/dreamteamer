# data modeling — from a requirement to a model that stays good

The user states a requirement — "track the clinic's visits", "stop losing lab results" — and is not
a data architect. This reference is what stands between that sentence and a model: it turns the
requirement into collections, fields and relations that are searchable, filterable, legible in any
surface, cheap to keep, and still right a year in. Method and judgment live here; mechanics (the
descriptor's keys, the system and field verbs, namespaces, mixins, registering an existing folder)
live in `collections.md`.

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
| methods | **command-bindings**: verbs bound to a collection, gated on field state (`available_when`/`done_when`) — `dt next <ref>` lists what applies to a record right now | a workflow engine; procedures copied into descriptions |
| interfaces / mixins | **`mixins`** — a shared field set merged into consumers at compile | copy-pasting the same four fields into six descriptors |
| encapsulation | **module ownership** — a concept's fields live with the module that owns the concept | the module that happened to need the field first |
| polymorphism | a **union reference** (`type: [meetings, visits]`) or the open-world `type: reference` for evidence/source fields | a `kind` field plus fields that only apply to some rows |
| subclassing | **don't.** Two collections + a shared mixin, or one collection + an enum — decided by the triage test below | `overlay: true` as taxonomy — it exists for adding fields to another module's collection, not for "is-a" |

**The triage test, for "is this one collection with a `kind`, or two collections":** do the members
get triaged on the same questions, by the same person, in the same pass? A lead being sold and a
client being delivered are the same record at two funnel stages — one shape, two collections,
because the *questions* differ ("which should I chase" vs "which is at risk") even though the
fields barely do; a shared mixin carries the common fields. Conversely, prescriptions for
tablets and for physiotherapy are one collection with a `kind`, because every one gets the same
review. A `kind` enum whose values route to different reviews, different states, or different
required fields is two collections wearing one name — split it.

### 5. The surface is downstream of the descriptor

The engine names no component, no route, no pixel. It projects each descriptor into a presentation
contract — types, roles, choices — and any surface that honours the contract renders any model
this method produces (the full table is Part VII §29). The consequence for modeling: **you design
the UI by choosing field shapes, not by asking for widgets.** "I want a dropdown" is not a request
to a UI team; it is `enum:` — or better, nothing, because a low-cardinality free string already
becomes a dropdown through `dt values`. "I want chips" is `many: true`. "I want a page" is
`body: true`.
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
3. **One record.** What is its identity? `ids.from` builds it from creation-time values the
   record OWNS — the domain's own date, never `created` (a back-dated import would file a June
   visit under October); a `YYYY/MM/` prefix when growth is unbounded, and `ids.pattern` must then
   admit `/`. And which field says two records are the *same* thing — that is what `unique: true`
   is for, on the field that must not be claimed twice.
4. **Lifecycle.** What states, what moves a record between them, and what "done" is. `status` is
   the field a board groups by and a command-binding gates on. End of life is a **state**
   (`archived`, `dropped`), not `rm` — `rm` refuses while anything points at the record, and a
   deleted record takes its history's legibility with it.
5. **Stable vs volatile.** A thing and the churning activity about it are two collections
   (`patients` and `visits`; `products` and `issues`). A new *version* of the same thing is **git
   history, never a second record** — one dossier per patient, superseded text visible in
   `git log`, not `dossier-v2`.
6. **Who points at whom, from which side.** The foreign key lives on the many side; scalar or
   `many` follows cardinality; the far side is one generated mirror away, never a hand-maintained
   field. Declare the mirror when "which X have no Y" will be asked; skip it when only "this Y's
   X" will (Part VI §25).
7. **The forcing field.** One required field whose absence makes the record write-only: `evidence`
   on a defect, `done_when` on a goal, `dose` on a prescription. It is the difference between a
   record and a wish. A collection with no conceivable forcing field is a list — model it as one
   (a `tags` list, a body bullet) and say so in the proposal.
8. **Units and time.** A number without its unit is a latent bug: `amount` + `currency`, `value` +
   `unit`, or the unit in the name (`duration_min`). An instant is `datetime` with its offset; a
   day is `date`; never store an instant in a day field because "it sorts fine today". One
   operator over git: **ownership and permissions are not modelled** — invent no `owner`,
   `created_by`, `assignee` unless multiple humans genuinely write the workspace, and even then
   model the *people* first.
9. **Volume and write rate.** Roughly how many records in a year, and what writes them — a human
   occasionally, a command per event, a sync every fifteen minutes? Ten records need no id prefix
   and no namespace; ten thousand machine-written records need a time-sharded id, a lean
   frontmatter, and a hard look at every mirror that would concentrate writes into one hot file
   (Part VIII §36).
10. **The list.** What columns would the user scan — which four to six fields identify, order, and
    triage a record at a glance? That is `display.list.columns`, and if you cannot fill it, the
    fields are wrong (Part VII §30).
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
3. The **system verbs** (`dt add collections`, `dt add-field`, …) (or the hand-written descriptor when the collection is
   module-owned or carries comments worth keeping).
4. The **"deliberately not modelled"** list, each with its one-line reason.
5. For each relation: which side owns, whether a mirror is declared, and the answer to "which X
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
- **Self-containment is structural, not aspirational.** Never list a mixin another module ships —
  compile accepts it, and the module stops being copyable. A shared field set is duplicated per
  module under a scoped id
  (`clinic-provenance`, `billing-provenance`) precisely so each module stays copyable. This is the
  most expensive boundary mistake known: a module whose descriptors listed a field set living in
  the *consuming* workspace could not compile anywhere else, and nothing said so until someone
  tried.
- **A cross-module relation is a declared dependency.** A mirror on another module's collection
  lives in an `overlay: true` descriptor of it, and compile refuses the overlay unless its module
  depends on the owner or names the collection in `peer_collections` — a module may not grow
  fields on a stranger silently.
- ⚠ **The workspace module is special in two places, and only two.** Its fields may reference any
  installed collection without declaring the module, and `type: reference` (any collection) draws
  no warning there — elsewhere it is an unverifiable cross-module surface. It is **NOT** exempt from
  the overlay gate: an overlay in the workspace module on another module's collection needs that
  module in `dreamteamer.dependencies`, exactly as any other overlay does.
- **Start in the workspace module; extract on the second consumer, not the first hunch.** The
  system verbs default to the workspace module (`--module <m>` names another), and that is the
  right first home for everything. A module is
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
- Namespacing an existing collection later is `dt rename collections/<old> <ns>/<old>` — one
  commit, every inbound reference rewritten, safe at any point. Cheapest early, though: the
  rewrite is O(records × files), measured at ~3 minutes for a 2,291-record collection — tolerable
  for a one-time migration, not free. So do not agonise up front; just decide sooner rather than
  at ten thousand records.

### 10. Mixins vs overlays vs copy

Three ways to share shape, in strictly descending order of preference:

| mechanism | what it is | use when | never for |
|---|---|---|---|
| `mixins` | a live shared field set, merged at every compile; a field the descriptor also declares is an error | the same field group on several collections in ONE module — provenance, funnel fields, address blocks | reaching across modules |
| `overlay: true` | a descriptor adding fields to another module's collection | a workspace or module extending a collection it installed | taxonomy ("a lead is-a engagement"); removing inherited fields (impossible by design) |
| copy | duplicating fields into a second descriptor | crossing a module boundary (each side owns its copy, scoped name), or when two shapes are about to diverge | "saving time" inside one module — that is a mixin |

The instinct to resist is building a type hierarchy. When two collections share most fields, the
model wants a shared **mixin** plus two thin descriptors — or a reference between them — never a
base collection that exists only to be extended. An abstraction with one concrete consumer is a
roadmap, not a model; wait for the second consumer.

### 11. Where records live: `data/`, formats, shapes

- **`data/` is where records go.** `storage.path` is free-form, so a collection can be pointed
  anywhere in the workspace, but the answer is `data/<collection>` unless you have a reason you can
  state.
- **Do not model machinery as records at all.** In descending order: a field on a record that
  already exists · a line appended to a gitignored `.cache/*` file (right for thousands of
  append-only rows nobody opens individually) · a real collection, if and only if you will
  genuinely list, filter and read the things one at a time.
- **`format: md` whenever a human reads a body; `yaml` when nobody does.** A record that is all
  fields and no prose (a lab value, a transaction, a cursor) is `yaml` — the body would only ever
  be empty. `json` exists for tool-written records.
- **`format: binary` makes the record an opaque file** — an icon, a logo, an image the UI draws.
  Fields are derived (`ext`, `bytes`), writes go through `dt add <c> <id> --from <path>`, and
  `check` guards `storage.max_bytes` (default 200 KB) and `storage.accept`. A big binary is not a record: it lives outside the vault under a
  declared var, with an ordinary record carrying the `${env:...}` template that points at it.
- **`shape: folder` when a record is intrinsically several files** (a skill with references beside
  it), or when OTHER collections' records should live inside it — see the next bullet. Otherwise
  prefer one file until the record itself demands companions.
- **`storage.under` when people browse a parent as a unit** — a company folder holding that
  company's meetings, a patient folder holding their lab values. It is declared on the CHILD
  (`under: { parent: company, subfolder: meetings }`), the collection stays ONE collection with the
  same references, and the owner field is what moves a file (`collections.md`). `under.id: nested`
  is for a child whose id already leads with its parent's. Choose ONE
  physical owner and leave every other relationship a plain reference; keep conventional storage
  when no single owner is sensible, when the owner is usually unknown, or when nobody would open
  the folder. It organises files; it grants nothing.
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
  re-keyed. `date` renders a value in its own offset (`…T23:30:00+03:00` is 23:30 on that day on
  every machine), so the id does not change with the machine's zone.
- **A time prefix for unbounded growth**: `{{ date | date:YYYY/MM }}/…` shards the folder by
  month, keeps `ls` fast and scannable, and files the record where a human would look. The
  `ids.pattern` must then admit `/`.
- **A subject prefix when the collection partitions by an anchor**: `<patient>/<date>--<analyte>`
  puts everything about one patient together — right when the dominant access is "all of X for
  this person", wrong when it is time-global. When the anchor is also the folder the records live
  in, that is `storage.under` with `id: nested`.
- **`ids.pattern` must accept everything `ids.from` can produce.** Non-latin names slug to a
  deterministic short hash, so `[a-z0-9-]` holds; test with a real awkward title before shipping.
- **Sameness is a field property, not an id property.** "One summary per meeting" is
  `unique: true` on the summary's `meeting` reference — refused at write and reported by `check`,
  naming both records — not a convention about ids that nothing enforces.

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
  points at the record (`on_delete: restrict` is the default for exactly this reason).
- **The transition is a verb.** When moving between states has steps, that is a command bound to
  the collection with `available_when`/`done_when` gates on the fields — not a fatter enum, and
  not prose in the description hoping to be followed.
- **Never enum against data that already violates it.** Declaring `enum:` over a field whose
  records hold other values makes `check` fail on every one; clean first, then narrow (Part IX).

### 16. Stable vs volatile, singletons, documents vs entities

Three recurring shapes, each with a rule:

- **The thing / the activity about the thing.** `patients` (stable identity, edited in place) and
  `visits` (append-only events pointing at a patient). Mixing them — visit notes accumulating on
  the patient record — destroys both: the entity's diff becomes noise and the events lose their
  grain. The stable record carries only what is *currently true*; everything dated hangs off it.
- **The singleton-per-subject document.** One living dossier per patient, one page per engagement:
  enforce it with `unique: true` on the subject reference, edit in place, and let git hold every
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
The orientation block every session loads is rendered from it, top-down: each **module's** sentence
heads its group (with the namespaces, skills and commands it ships), each **collection's**
`description` and `use_when` follow, and field descriptions are what an agent reads before writing a
value. Three layers, three questions — *what is this area for* · *what is this thing, and when do I
reach for it* · *what does this value mean*. So:

- A **module's** `description` (its package.json — `dreamteamer.description`, or npm's own
  top-level `description`) says what the AREA is for and what it deliberately is not: the domain,
  its boundary with a neighbouring module, anything a session must know before working in it
  (private data, a machine-bound account). It is the top of the tree a session reads first.
- A **collection's** `description` says what one record IS, and names the neighbour it is NOT:
  "the person, never the org — that is `companies`". Confusable pairs each point at the other.
- A collection's **`use_when`** names the SITUATIONS that should bring a session here, in both
  directions — read ("about to diagnose a defect — search here first, filtered by repo") and write
  ("a thought arrives that has no home yet"). **Author it for every collection whose trigger is not
  literally "you have one of these."** A schema is designed to be used, and the measured failure
  mode is a session inventing a new state, field or terminal condition while the collection that
  already modelled it sat in its context under a description it had read. Two rules: it names a
  situation, never a procedure (a `how` belongs in the module's skill); and it must not paraphrase
  the description — that costs every session tokens and dilutes the clauses that carry signal.
  ⚠ It is prose; nothing fires on it. It raises the odds a session looks; it does not make it.
- A **field's** `description` says what the value MEANS, names the source when the value is copied
  from elsewhere, and states the convention an agent must follow ("empty means unmatched — the
  matching command's queue").
- A field whose valid value has a non-obvious SHAPE carries an `examples:` list — passed to the
  validator, and its first value rendered into the collection's `write:` line in the orientation block beside the required fields and closed
  enums — so the canonical value lives in the contract, not in whichever record a writer happens to
  open, and a session sees it before its first write. Two or three, real-looking
  and synthetic: a `${env:…}` path template, a `key:value` tag, an RRULE, a composite id.
- Descriptions are the cheapest UX in the system: the same line is the tooltip in every surface,
  the agent's guidance, and the future maintainer's note. Budget a real sentence per field.
- Compile WARNS on a module, collection or mixin with no description — each renders
  as a bare name in the block otherwise — and on a `use_when` that restates its description (content
  words shared ≥ 0.5): name the situation, do not delete the clause. It does not warn on a missing
  `use_when`, because it cannot tell a considered omission from a forgotten one; that judgement is
  yours, per collection.

---

## Part V — fields

### 19. The ladder: collection · reference · enum · vocabulary · tags · nested — measured, not guessed

For every value, walk down until a rung holds. The measurements are two commands, not taste.

| the value… | model as | the measure |
|---|---|---|
| has fields of its own, a lifecycle, or is opened alone | a **collection**, pointed at with `type: <collection>` | — |
| is one of a small set the domain itself defines and closes | **`enum`** (a list, or a map carrying labels and colours) | `dt values <c> <f>` shows ≤ ~10 distinct values AND their counts sum to ≥ 80 % of the records — `values` reports distinct counts (never fill; compute fill against the record count), and echoes a declared enum verbatim without counts |
| is a vocabulary the workspace grows as it goes | **free string** — `dt values` derives the dropdown from the data, so a moving set needs no schema change and `check` never fails on a new value | the set is still moving, or predates any enum |
| is a loose label with no attributes | **`tags`** — `type: string, many: true`. The moment labels read like `key:value`, that is a field wanting to exist: promote it | — |
| repeats inside one record and is never referenced from outside | **nested** — `type: object, many: true` with `fields`, and `item_title` so rows get a label; `type: map` for key → value | the costs are real: not filterable across records (a non-operator filter key means a reference hop, so a nested key narrows to nothing), skipped by `dt values`, unusable as a list column — the form and the body are its only readers |

Two hard "nevers": never declare an `enum` against records that already violate it (§15), and
never create a `tags` *collection* — a label with no attributes does not earn records, and the day
it grows attributes it becomes a real collection with a real name.

The promotion paths all run upward and are all cheap except the last: a free string becomes an
enum by declaration once the vocabulary settles; a tag becomes a field; a nested object becomes a
collection **only by a one-shot migration script**, which is why question 1 of the interview errs
toward collections whenever cross-record questions are conceivable.

### 20. Every field key, and what it does downstream

Field order matters: **it is the form order**, and the body field goes last. The closed key list
is `collections.md`; the judgment per key:

| key | decide by | what it drives downstream |
|---|---|---|
| `type` | `date` vs `datetime` honestly (§21); `markdown` for prose a person reads | the control every surface picks |
| `title` | authored only when title-casing the name reads wrong (`ui_views` → `UI Views`) | the label everywhere |
| `description` | §18 | tooltip + agent guidance |
| `required` | the forcing field and identity inputs, nothing else (§17) | the asterisk; a write missing it is refused before disk |
| `enum` | the ladder | a dropdown; `check` enforcement; with a map, labels, icons and band colours |
| `default` | what is true when unstated — not what is common | filled in on create; documents the neutral value |
| `type: <collection>` | Part VI | the record picker, labelled by the target's `record_title`; `check` and `rename` follow it |
| `mirror_of` · `unique` · `on_delete` | Part VI | the generated mirror; cardinality; delete behaviour |
| `body: true` | the ONE long prose field | the markdown body; rendered as the page, last |
| `item_title` | rows of a `many` object need a human label | the row label in the list editor |
| `display` | only where the shape's default drawing is wrong — a unit, a direction, a field locked after create | the surface; never the data |
| `mixins` (collection level) | a field set shared within the module | identical fields across collections, maintained in one file |

What is deliberately absent: computed fields (a skill or command keeps a denormalized key, §3),
field-level permissions (one operator over git), validation beyond the field keys and
`constraints` (a rule they cannot express belongs in the writing command's gate, where it can
refuse with a sentence).

### 21. Time, money, measures

- **`datetime` for instants, `date` for days, never one in the other.** The engine compares
  date-times across offsets correctly; a day stored as midnight lies about precision and breaks
  "same day" filters across timezones.
- **Denormalized date keys are the sanctioned copy** (§3): a child record carrying the parent's
  date so lists sort and ids generate without a join — with the source and writer named in the
  description.
- **Money is `amount` + `currency`**, always, even when "it's all one currency today" — the first
  foreign invoice is not the moment to migrate. Same for measures: `value` + `unit`, or the unit
  in the field name (`duration_min`, `weight_kg`) when it is genuinely fixed.
- **Timestamps the engine already keeps are not fields.** `created` (stamped at `dt add`) and
  `last_modified` (from git) are injected into every collection. Author a date field only when it
  carries *domain* time (the visit's date, not the record's).

### 22. Naming

Names are read hundreds of times per write; optimize for the reader:

- **Collections: plural, hyphenated, the word the user says** — `lab-values`, `visits`. The
  record suffix and the CLI's singular derive from the inflector (`<id>.lab-value.md`,
  `dt add lab-value`); where it is wrong (`people`), author `singular: person` and
  `storage.suffix: person`. A collection is for what *recurs*;
  a one-off is a record in some existing collection, not a new box.
- **Fields: `snake_case`; enum values kebab-case; a reference named for the target's singular**
  (`visit`, `doctor`), the mirror for the owner's plural (`visits`). Name the **role, not the instance**: `person`, not
  `staff-member`; `source_account`, not the bank's name.
- **No abbreviations the user does not say aloud.** `qty` saves three characters and costs every
  future reader a beat.
- **Confusable pairs get contrasting names AND contrasting descriptions** — `expense_transactions`
  vs `reimbursement_transactions`, each saying which it is not.
- **Rename early.** A wrong name compounds daily. `dt rename collections/…`, `dt rename-field` and
  `dt rename-value` each rewrite every position in one commit, and each costs O(records) — cheapest
  the day the name is wrong.

---

## Part VI — relations

### 23. The model: one owner, a generated mirror, declared on the far side

A relation has exactly one **owning field** — the foreign key, on the many side — and optionally a
**generated mirror** on the far side. The store maintains the mirror's values in the same write as
every change to the owner, **refuses direct writes to it** naming the field to set instead, and
`check` reports one fallen behind as stale with the repair command. You author the owner and
declare the mirror; the values are kept.

There is one spelling: `mirror_of`, written on the far side, naming the owner's field:

```yaml
# on health/visits — the owner, a plain reference:
doctor:
  type: health/doctors
  required: true
  description: Who saw the patient.

# on health/doctors — the mirror:
visits:
  type: health/visits
  many: true
  mirror_of: doctor               # health/visits.doctor
  description: Every visit this doctor has seen — generated; set `doctor` on the visit.
```

The mirror keeps a hand-written `description` in the file a reader opens, which the orientation
block renders. When the far side belongs to another module, the mirror goes in an
`overlay: true` descriptor of it, in the module that owns the foreign key (`collections.md`).

Cardinality closes from the shapes, and one-to-many is **never authored** — it is always the
mirror of a scalar:

| owning field | mirror | kind |
|---|---|---|
| scalar reference | `many: true` | many-to-one |
| scalar reference + `unique: true` | scalar (no `many`) | one-to-one |
| `many: true` reference | `many: true` | many-to-many |

A scalar mirror REQUIRES `unique: true` on the owner, and a `many` mirror of a unique owner is
refused: compile names both fields and stamps nothing. `unique` is a value constraint on its own
too — on an email, a national id — enforced at write and by `check` whether or not anything
mirrors it.

`on_delete` says what removing a *target* does to records pointing at it: `restrict` (default)
refuses the `rm` and names them; `set-null` clears the foreign keys — refused at compile on a
`required` reference or a `many` one with `minItems` above one, because a delete must not
manufacture invalid records.

### 24. Choosing the shape — a decision table

| the relationship, in a sentence | model |
|---|---|
| each visit has one doctor; a doctor has many visits | scalar `doctor` on visits (+ a mirror when §25 says yes) |
| each meeting has at most one summary, ever | scalar `meeting` on summaries + `unique: true` — a second is refused, `check` names both |
| an analysis covers several meetings; a meeting may be analysed repeatedly | `many: true` on the analysis (+ mirror) — many-to-many with no junction |
| the link itself has fields (a dosage, a role, a start date) | a **junction collection**: an ordinary collection with two references and the edge's own fields. Only when the edge genuinely carries data |
| the field may point at one of several collections | a union: `type: [meetings, visits]` — the stored value's prefix disambiguates |
| evidence/source pointing anywhere | `type: reference` — open world, `check` verifies existence only, **no mirror possible** |
| a name that may not have a record yet ("referred by Dr. X") | `soft: true` on the reference — it names the collection, and a missing record is tolerated |
| an org's parent org | self-reference — legal, mirrors and all (`parent` → `subsidiaries`) |
| A and B reference each other with different meanings | two independent relations — never one field doing double duty |

### 25. Direction — when to declare the mirror, when to skip it

The mirror is cost-free to *maintain* (the engine keeps it) but not free to *have*: it is lines in
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
- the target is a `format: binary`, runtime, bodyless-`md` or other-repo collection — compile
  refuses the mirror anyway, with the reason.

Leaving a reference one-way is not a compromise; for evidence fields, `type: reference` fields, and
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
  `dreamteamer relations rebuild <collection>`); `unique` collisions (naming both claimants);
  enums, requireds, id patterns, placement.
- The store maintains mirrors on `add`/`set`/`rm`/`revert`; refuses writes to mirrors, to
  `created` and to virtual fields; refuses a `unique` value already taken; `rm` honours
  `on_delete`, detaches its own mirrors, and refuses on unmanaged inbound references.
- a RECORD-scoped commit pairs a relational write with the mirror partners it dirtied, so one
  logical change is one commit — and refuses to publish half of a pair; the collection form
  publishes what it names and prints the partners it left pending. The scoping rules live in
  `records.md`.
- Schema ops clean up after themselves: dropping a mirror clears the generated values it
  orphans; removing a populated field clears its values, reporting the count, with the previous
  version in git.

What no machine holds: the discipline of a denormalized key (§26), the honesty of a status enum
(§15), and the grain (§13). Those live in descriptions and review.

---

## Part VII — UX: designing for the surface without naming one

### 28. The contract

The engine emits, per collection, a row — title, `nav`, `list`, `record`, `form`, the
`record_title`, the position field — and per field a row: the authored type name, label,
description, `role`, `kind`, `editable`, `hidden`, the choices, the `display` keys. A surface
renders the contract; the model *is* the UI design. This is what keeps the engine detached from
any particular surface while still letting a modeler decide how things will look.

### 29. Shape → projection — the full table

| descriptor shape | the engine emits | any surface shows |
|---|---|---|
| `body: true` | `role: body` | the record's page, rendered last |
| scalar `type: <collection>` | `role: reference` | a record picker, values labelled through the target's `record_title` |
| `many: true` reference | `role: reference_many`, `many: true` | a multi-picker; chips |
| `mirror_of` | `role: mirror`, `kind: mirror`, `editable: false`, `mirror_of` | read-only chips; **never an editable control, the create form included** |
| `created` · `id` · `last_modified` | `kind: derived` · `kind: virtual`, `editable: false` | read-only values, never on the form |
| `enum` | `editor_options.choices`: `label`, `value`, and the map's decoration | a dropdown; board lanes in enum order |
| `type: string, many: true` | `type: string`, `many: true` | chips |
| `type: object, many: true` | `editor_options.fields`, `item_title` | a repeating-row editor |
| `type: object` · `type: map` | the sub-fields · the open map | a sub-form · key/value rows |
| any other type | the authored type name (`date`, `datetime`, `number`, `url`…) | its matching control |
| `display.*` on a field | `editable`, `hidden`, `unit`, `unit_field`, `direction`, `width`, `placeholder`, `form_section`, `editor`/`viewer` | exactly what it says — the one place a descriptor names a widget |
| `description` | `description` | the tooltip |
| low-cardinality free string | *(no schema mark)* — `dt values` supplies the vocabulary | a dropdown of observed values, most-used first |

Three consequences worth designing with: a **mirror is knowable by its `role`**, so a surface can
disable the control with a reason instead of letting a write bounce; a **free string is already a
dropdown** wherever the surface asks `values`, so enums are for *closed* sets, not for getting a
picker; and everything here degrades to plain text gracefully, because the record is plain text —
the projection adds affordances, never meaning.

### 30. Lists — the record's row

`display.list.columns` is the model's answer to "what does a scanning human need": **four to six
columns** — the name, the sort key, the status, the relation you filter by. More columns is not
more information; it is a horizontal scrollbar. A field that would usually be empty in a list, and
any body or nested table, does not go in one. A ui-view's `display.list.columns` **replaces** the
collection's, and a column naming a field the collection lacks is a compile error naming it.

### 31. The record's face: `record_title`, icons, order

- `record_title` is how a record is labelled *everywhere it is referenced* — pickers, chips,
  lists, links. Authored once on the collection, used by every reference field pointing at it.
  Compile derives one from `title`/`name`/`subject`; **a derivation to `{{ id }}` is a smell**
  meaning no name-like field exists — add one, because ids make terrible chips.
- `display.nav.icon` and `display.nav.order` place the collection in any nav; the nav groups by
  owning module, and `display.nav.section` partitions further. Cheap and worth setting — an
  unnamed generic glyph in a tree of twenty collections costs a glance every time.
- `display.record.subtitle`, `badge` and `color_by` are the record header: a template line, a
  field drawn as a chip, and an enum whose map colours tint rows and cards.

### 32. Forms — property order is the design

The form is the field order, top to bottom — or `display.form.sections`, which groups it. So:
identity first (name, date, the references that file the record), then state (status and its
axes), then detail, then the body last — which a mixin respects by inserting its fields before
the body. Progressive disclosure is
achieved by what you *don't* make a field (§2: read-once information belongs in the body) and by
defaults (a field with a good default is a field nobody has to touch), and by
`display.hidden: [form]` for what only a script writes. Required-field discipline (§17) is form
design: every asterisk is friction at capture time.

### 33. Views — when a `ui-view` earns existence

A named ui-view exists to be *different* from the default rendering, and it earns its keep when
it encodes a **recurring question**, when a different layout genuinely fits the data's axis, or
when a filtered slice is someone's daily surface — one view per recurring question, never one per
mood. The model side of the decision is that the question must already be a one-hop filter (§34);
everything else about views — anatomy, scopes, layouts, the filter and options traps — is
`ui-views.md`.

### 34. Searchable and filterable — the model side of "find it"

- **Filters reach one hop outbound** — any field on the record, and through a reference to the
  target's fields (`{"doctor": {"specialty": {"_eq": "cardiology"}}}`), arrays with any-match
  semantics. They do not reach inbound (that is what mirrors are for) and never two hops (that is
  what denormalized keys are for). Model so every recurring question lands within one hop.
- The operator set is rich (`_eq`…`_between`, `_contains`, `_starts_with`, case-insensitive
  variants, `_empty`/`_nempty`, `_regex`, `_and`/`_or`), and two value tokens stand for the
  moment: `$today` and `$now`. A view's or a binding's field names are checked at compile, but in
  `--where` **an unknown key or a dangling reference narrows to nothing** rather than erroring.
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
  the performance side: skip the mirror on machine-written high-fan-in relations, or hang a small
  stats record beside the anchor instead.
- **Event streams append; entities update.** An append-only collection (one new file per event)
  has no hot files at all — which is why the stable/volatile split (§16) is also the concurrency
  design.
- **Do not renumber.** Manual order is a `type: position` field holding a fractional key per
  record, written by `dt reorder <collection>/<id> --after|--before <id> | --top | --bottom` (and
  `--init` for records that have none), because renumbering a list is a multi-file commit against
  git for no information.

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
folder", "lean the frontmatter", or "drop the unread mirror", in that order.

---

## Part IX — evolution: changing a model that already holds records

### 39. Additive first

Widening is always safe and needs no ceremony: a new optional field, a new enum value, a new
collection, a new mirror on an existing reference (declare it, then `relations rebuild` backfills
every value in one command — no script). Ship the widening, backfill opportunistically, narrow
later if ever.

### 40. Narrowing — clean, then declare

A new `required`, a tightened `enum`, a pattern change: `check` will flood on every pre-existing
violation, so the order is fixed — measure (`dt values`, a filter for the outliers), clean the
data, *then* narrow the schema. Narrowing first "to see what breaks" makes every later `check`
useless until the flood is drained.

### 41. Renames

- **Collections**: `dt rename collections/<old> <new>` — descriptor, records, filenames and
  every inbound reference in one commit. Safe, and cheapest early — the rewrite is
  O(records × files), measured ~3 minutes at ~2,300 records — so do it the day the name is wrong,
  not the year after.
- **Fields**: `dt rename-field <c> --name <f> --to <g>` — one commit, rewriting the key in every
  record and every position that names the field by name: columns, sort, badge, sections,
  templates, `ids.from`, constraints, `storage.under.parent`, a mirror's `mirror_of`, a ui-view's
  filter and display, a binding's conditions. A position it cannot rewrite is refused by name;
  `--dry-run` lists each. When the values themselves must CHANGE shape, the sequence is add-new,
  script the values, `rm-field` the old.
- **Enum values**: `dt rename-value <c> <field> <old> <new>` — the enum, its default, constraints,
  view filters, binding conditions and every record, in one commit.
- **Values** (an id, a reference target): `dt rename <collection>/<old> <new>` rewrites inbound
  references. Prose wikilinks are followed in both spellings — `[[collection/id]]` always, and a
  bare `[[id]]` when that basename names exactly ONE record in the workspace; when something else
  claims it, the link is left alone and the rename says so, naming the file. A `#anchor` and a
  `|label` both ride through untouched (`[[id#heading|see here]]`) — only the record moved. Raw
  prose that is not a wikilink is counted and reported, never rewritten.

### 42. Migrations are scripts, run once, committed with their effects

There is no migration framework. A shape change across existing records is a one-shot script: written, run, verified with
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
| a string whose values look like `<collection>/<id>` | a relation the machine cannot see | `type: <collection>` — `check` and `rename` start working |
| `record_title` derived to `{{ id }}` | no name-like field | add one; ids make terrible chips |
| two collections sharing most fields, no reference between them | a hidden relation or a false split | reference, mixin, or merge — decided by the triage test (§4) |
| a `kind` enum whose members are triaged on different questions | two collections wearing one name | split |
| a scalar reference with fan-in > 1, no mirror, and a saved view asking "which have none" | the question exists, the mirror doesn't | declare the mirror |
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
visit that issued them. Mirrors: `patients.visits` yes ("patients not seen this year" is a real
question) — but **not** `patients.lab_values`: fan-in measured in the hundreds per patient would
drown the record, and the per-person question is already answered by storing lab values inside the
patient's folder, their ids leading with the patient. Forcing fields: `dose` on a prescription; `value` + `unit` on a lab value. Volume: tens
of visits a week — `YYYY/MM` sharding on visits and prescriptions, nested under the patient for
lab-values, none on patients (one folder each, `shape: folder`, so they can hold their lab values). Module: `clinic`, namespace `health`, commons untouched.

**The proposal** (three of the five descriptors — the ones that carry the lessons):

```yaml
# modules/clinic/collections/health/lab-values.collection.yaml
name: health/lab-values
description: >-
  ONE measured value — one analyte, one patient, one date. A panel is a filter on patient+date, a
  timeline a filter on patient+analyte. Not a visit's in-room vitals.
use_when: a lab report arrives, or a trend is asked for — one record per analyte per date
storage:
  format: yaml
  under:
    parent: patient
    subfolder: labs
    id: nested
ids:
  from: '{{ patient | basename }}/{{ date | date }}--{{ analyte | slug }}'
  pattern: '^[a-z0-9-]+/\d{4}-\d{2}-\d{2}--[a-z0-9-]+$'
fields:
  patient:
    type: health/patients
    required: true
    description: Whose blood. The id begins with it, and the record lives in the patient's folder.
  date:
    type: date
    required: true
    description: The draw date — the lab's own, never the filing date.
  analyte:
    type: string
    required: true
    description: What was measured, lowercase (ldl, vitamin-d) — a vocabulary, not an enum; `dt values` is the dropdown.
  value:
    type: number
    required: true
    description: The number alone — the unit is beside it, never inside it.
  unit:
    type: string
    required: true
    description: mg/dL, mmol/L, % — from the lab report, verbatim.
  flag:
    type: string
    enum: [low, normal, high]
    description: The lab's own flag when printed; empty when the report shows none.
  ordered_by:
    type: health/doctors
    soft: true
    description: Who ordered the test — often a doctor outside the clinic, so the record may not exist.
display:
  list:
    columns: [patient, date, analyte, value, unit, flag]
```

```yaml
# modules/clinic/collections/health/prescriptions.collection.yaml   (the relation lessons)
name: health/prescriptions
description: >-
  One drug prescribed once — what, how much, and whether it is still running. "What is this
  patient currently on" is a filter (patient + status=active), which is why status is a field and
  not a sentence in the body.
use_when: a drug is prescribed, renewed or stopped — write it here; asked what a patient is on, filter here
ids:
  from: '{{ date | date:YYYY/MM }}/{{ date | date }}--{{ patient | basename }}--{{ drug | slug }}'
  pattern: '^\d{4}/\d{2}/\d{4}-\d{2}-\d{2}--[a-z0-9-]+--[a-z0-9-]+$'
fields:
  drug:
    type: string
    required: true
    description: Generic name, lowercase — a vocabulary.
  patient:
    type: health/patients
    required: true
    description: Who takes it.
  visit:
    type: health/visits
    on_delete: set-null
    description: >-
      The visit that issued it — empty for a renewal issued between visits, which is itself the
      signal that a renewal happened outside a consult.
  dose:
    type: string
    required: true
    description: 'The forcing field: a prescription without a dose is a rumour. As written — "20mg once daily".'
  date:
    type: date
    required: true
    description: Issued when — also the id's filing date.
  status:
    type: string
    default: active
    enum: [active, stopped, completed]
    description: Observable states only — stopped is a decision, completed is the course run out.
  notes:
    type: markdown
    body: true
    description: Why prescribed, reactions, the story — read within one record, never filtered.
display:
  list:
    columns: [patient, drug, dose, status, date]
    sort: -date
```

```yaml
# modules/clinic/collections/health/patients.collection.yaml — the parent and the far sides. A
# mirror needs somewhere to live beside the prose, so the collection declares a body field.
name: health/patients
description: A person under the clinic's care — the anchor every visit and prescription hangs off. Not a doctor.
use_when: a person is named in a visit, a referral or a lab report — find or create them here first
storage:
  shape: folder
  entry: patient.md
fields:
  name:
    type: string
    required: true
    description: Full name, as on the health-fund card.
  visits:
    type: health/visits
    many: true
    mirror_of: patient
    description: Every consult, generated — set `patient` on the visit. Empty means never seen.
  prescriptions:
    type: health/prescriptions
    many: true
    mirror_of: patient
    description: Everything ever prescribed, generated. "Currently on" is this filtered to active.
  notes:
    type: markdown
    body: true
    description: The patient's running file.
```

**One sample record, seeded before declaring** — the step that catches the unit nobody mentioned:

```
dt add health/lab-values --patient health/patients/dana-levi --date 2026-07-02 --analyte ldl \
      --value 138 --unit mg/dL --flag high
→ data/health/patients/dana-levi/labs/2026-07-02--ldl.lab-value.yaml   (id dana-levi/2026-07-02--ldl)
```

**Deliberately not modelled:** appointments (the calendar owns scheduling; a visit is written when
it *happens*) · symptoms as fields (read within one visit — body prose) · a `patients.lab_values`
mirror (fan-in; the patient's folder already files them per person) · a `doctors.patients` relation (it
is derivable through visits and would be a copy with no keeper) · invoices (a different module's
concept — declared out of scope rather than half-modelled).

Why this model holds up, checked against the parts: every recurring question is a one-hop filter
(I §2, VII §34) · the grains differ per collection and each was chosen by its question (IV §13) ·
the one risky mirror was measured and refused (VI §25) · every number carries its unit (V §21) ·
the statuses are observable (IV §15) · the module compiles alone and touches no commons (III §8).

---

## Appendix — the modeler's checklists

**Proposing (before writing anything):**

- [ ] every collection's `description` names its question and its confusable neighbour
- [ ] grain chosen per collection by the two-question drill, stated in the description when non-obvious
- [ ] ids from creation-time owned values; patterns admit what `ids.from` produces; time-sharded where unbounded
- [ ] each relation: owner side chosen, mirror declared-or-refused *with the reason*, `on_delete` stated
- [ ] forcing field per collection — or the collection declared a capture pile on purpose
- [ ] units beside every number; `date` vs `datetime` honest
- [ ] `display.list.columns` scannable at 4–6 columns; `record_title` never `{{ id }}`
- [ ] module ownership stated; no cross-module mixin; overlays only behind a dependency; namespace == module
- [ ] the deliberately-not-modelled list exists
- [ ] one sample record per collection, shown as its `dt add`

**Reviewing an existing model:** run the smells table (Part X) top to bottom; measure before
declaring (`dt values`, fan-in counts, fill rates); prefer the additive fix; and when a change
rewrites records, it is a one-shot script committed with its effects, whose commit message is the
ledger.
