# ui-views

`modules/<module>/system/ui-views/<name>.ui-view.yaml`. **A ui-view is a binding, not code** — a
route plus the id of an already-registered layout, plus how to shape the data. Nothing to build.

The surface reads compiled ui-view records at boot: `nav` becomes a sidebar entry, `path` becomes a
live route, `target: list` renders the named `layout` over the collection with `filter`/`options`
applied (`@me` resolves to the current operator). After authoring: compile, then reload the surface.

```yaml
path: /inbox
nav: { label: Inbox, icon: inbox, order: 1 }
target: list
collection: collections/tasks
layout: table
filter: { assignee: { _eq: "@me" } }        # operator objects, never a bare value
options: { columns: [name, status, due, run], sort: -due }
```

| field | required | notes |
|---|---|---|
| `path` | yes | the route — `/inbox`, `/views/meetings/recent` |
| `target` | yes | `list`, `item`, or `page` (freestanding) |
| `layout` | yes | the id of a **registered** layout (`table`, `cards`, `kanban`, `calendar`, `map`, + module-declared) |
| `collection` | for `list`/`item` | qualified: `collections/<name>` |
| `nav` | no | `label`/`icon`/`order`; omit for direct-link-only views |
| `default` | no | `true` makes this the collection's DEFAULT view at `/content/<collection>` |

## default views vs named views

A collection's default presentation **is an ordinary ui-view record** — `default: true`, path
`/content/<collection>`. A named view is the same record with its own path plus a `nav.label`. One
shape, one home, both agent-writable and both diffable in git.

⚠ **A view's `options.columns` REPLACES the descriptor's `list_fields`; it does not merge.** And a
column naming a field the schema lacks is **dropped, not fallen back from** — which is how a core
inbox view asking for `title` on a collection whose field is `name` rendered every row nameless with
no error. Check the descriptor's real field names against every column you write.

⚠ **`options.sort` must be written even when empty** (`sort: ''`), or "unsorted" cannot round-trip
and silently reverts to a fallback ordering on the next load.

## the CLI can write these

`dt ui-views add|set|rm` — `set` takes dotted keys (`options.sort=-date`) and derives the record id
with the descriptor's own template, so a view saved from the CLI and one saved from the UI land on
the **same record**. This is the one system-stored kind with full CLI write support, because it goes
through the same compile gate.

## common mistakes

| mistake | reality |
|---|---|
| a `layout` id you assumed exists | compile validates it only for `target: list`; otherwise the view renders nothing |
| bare `collection: tasks` | qualified refs only |
| `filter: { assignee: "@me" }` | filters are operator objects: `{ assignee: { _eq: "@me" } }` |
| a column the schema does not have | dropped silently — the row loses that value with no error |
| a ui-view that restates the built-in fallback | a record to maintain for zero gain |
| a module ui-view filtered to a named user | use `@me`; a hard-coded id breaks elsewhere |
