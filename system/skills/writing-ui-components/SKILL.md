---
name: writing-ui-components
description: develop a studio component (Edit, View, List, App, or Panel) — a normal coding session against a module's studio/ source, not a record
---

# writing ui components

**core principle:** studio components are **prebuilt module code, not records.** there is no
ui-components collection, no descriptor, no `npm run compile` step. this is an ordinary Vue
coding session against a module's `studio/` source tree — "code registers everything renderable;
yaml records configure and assemble".

## when to use

the operator wants a rendering or editing behaviour the built-ins don't have: a kanban browse, a
bespoke field editor, a module app in the ModuleBar, a panel.

**not for:** routing / nav / default-layout choices (`writing-ui-views` — a record), field shape
or field metadata (`writing-collections`), or anything achievable by pointing an existing
`layout`/`edit`/`view` id at a field. reach for the record first; write code only when nothing
registered can do the job.

## the registries — `studio/src/registry/index.ts`

| registry | what it holds | bound by |
|---|---|---|
| `edits` | field editors + whole-record Edit pages | a field's `edit` meta; `scope: 'record'` for a page |
| `views` | field read-renderers + whole-record View pages | a field's `view` meta |
| `lists` | collection browse arrangements (table, cards, …) | a `ui-view` record's `layout` |
| `apps` | ModuleBar entries — an icon + a routed subtree, mounted at `/a/<id>` | registration alone |
| `panels`, `operations` | dashboard panels, flow operations | registration alone |

the studio repo (`@dreamteamer/studio`, a `git_modules/dreamteamer-studio` clone when developing) is the reference app: its own built-ins register through the exact
same door a module uses — read `studio/src/registry/register-defaults.ts`.

## the module contract — `studio/src/modules.ts`

a module ships a prebuilt browser entry (`app.js`, listed by the server at `/server/info`) whose
**default export** is a register function taking the registry API:

```js
// app.js
export default ({ registerEdit, registerView, registerList, registerApp, registerPanel, registerKindDefault }) => {
  registerList({ id: 'kanban', name: 'Kanban', component: MyKanban });
};
```

- **never bundle Vue.** the host exposes its own Vue as `window.Vue` *before* importing any
  module entry; two copies break reactivity. use `window.Vue`, or mark `vue` external and map it
  to the `Vue` global in your bundler config.
- **give every entry an explicit stable `id`** — that string is what a `ui-view.layout` or a
  field's `edit`/`view` meta names. changing it breaks every binding.
- **`types: []` opts an Edit/View out of kind-inference** (explicit bindings only). a non-empty
  `types` array makes it a *kind default* candidate for that wire type — read the comments in
  `register-defaults.ts` for why most custom components should stay `types: []`: a bare
  `string`/`json` field silently defaulting to your bespoke widget is almost always wrong.
- **failures are isolated, not surfaced**: a module whose entry fails to import or throws while
  registering is caught, warned and skipped. the studio still loads; your component just never
  appears. **check the browser console** — nothing else will tell you.

## workflow

1. write the component in the module's studio source — Vue SFCs alongside the existing `edits/`,
   `views/`, `lists/`, `components/` when working inside the studio source; a separate
   module ships its own tree.
2. register it in that module's `app.js` (or `register-defaults.ts` for a core built-in) with a
   stable `id`.
3. build: `npm run build:studio` for the reference app; a separate module runs its own build to
   produce the `app.js` the server lists.
4. serve and look at it: `npm run --silent dt -- start [--port <n>]` → studio at
   `http://localhost:8080/admin` (it 503s with a build hint if step 3 was skipped).
5. bind it — a field's `edit`/`view` meta, or a `ui-view.layout` naming the `id`
   (`writing-ui-views`). **only this step touches records.**

## common mistakes

| mistake | reality |
|---|---|
| looking for a ui-components collection / descriptor | there isn't one. this is code. |
| bundling Vue into the module entry | two Vue copies; reactivity dies silently. use `window.Vue`. |
| assuming a registration error will be reported | it's swallowed by fault isolation. read the console. |
| `types: ['string']` on a bespoke widget | it becomes the default for every plain string field. use `types: []`. |
| omitting `id`, or renaming it later | the id is the binding surface; every `layout`/`edit`/`view` reference breaks. |
| skipping the build | the studio imports the built `app.js`, not your source. |
| binding before building | the id doesn't exist yet; the view renders nothing. |
| writing a component when an existing layout would do | prefer a `ui-view` record — no build, no code to maintain. |
