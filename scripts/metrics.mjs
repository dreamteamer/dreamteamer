#!/usr/bin/env node
// Size and complexity of the engine, measured so "keep core lean" can be a number instead of a
// feeling.
//
//   node scripts/metrics.mjs            report
//   node scripts/metrics.mjs --check    report + exit 1 if anything grew past its budget
//   node scripts/metrics.mjs --update   rewrite metrics.json from reality (the deliberate act)
//
// WHY A BUDGET AND NOT JUST A REPORT: every addition to core arrives with a good local reason, and
// nothing ever argues for removal. A budget makes growth cost a conversation. `--check` failing is
// not "you did something wrong" — it is "say out loud why core is the right home for this."
//
// The complexity number is DELIBERATELY CRUDE: decision points per file (branch keywords), not a
// real cyclomatic analysis. It exists to catch a file quietly becoming the place where everything
// happens, which it does well enough at this scale. Do not add a dependency to make it precise.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'metrics.json');
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const UPDATE = args.includes('--update');

function walk(dir, pred, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (name.startsWith('.') || name === 'node_modules') continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, pred, out);
		else if (pred(p)) out.push(p);
	}
	return out;
}

// Code lines = non-blank, non-comment. Comments are counted separately and on purpose: heavy
// commenting is how this codebase records WHY, and penalising it would push the reasoning out of the
// file and into a log nobody reads.
function measureJs(file) {
	const lines = readFileSync(file, 'utf8').split('\n');
	let code = 0, comment = 0, blank = 0, block = false;
	for (const raw of lines) {
		const l = raw.trim();
		if (block) { comment++; if (l.includes('*/')) block = false; continue; }
		if (!l) { blank++; continue; }
		if (l.startsWith('//')) { comment++; continue; }
		if (l.startsWith('/*')) { comment++; if (!l.includes('*/')) block = true; continue; }
		code++;
	}
	const body = readFileSync(file, 'utf8');
	const decisions = (body.match(/\b(if|for|while|case|catch)\s*\(|\?\?|&&|\|\||\?\./g) ?? []).length;
	return { code, comment, blank, decisions };
}

const jsFiles = [...walk(join(ROOT, 'src'), (p) => extname(p) === '.js'),
	...walk(join(ROOT, 'bin'), (p) => extname(p) === '.js')];

const perFile = jsFiles.map((f) => ({ file: relative(ROOT, f), ...measureJs(f) }))
	.sort((a, b) => b.code - a.code);

const codeTotal = perFile.reduce((n, f) => n + f.code, 0);
const commentTotal = perFile.reduce((n, f) => n + f.comment, 0);
const decisionsTotal = perFile.reduce((n, f) => n + f.decisions, 0);

// The system/ surface is the OTHER half of core's size — and the half that grows by accident,
// because adding a skill feels free. Prose lines are counted because a skill nobody can afford to
// load is not a capability.
const sysDir = join(ROOT, 'system');
const countIn = (kind, ext) => walk(join(sysDir, kind), (p) => p.endsWith(ext)).length;
const skillFiles = walk(join(sysDir, 'skills'), (p) => p.endsWith('.md'));
const skillProse = skillFiles.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
const entryProse = walk(sysDir, (p) => p.endsWith('.md') || p.endsWith('.yaml'))
	.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);

const now = {
	code: { total: codeTotal, comments: commentTotal, decisions: decisionsTotal, files: perFile.length },
	surface: {
		collections: countIn('collections', '.collection.yaml'),
		'collection-templates': countIn('collection-templates', '.collection-template.yaml'),
		skills: readdirSync(join(sysDir, 'skills')).filter((n) => !n.startsWith('.')).length,
		agents: countIn('agents', '.agent.md'),
		'ui-views': countIn('ui-views', '.ui-view.yaml'),
		commands: existsSync(join(sysDir, 'commands')) ? countIn('commands', '.command.md') : 0,
	},
	prose: { 'skill-lines': skillProse, 'system-lines': entryProse },
};

const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`\n  dreamteamer core — size & complexity\n`);
console.log(`  CODE   ${now.code.total} lines in ${now.code.files} files`
	+ `   (+${now.code.comments} comment lines, ${(now.code.comments / now.code.total).toFixed(2)} ratio)`);
