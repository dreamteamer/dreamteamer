# ui components — code, behind the same registry the built-ins use

**Components are prebuilt code, not records.** There is no ui-components collection, no descriptor,
no compile step for the component itself. This is an ordinary Vue coding session against a module's
`ui/` source tree — *code registers everything renderable; yaml records configure and assemble.*

A component is the highest-leverage and highest-cost UI artifact a module ships: it renders for
every matching record in every workspace that installs the module, and it keeps needing a
maintainer long after the session that wrote it. So the ladder runs from cheap to expensive, and
you climb only as far as the job forces you:

| you want | try first |
|---|---|
| a different control for a field | the **descriptor** — shape drives the control (`data-modeling.md` Part VII: enum → dropdown, array → chips, `x-body` → the page) |
| a different arrangement of a collection | a **ui-view** with a registered layout (`ui-views.md`) |
| the same layout, tuned | the view's `options` |
| a rendering or editing behaviour nothing registered has | **component code** — this reference |

| the question | read |
|---|---|
| what kinds of component exist | the registries |
| how the surface picks a component | resolution |
| what a module ships | the module contract |
| the sharp edges | design rules |
| build → see → bind | workflow |

## the registries

| registry | what it holds | bound by |
|---|---|---|
| `edits` | field editors, **and whole-record Edit pages** (`scope: 'record'`) | a field's resolved edit id; record pages via presets |
| `views` | field read-renderers, and whole-record View pages | a field's resolved view id; record pages via presets |
| `lists` | collection browse arrangements (table, cards, kanban, …) | a `ui-view` record's `layout` |
| `apps` | routed subtrees + a nav icon (mounted under `/a/<id>`) | registration alone; a `page`-target ui-view can name one |
| `panels`, `operations` | dashboard panels, flow operations | registration alone |

"A record page is an Edit/View too": the built-in record pages (`form`, `doc`, `properties`,
`data-model`) are ordinary registry entries with `scope: 'record'`. The host's own built-ins
register through the exact same door a module uses — read its `register-defaults.ts` as the
reference implementation for everything on this page.

## resolution — how the surface picks a component

For a **field**, the chain is: the explicit edit/view id on the field's presentation row → the
**kind default** for the field's wire type → the ultimate fallback (`input` / `text`). Two facts
worth internalizing:

- **The explicit ids are derived by the engine, not authored.** The presentation projection maps
  descriptor shape to component ids (enum → `select-dropdown`, string array → `tags`, object array
  → `list`, `x-body` → the markdown editor…). You change a field's control by changing its
  *shape*, not by naming a widget in the descriptor.
- **The kind-default maps are module-extensible**: `registerKindDefault('view', 'geometry', 'map')`
  makes your component the default for a wire type across the whole workspace without touching
  core resolution.

Every miss in the chain **degrades with a reported reason, never a blank** — the same posture as
everything else on this page.

For a **collection browse**, a `ui-view.layout` names a List id (unregistered → visible degrade to
`table`). For a **record page**, preset records pick a record-scoped Edit/View (built-in default:
`properties`), workspace-local default beating a module-shipped one.

So a module has three binding surfaces, none of which is "edit a descriptor": a ui-view's `layout`
for a browse, `registerKindDefault` for all fields of a wire type, and a preset default for record
pages.

## the module contract

A module ships a browser entry — `ui/app.js` (plain JS, host-provided Vue) or a built
`ui/dist/app.js` (which wins when both exist; `studio/` is the legacy folder name and still
accepted). Compile stages it to `.dreamteamer/ui/<shortName>/app.js` — shortName is the package
name made url-safe (`@a/crm` → `a--crm`; a collision fails compile) — and the surface
dynamic-imports every staged entry at boot. The **default export** is a register function:

```js
export default ({ registerEdit, registerView, registerList, registerApp, registerPanel,
                  registerKindDefault, router }) => {
  registerList({ id: 'burndown', name: 'Burndown', component: MyBurndown, fillsHeight: true });
};
```

- **Never bundle Vue.** The host exposes its own Vue as `window.Vue` *before* importing any module
  entry; two Vue copies break reactivity silently. Use `window.Vue`
  (`const { defineComponent, h } = window.Vue`), or mark `vue` external and map it to the `Vue`
  global in a lib-mode build.
