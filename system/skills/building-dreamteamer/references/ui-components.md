# ui components

**Components are prebuilt code, not records.** There is no ui-components collection, no descriptor,
no compile step for the component itself. This is an ordinary Vue coding session against a module's
`studio/` source tree — *code registers everything renderable; yaml records configure and assemble.*

⚠ **Reach for a record first.** A `ui-view` pointing an existing `layout`/`edit`/`view` id at your
data costs no build and no code to maintain. Write a component only when nothing registered can do
the job.

## the registries

| registry | what it holds | bound by |
|---|---|---|
| `edits` | field editors + whole-record Edit pages | a field's `edit` meta; `scope: 'record'` for a page |
| `views` | field read-renderers + whole-record View pages | a field's `view` meta |
| `lists` | collection browse arrangements (table, cards, kanban, …) | a `ui-view` record's `layout` |
| `apps`, `panels`, `operations` | routed subtrees, dashboard panels, flow operations | registration alone |

The host's own built-ins register through the exact same door a module uses — read its
`register-defaults.ts` as the reference.

## the module contract

A module ships a browser entry (`studio/app.js`, or a built `studio/dist/app.js`) that compile stages
to `.dreamteamer/ui/<module>/app.js`; its **default export** is a register function:

```js
export default ({ registerEdit, registerView, registerList, registerApp, registerPanel }) => {
  registerList({ id: 'kanban', name: 'Kanban', component: MyKanban, fillsHeight: true });
};
```

- **Never bundle Vue.** The host exposes its own Vue as `window.Vue` *before* importing any module
  entry; two copies break reactivity silently. Use `window.Vue`, or mark `vue` external and map it to
  the global.
- **Give every entry an explicit stable `id`.** That string is what a `ui-view.layout` or a field's
  `edit`/`view` meta names. Changing it breaks every binding.
- **`types: []` opts an Edit/View out of kind-inference.** A non-empty `types` array makes it a *kind
  default* for that wire type — which means a bare `string` or `json` field anywhere in the workspace
  silently gets your bespoke widget. Most custom components should stay `types: []`.
- **`fillsHeight: true`** declares that this List owns its own scrolling; the page then stops
  scrolling vertically and hands the List the leftover height. Layouts that should grow the page
  (table, cards) must not set it.
- **Failures are isolated, not surfaced.** A module whose entry fails to import or throws while
  registering is caught, warned and skipped — the surface still loads, your component just never
  appears. **Read the browser console**; nothing else will tell you.

⚠ **A module registering a CORE id WINS, silently.** Module bundles load after the built-ins and the
registry is a `Map.set`, so a module `kanban` shadows the core `kanban` with no warning anywhere —
which once meant an operator had been using a strictly worse board for weeks and nothing could reveal
it from the outside. Never reuse a core id unless shadowing is exactly what you mean.

⚠ **Portalled UI cannot rely on scoped CSS.** Menus, popovers and dialogs are teleported outside the
component subtree, so a scoped rule looks correct in the source and is simply absent at runtime — the
failure mode is invisible chrome, not an error. Define those styles globally.

## workflow

1. Write the component in the module's `studio/` tree.
2. Register it in that module's `app.js` with a stable `id`.
3. Plain-JS `app.js` needs no build; a module wanting a toolchain builds to `studio/dist/app.js`
   itself. Declare any Lists in `package.json` `dreamteamer.studio.layouts`, then compile to stage it.
4. Look at it in the real surface.
5. **Bind it** — a field's `edit`/`view` meta, or a `ui-view.layout` naming the `id`. Only this step
   touches records.

## common mistakes

| mistake | reality |
|---|---|
| looking for a ui-components collection | there isn't one; this is code |
| bundling Vue | two copies; reactivity dies silently |
| assuming a registration error is reported | swallowed by fault isolation — read the console |
| `types: ['string']` on a bespoke widget | it becomes the default for every plain string field |
| omitting `id`, or renaming it later | the id is the binding surface |
| binding before building | the id does not exist yet; the view renders nothing |
| reusing a core layout id | silently shadows the built-in with no warning |
