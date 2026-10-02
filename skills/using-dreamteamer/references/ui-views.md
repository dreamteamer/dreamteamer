# ui-views — a question, saved as a route

`modules/<module>/ui-views/<name>.ui-view.yaml`. **A ui-view is a named variant of a collection's
default view, not code** — a route, a scope, a filter, and the `display` keys it changes. The
default view itself is the collection's own `display` block (`collections.md`); a view states only
what differs from it. Nothing to build.

The reader who matters most is not you and not the surface: it is the **operator**, whose recurring
question this record encodes. A good view is a question they stopped having to re-ask ("which
prescriptions are still running", "what landed this week"); a bad view is a nav entry they scroll
past. The surface reads compiled ui-view records at boot *and on every change* — `display.nav`
becomes a sidebar entry, `route` a live route, and an edited view reaches an already-open tab on
the next compile.

| the question | read |
|---|---|
| does this view deserve to exist | when a view earns existence |
| the record and its keys | anatomy |
| a list, one record, or a page | scopes |
| what the view inherits | display, merged |
| which layout | layouts |
| narrowing the rows | filters |
| layout settings | options |
| writing views from the CLI | the verbs |

## when a view earns existence

The default rendering — the collection's `display.list` over the whole collection — needs no view.
A *named* view exists to be **different** from it. One earns its keep when:

- it encodes a **recurring question** (`/health/visits/today`) — the operator asks it daily, and
  the filter is the answer;
- a **different layout genuinely fits the data** — kanban when a status enum drives work, calendar
  when a date field is the axis, map when records carry locations, diagram when the relations are
  the point;
- a filtered slice is **someone's daily surface** — the first thing opened, worth one keystroke.

One view per recurring question, not one per mood: each is a nav line and a record to maintain. A
view whose display only restates the collection's is maintenance for zero gain — change the
collection's `display` instead.

## anatomy

```yaml
# modules/clinic/ui-views/visits-today.ui-view.yaml
name: visits-today
title: Today
description: The visits booked for today, as a board by status.
route: /health/visits/today
scope: collection
collection: collections/health/visits
filter:
  date:
    _eq: $today
display:
  nav:
    title: Today
    icon: calendar
    order: 1
  list:
    layout: kanban
    columns: [reason, patient, doctor, status]
    options:
      lanes_by: status
      card_title: '{{ reason }} · {{ patient }}'
```

| key | required | notes |
|---|---|---|
| `route` | yes | the path, starting with `/`. The id derives from it, so a view saved from the CLI and one saved from a surface land on the **same record** |
| `scope` | yes | `collection`, `record` or `page` (below) |
| `collection` | for `collection`/`record` | qualified: `collections/<name>` |
| `filter` | no | the saved narrowing — see filters |
| `display` | no | the keys it changes, in the collection's own blocks — see display, merged |
| `name` · `title` · `description` | no | a handle for readers of the source · the heading a surface draws · what it shows and for whom |

Any other key is a compile error naming the list — `default`, `path`, `target`, `layout` and
`options` at the top level included: a view is always a named variant, and layout and options live
inside `display`.

## scopes

- **`collection`** — the collection's rows through `display.list`, `filter` applied. The everyday
  case.
- **`record`** — one record of `collection`, through `display.record`.
- **`page`** — a freestanding page with no collection: `display.list.layout` names a registered
  **app**, whose **first declared route's** component renders at `route` (list the index route
  first). An unregistered name renders a visible "not registered" placeholder — never a blank page
  — which is also your symptom when a module failed to load.

## display, merged

A view's `display` carries the collection's four blocks — `nav` (`title` · `icon` · `order`),
`list` (`layout` · `columns` · `sort` · `options`), `record` (`layout` · `subtitle` · `badge` ·
`color_by` · `options`), `form` (`sections`). Compile merges it over the collection's **sub-block by
sub-block**: a sub-block the view omits is the collection's, a key the view sets wins. `nav` is the
one exception — a view with no `nav` has no sidebar entry, so the collection's is not inherited;
omit it for a route you link from elsewhere. The merged result is the view's `compiled.display`,
which is what a surface draws.