- **`router` is handed to you** because a module component cannot
  `import { useRouter } from 'vue-router'` — only Vue itself is host-exposed. Use it for
  programmatic navigation.
- **`registerApp` routes mount under `/a/<id>`** — a module route `path: 'board'` resolves at
  `/a/<id>/board`, `path: ''` is the app index. A `page`-target ui-view renders the app's **first
  declared route**, so list the index first.
- A UI bundle **is** a module contribution: a module that ships only a layout is a legitimate
  module.

## design rules — the sharp edges

- **Give every entry an explicit, stable `id`.** That string is the entire binding surface — every
  ui-view `layout`, preset and kind default names it. Renaming it breaks all of them, silently.
- **`types` advertises picker candidacy — it never sets a default.** A non-empty `types` array
  offers your Edit/View in the field designer's picker for those wire types; the *actual* kind
  defaults live in one place — the kind-default maps, changed only by `registerKindDefault` (or by
  shadowing an id). `types: ['string']` on a bespoke widget therefore clutters the picker for
  every plain string field without changing any rendering. Keep custom components `types: []` and
  bind them deliberately.
- ⚠ **A module registering a CORE id WINS, silently.** Module bundles load after the built-ins and
  the registry is a `Map.set`, so a module `kanban` shadows the core `kanban` with no warning
  anywhere — which once meant an operator used a strictly worse board for weeks and nothing could
  reveal it from the outside. Never reuse a core id unless shadowing is exactly what you mean.
- **`fillsHeight` declares who owns scrolling.** `true` means the List gets a height-constrained
  box and scrolls its own innards — the kanban needs it (full-height columns, pinned headers) and
  so does the table (a sticky `<thead>` is only sticky against a scroll box the List owns; it is
  what keeps the pager on screen). Layouts that should grow the page (cards, calendar, map) must
  not set it. The wrong value shows up as double scrollbars, or a pager a page-scroll away.
- **Failures are isolated, not surfaced.** A module whose entry fails to import or throws while
  registering is caught, warned and skipped — the surface still loads, your component just never
  appears. **Read the browser console**; nothing else will tell you. (The visible symptom
  elsewhere: a `page` ui-view rendering its "not registered" placeholder.)
- ⚠ **Portalled UI cannot rely on scoped CSS.** Menus, popovers and dialogs are teleported outside
  the component subtree, so a scoped rule looks correct in the source and is simply absent at
  runtime — the failure mode is invisible chrome, not an error. Define those styles globally.
- **Settings are declared, not hand-built.** An entry's `options` is a list of field definitions
  drawn by the same machinery that draws records — an extension never builds bespoke settings UI.
  Use each option's `when:` predicate to show it only when the current values make it relevant:
  half a flat settings panel is inert at any moment, and *hidden beats disabled* — a disabled
  control still occupies the eye with a question it cannot answer.

## workflow

1. **Write** the component in the module's `ui/` tree.
2. **Register** it in that module's `app.js` with a stable `id`. Plain-JS `app.js` needs no build;
   a module wanting a toolchain builds to `ui/dist/app.js` itself. (No `package.json` declaration
   is needed — a `studio.layouts` allowlist once existed, had zero users ever, and was removed;
   unregistered ids degrade visibly instead. Decision 195.)
3. **Compile** — that stages the bundle into the runtime.
4. **Look at it in the real surface** — reload the window so boot re-imports the staged bundle,
   and open the console before deciding it "didn't work".
5. **Bind it** — a ui-view's `layout`, a `registerKindDefault` call, or a preset default. Only
   this step touches records.

## common mistakes

| mistake | reality |
|---|---|
| looking for a ui-components collection | there isn't one; this is code |
| naming a widget in a descriptor | field controls are derived from shape — change the shape, or register a kind default |
| bundling Vue | two copies; reactivity dies silently |
| assuming a registration error is reported | swallowed by fault isolation — read the console |
| `types: ['string']` on a bespoke widget | it is offered in the picker for every string field — candidacy, not default; defaults change only via `registerKindDefault` |
| omitting `id`, or renaming it later | the id is the binding surface; every record naming it breaks |
| reusing a core layout id | silently shadows the built-in with no warning |
| declaring layouts in `package.json` | retired (decision 195) — registration in `app.js` is the whole mechanism |
| binding before building | the id does not exist yet; the view degrades to `table` |
| scoped CSS on a menu or dialog | portalled outside the subtree — style those globally |
