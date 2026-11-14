# Extending dreamteamer

dreamteamer is modular: you extend it by adding modules. Below, `dt` is short for `npx dreamteamer`.

## Writing a module

A module is one npm package with a `dreamteamer` block, and the engine is all it needs:
`dt add modules --name acme --extension --package @acme/acme` scaffolds a publishable one inside any
workspace, its tests run on the real engine through `import … from 'dreamteamer/testing'`, and
`dt check modules/acme --alone` says whether it is publishable before you `npm publish`
([`references/writing-a-module.md`](skills/using-dreamteamer/references/writing-a-module.md)).