Every field a view names — columns, sort, badge, color_by, sections, the filter's fields, a
field-taking option, a template's tokens — is checked against the collection, and a missing one is
a compile error naming the position. (`group_title` and `group_summary` are checked against the
collection the rows are grouped BY.)

## layouts

Built-in list layouts: `table`, `cards`, `kanban`, `calendar`, `map`, `diagram` — plus whatever
loaded modules register (`ui-components.md`). Choose by what drives the question: kanban wants the
enum it lanes by, calendar the date field, map the location, diagram the relations; when no axis
drives it, it is a table.

⚠ **`layout` is not validated at compile.** The engine validates a value only where it interprets
it, and a layout id is opaque payload for whichever surface renders it; only that surface's
registry knows which ids exist. A typo'd layout **renders anyway, degraded visibly to `table`** — so
look at the surface, not just at compile ✔.

## filters

Filters are **operator objects**, never bare values: `{ status: { _eq: seen } }`, not
`{ status: "seen" }`. Semantics are the engine's one filter grammar — one-hop outbound reference
traversal, arrays any-match — and two value tokens: `$today` (the local date) and `$now` (the local
instant). Compile holds three things, because the engine interprets filters:

- **an unknown operator is a compile error** — a typo'd `_qe` fails loudly;
- **an unknown value token is a compile error** — any `$word` but the two;
- **a field the collection lacks is a compile error** — a nested key under a reference is the
  target's field, which only that collection can judge, so it is not checked.

⚠ **`filter` sits at the top of the view, never inside `options`.** `options` is open, so
`display.list.options.filter` would be read by nobody; compile warns on any option key that shadows
a view key or a key of the block (`options.columns`, `options.sort` — those live one level up).

## options

Open by contract — each layout wants different settings, and unknown keys ride through untouched to
the surface. Keys are **snake_case**, declared by the layout that reads them; an option taking a
field is named for its role (`group_by`, `lanes_by`, `color_by`, `start`, `end`, `lat`, `lng`) and
one taking a template for what it labels (`card_title`, `bar_title`, `group_title`,
`group_summary`) — both are checked. A misspelled key of any other name is read by nobody,
silently. Two edges:

- ⚠ **`display.list.columns` REPLACES the collection's columns; it does not merge.** Name every
  column the view should show.
- **An empty `sort` is a value**: `display.list.sort: ''` states unsorted and overrides the
  collection's sort, where omitting the key inherits it.

## the verbs

`dt add ui-views --route /people/recent --scope collection --collection collections/people
display.list.layout=cards`, `dt set ui-views/<id> <dotted.key>=<value>`, `dt rm ui-views/<id>`
— all through the compile gate, committing themselves. `add` derives the record id from `route`,
so a view saved from the CLI and one saved from a surface land on the **same record**. Three edges:

- **`add` writes the workspace module** — right for an operator's own daily surface; a view that
  is part of a module's canonical shape belongs in that module's `ui-views/`, hand-written.
- **A list value takes the comma spelling** for `display.list.columns` and the `ref_fields` /
  `value_fields` options (`display.list.columns=name,status`) or the JSON form; any other option
  keeps its commas as characters.
- **An empty value REMOVES the key**, so the setting whose meaningful value IS empty is written
  QUOTED: `'display.list.sort=""'`. A value holding a template is quoted the same way:
  `'display.list.options.card_title="{{ name }}"'`.

## common mistakes

| mistake | reality |
|---|---|
| a `layout` id you assumed exists | not validated at compile — it degrades visibly to `table`; look at the surface |
| bare `collection: tasks` | qualified refs only: `collections/tasks` |
| `filter: { status: "seen" }` | filters are operator objects: `{ status: { _eq: seen } }` |
| a filter on a date "today" written as a literal | `$today` — a literal goes stale the next morning |
| `filter` written inside `options` | read by nobody — compile warns; move it up |
| a view to change the collection's default columns | edit the collection's `display.list` — every surface follows |
| omitting `nav` and expecting a sidebar entry | a view's nav is never inherited |
| a module ui-view naming one person | a hard-coded id resolves in no other workspace |