console.log(`         ${now.code.decisions} decision points`
	+ `   ${(now.code.decisions / now.code.total * 100).toFixed(1)} per 100 code lines\n`);

console.log(`  the five biggest files`);
for (const f of perFile.slice(0, 5)) {
	console.log(`    ${pad(f.file, 30)} ${num(f.code, 5)} code  ${num(f.decisions, 4)} decisions`
		+ `  ${num((f.decisions / Math.max(f.code, 1) * 100).toFixed(0), 3)}/100`);
}

console.log(`\n  SURFACE (what a workspace inherits by installing the engine)`);
for (const [k, v] of Object.entries(now.surface)) console.log(`    ${pad(k, 22)} ${num(v, 4)}`);
console.log(`\n  PROSE  ${now.prose['skill-lines']} lines of skill`
	+ `   ${now.prose['system-lines']} lines of system/ total`);

let failed = 0;
if (base?.budgets) {
	console.log(`\n  BUDGETS`);
	const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) =>
		typeof v === 'object' ? flat(v, `${pre}${k}.`) : [[`${pre}${k}`, v]]);
	const cur = Object.fromEntries(flat(now));
	for (const [key, budget] of Object.entries(base.budgets)) {
		const v = cur[key];
		if (v === undefined) continue;
		const over = v > budget;
		if (over) failed++;
		console.log(`    ${over ? '✖' : '✔'} ${pad(key, 30)} ${num(v, 5)} / ${num(budget, 5)}`
			+ (over ? `   OVER by ${v - budget}` : ''));
	}
	if (failed) {
		console.log(`\n  ${failed} budget(s) exceeded. This is the conversation, not the error:`);
		console.log(`    · Is this engine-level, or is it a recipe creeping into core?`);
		console.log(`      Test: does the ENGINE read it? (the three questions are in CLAUDE.md)`);
		console.log(`    · Could it live in a module instead, and be copied by whoever wants it?`);
		console.log(`    · If it genuinely belongs here, raise the budget IN THE SAME COMMIT`);
		console.log(`      (\`node scripts/metrics.mjs --update\`) so the growth is a recorded decision.`);
	}
}

if (base && !UPDATE) {
	const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) =>
		typeof v === 'object' ? flat(v, `${pre}${k}.`) : [[`${pre}${k}`, v]]);
	const prev = Object.fromEntries(flat({ code: base.code, surface: base.surface, prose: base.prose }));
	const cur = Object.fromEntries(flat(now));
	const moved = Object.entries(cur).filter(([k, v]) => prev[k] !== undefined && prev[k] !== v);
	if (moved.length) {
		console.log(`\n  SINCE ${base.measured ?? 'the baseline'}`);
		for (const [k, v] of moved) {
			const d = v - prev[k];
			console.log(`    ${d > 0 ? '▲' : '▼'} ${pad(k, 30)} ${num(prev[k], 5)} → ${num(v, 5)}  (${d > 0 ? '+' : ''}${d})`);
		}
	}
}

if (UPDATE) {
	// Budgets are set at reality + headroom, not at reality: a budget equal to the current number
	// fails on the next honest refactor and trains people to run --update reflexively.
	const head = (n) => Math.ceil(n * 1.1);
	const out = {
		measured: new Date().toISOString().slice(0, 10),
		note: 'Budgets are ceilings with ~10% headroom. Raising one is a deliberate act — do it in the same commit as the growth, and say why in the message.',
		...now,
		budgets: {
			'code.total': head(now.code.total),
			'code.decisions': head(now.code.decisions),
			'surface.collections': now.surface.collections,
			'surface.skills': now.surface.skills,
			'surface.agents': now.surface.agents,
			'prose.skill-lines': head(now.prose['skill-lines']),
		},
	};
	writeFileSync(BASELINE, JSON.stringify(out, null, '\t') + '\n');
	console.log(`\n  ✔ wrote ${relative(ROOT, BASELINE)} — commit it with the change that moved it.`);
}

console.log('');
process.exit(CHECK && failed ? 1 : 0);
