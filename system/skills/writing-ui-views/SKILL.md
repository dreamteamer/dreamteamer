---
name: writing-ui-views
description: author ui-view records — route/nav/layout bindings the studio renders — for a collection's list, item, or a freestanding page
---

# writing ui views

a ui-view is a yaml record — `modules/<module>/system/ui-views/<name>.ui-view.yaml`; the
workspace's own go in the workspace module (`modules/hq3/system/ui-views/…` here).

**core principle:** a ui-view is a *binding, not code* — a route plus the id of an
already-registered layout. no build step, nothing to compile but the record.

## when to use

you want a named route, a nav entry, a default filter, or a non-default layout for a collection.

**not for:** the default browse experience — every collection already gets built-in fallbacks
(`/data/<collection>` table, `/data/<collection>/<id>` record page), so a ui-view that just
restates the fallback is noise. writing the component itself is `writing-ui-components`; adding
fields is `writing-collections`.

## read this first — the studio consumes these at boot

the studio reads compiled ui-view records on boot: a `nav` key becomes a sidebar entry (above the
collections), `path` becomes a live route, `target: list` renders the named `layout` over the
collection with `filter`/`options` applied (`@me` in a filter resolves to the current operator).
after authoring: `npm run compile`, hard-reload the studio. compile FAILS a `target: list` view
whose `layout` isn't registered (core `table`/`cards` + every module's declared
`dreamteamer.studio.layouts`), naming the registered set.

## shape

```yaml
path: /inbox
nav: { label: Inbox, icon: inbox, order: 1 }
target: list
collection: collections/tasks
layout: table
filter: { assignee: { _eq: "@me" } }        # @me = current user, resolved at render time
options: { columns: [title, status, due, run] }
```

| field | required | notes |
|---|---|---|
| `path` | yes | the route — `/inbox`, `/settings/collections` |
| `target` | yes | `list` (collection browse), `item` (single record page), or `page` (freestanding) |
| `layout` | yes | the id of a **registered** layout/list component (`table`, `cards`, …) |
| `collection` | for `list`/`item` | qualified ref: `collections/<name>` |
| `nav` | no | `label`/`icon`/`order` for the sidebar; omit for direct-link-only views (drilldowns) |
| `options` | no | layout-specific settings (e.g. `columns` for `table`) |
| `filter` | no | query object narrowing the collection; operator form `{ field: { _eq: value } }` |

references: the core module's `system/ui-views/inbox.ui-view.yaml` (a filtered `@me` list) and
`.../data-model.ui-view.yaml` (a plain unfiltered table).

## after writing

`npm run compile`, then `npm run check` — it validates required fields and that the
`collection` ref resolves. compile validates `layout` for `target: list` views against the
registered set (core + module-declared `dreamteamer.studio.layouts`) and fails loudly on a miss;
`target: item`/`page` layouts are not compile-checked — confirm those ids against the module's
studio registry (see `writing-ui-components`) before naming them.

## common mistakes

| mistake | reality |
|---|---|
| a `layout` id you assumed exists | check won't catch it; the view silently renders nothing. verify in `register-defaults.ts`. |
| bare `collection: tasks` | qualified refs only: `collections/tasks`. |
| `target: list` with no `collection` | required for `list`/`item`; only `page` may omit it. |
| a ui-view that duplicates the built-in fallback | adds a record to maintain for zero gain. |
| `filter: { assignee: "@me" }` | filters are operator objects: `{ assignee: { _eq: "@me" } }`. |
| a module ui-view filtered to a named user | use `@me`; a hard-coded `users/<id>` breaks in other workspaces. |
| CLI-editing a ui-view (`dt ui-views set …`) | system-stored — the CLI refuses. edit the source, then compile. |
| telling the operator the studio now shows it | it doesn't, until slice 7. say so. |
