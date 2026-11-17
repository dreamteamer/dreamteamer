#!/usr/bin/env node
// The released engine's command, where tools spawn it (`<engine>/bin/dreamteamer.js`): this engine's command line,
// plus `init`. A plain JavaScript entry for the same reason as src/api.js (an adapter exception to the house style).
import { init } from "../src/api/init.ts"
import { main } from "../src/cli/main.ts"

process.exitCode = process.argv[2] === "init" ? init(process.cwd()) : await main(process.argv.slice(2))
