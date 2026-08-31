# ui-views — a question, saved as a route

`modules/<module>/ui-views/<name>.ui-view.yaml`. **A ui-view is a binding, not code** — a route,
the id of an already-registered layout, and how to shape the data. Nothing to build.

The reader who matters most is not you and not the surface: it is the **operator**, whose recurring
question this record encodes. A good view is a question they stopped having to re-ask ("which
prescriptions are still running", "what landed this week"); a bad view is a nav entry they scroll
past. The surface reads compiled ui-view records at boot *and on every change* — `nav` becomes a
sidebar entry, `path` a live route, and an edited view reaches an already-open tab on the next
compile. After authoring: compile, and it's live on reload.

| the question | read |
|---|---|
| does this view deserve to exist | when a view earns existence |
| the record and its fields | anatomy |
| list, item or page | targets |
| which layout | layouts |
| narrowing the rows | filters |
| columns, sort, layout settings | options |
| the sidebar entry | nav |
| the collection's default rendering | default views |
| writing views from the CLI | the verbs |

## when a view earns existence

The default rendering — a table of `list_fields` over the whole collection — is itself an ordinary
default view, so a *named* view exists to be **different** from it. One earns its keep when:

- it encodes a **recurring question** (`/views/visits/unbilled`) — the operator asks it weekly, and
  the filter is the answer;
- a **different layout genuinely fits the data** — kanban when a status enum drives work, calendar
  when a date field is the axis, map when records carry locations, diagram when the relations are
  the point;
- a filtered slice is **someone's daily surface** — the first thing opened, worth one keystroke.

One view per recurring question, not one per mood: each is a nav line, a record to maintain, and a
thing that can silently rot when the schema moves under it. A view that restates the built-in
fallback is maintenance for zero gain.

## anatomy

```yaml
path: /inbox                                # the route; the record id derives from it
nav: { label: Inbox, icon: inbox, order: 1 }
target: list
collection: collections/tasks               # qualified, always
layout: table                               # a REGISTERED layout id
filter: { status: { _eq: todo } }           # operator objects, never bare values
options: { columns: [name, status, due], sort: -due }
```

| field | required | notes |
|---|---|---|
| `path` | yes | the route — `/inbox`, `/views/meetings/recent`. The id derives from it, so a view saved from the CLI and one saved from the UI land on the **same record** |
| `target` | yes | `list`, `item`, or `page` (below) |
| `layout` | yes | a **registered** layout id — see layouts |
| `collection` | for `list`/`item` | qualified: `collections/<name>` |
| `nav` | no | `label`/`icon`/`order`; omit entirely for direct-link-only routes |
| `filter` | no | the saved narrowing — see filters |
| `options` | no | layout-specific settings — see options |
| `default` | no | `true` makes this the collection's DEFAULT rendering — see default views |

## targets

- **`list`** — the named layout renders over the collection, `filter` and `options` applied. The
  everyday case.
- **`item`** — a record page route: the path gains an `:id` parameter and renders one record of
  `collection`.
- **`page`** — a freestanding page: `layout` names a registered **app**, whose **first declared
  route's** component renders at `path` (list the index route first — that convention is the
  mechanism). An unregistered name renders a visible "not registered" placeholder — never a blank
  page — which is also your symptom when a module failed to load.

## layouts

Built-in list layouts: `table`, `cards`, `kanban`, `calendar`, `map`, `diagram` — plus whatever
loaded modules register (`ui-components.md`). Choose by what drives the question: kanban wants the
enum it groups by, calendar the date field, map the location, diagram the relations; when no axis
drives it, it is a table.

⚠ **`layout` is deliberately NOT validated at compile.** The rule: the engine validates a value iff
the ENGINE interprets it — and `layout` is opaque payload for whichever surface renders; only that
surface's registry knows which ids exist. (An allowlist used to live in compile, hardcoded to
mirror the extension's registry in a different repo. It was wrong both times it was tested, and it
rejected the sanctioned module path — a module-registered layout worked in the app while compile
refused the view naming it. Removed; decision 195.) The consequence for you: a typo'd layout
**renders anyway, degraded visibly to `table`** — so look at the surface, not just at compile ✔.

## filters

Filters are **operator objects**, never bare values: `{ status: { _eq: todo } }`, not
`{ status: "todo" }`. Semantics are the engine's one filter grammar: one-hop outbound reference
traversal, arrays any-match, and — the sharp edge — **an unknown field or a dangling ref narrows to
nothing** rather than erroring. A view's filter field names deserve the same care as code, because
the failure mode is a confidently empty page.

Two things compile DOES hold, because the engine interprets filters:

- **an unknown operator is a compile error** — a typo'd `_qe` fails loudly instead of silently
  narrowing at render;
- **`@me` is refused by name** — it died with the `users` collection in 0.8.0, expanded to a ref
  that can only match nothing, so compile names the fix (filter on a field this workspace owns; if
  a person is genuinely the axis, the workspace ships its own collection of people).

⚠ **`filter` goes one level up, never inside `options`.** `options` is an open bag, so
`options.filter` is accepted, saved, round-tripped — and read by nobody. Measured cost: a view drew
all 429 rows of a collection it was supposed to narrow to 90, with no error anywhere. Compile now
warns when an `options` key shadows a ui-view field (`options.filter is read by nothing`) — heed
it.

## options

Open by contract — each layout wants different settings, and unknown keys ride through untouched to
the surface. Keys are **snake_case**, declared by the layout that reads them — the built-in
kanban's axis is `group_by` (defaulting to the first enum field) — and the surface's own Layout
options panel writes exactly these keys, so a hand-written view and a panel-tuned one land on the
same record. A misspelled key is read by nobody, silently. The two edges that bite:

- ⚠ **`options.columns` REPLACES the descriptor's `list_fields`; it does not merge.** And a column
  naming a field the schema lacks is **dropped, not fallen back from** — which is how a core inbox
  view asking for `title` on a collection whose field is `name` rendered every row nameless with no
  error. Check the descriptor's real field names against every column you write.
- ⚠ **`options.sort` must be written even when empty** (`sort: ''`), or "unsorted" cannot
  round-trip and silently reverts to a fallback ordering on the next load. The CLI cannot express
  it (an empty `set-view` value removes the key) — hand-write it in the source.

Views are live records: a changed `filter` or `options` reaches an open tab on the next compile;
an unchanged view re-renders nothing.

## nav

`nav: { label, icon, order }` puts the view in the sidebar, above the collections, sorted by
`order`. Omit `nav` entirely for a route that should exist without advertising itself (a page you
link from elsewhere). Don't duplicate what the collections nav already offers: a view whose label
is just the collection's name, unfiltered, is the fallback wearing a second entry.

## default views vs named views

A collection's default presentation **is an ordinary ui-view record** — `default: true`. It is
what a bare `/content/<collection>` renders; it is **never its own route** and takes no `nav`
(registering a route for it would shadow the collection page with a redundant renderer). At most
one per collection. A named view is the same record shape with its own `path` and a `nav.label`.
One shape, one home, both agent-writable, both diffable in git.

## the CLI can write these

`dt schema add-view | set-view | rm-view` — `add-view` derives the record id from `path` with the
descriptor's own template, so a view saved from the CLI and one saved from the UI land on the
**same record**; `set-view <id>` takes dotted keys (`options.sort=-date`, `nav.label=Recent`). This is the one system-stored
kind with full CLI write support, because it goes through the same compile gate. Two edges:
`add-view` writes the **workspace module** — right for an operator's own daily surface; a view
that is part of a module's canonical shape belongs in that module's `ui-views/`, hand-written.
And a dotted `key=` with an **empty value removes the key**, so the one setting whose meaningful
value IS empty — `sort: ''` — must be hand-written in the source file (see options).

## common mistakes

| mistake | reality |
|---|---|
| a `layout` id you assumed exists | not validated at compile, on purpose — it degrades visibly to `table`; look at the surface |
| bare `collection: tasks` | qualified refs only |
| `filter: { status: "todo" }` | filters are operator objects: `{ status: { _eq: todo } }` |
| a filter using `@me` | gone in 0.8.0 with `users` — compile refuses it by name |
| `filter` written inside `options` | accepted, saved, read by nobody — compile warns; move it up |
| a column the schema does not have | dropped silently — the row loses that value with no error |
| omitting `sort` to mean unsorted | write `sort: ''` or the ordering reverts on reload |
| a ui-view that restates the built-in fallback | a record to maintain for zero gain |
| a `default: true` view with its own `path`/`nav` | the default IS the collection page — it never routes itself |
| a module ui-view naming one person | a hard-coded id resolves in no other workspace |
