// ${env:KEY} / ${workspaceFolder} / ${userHome} — VS Code's variable grammar, three variables.
// Values render ONLY on explicit request (dt resolve); records are never auto-substituted.
// parseEnvValues reads .env TEXT only (never shell-evaluates). A QUOTED value (single or double)
// may span multiple lines — the closing quote just has to end some later line, not the one it
// opened on — because `[^"\\]`/`[^']` match newlines in JS regex same as any other character.
// An UNQUOTED value is line-bound: it runs to end of line, so it can't span lines.
// Two accepted non-goals, unchanged on purpose: `KEY =value` (space before `=`) doesn't match the
// key pattern and is silently dropped, no diagnostic; an unquoted value keeps a trailing inline
// `# comment` as part of its text (quote it to strip one).
import os from 'node:os';

export function parseEnvValues(text) {
	const out = new Map();
	// KEY=value with optional `export `, optional quotes; value is whatever follows on the SAME line
	const re = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\n]*)$/gm;
	let m;
	while ((m = re.exec(text))) {
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		out.set(m[1], v);
	}
	return out;
}

const SUPPORTED = 'supported: ${env:NAME}, ${workspaceFolder}, ${userHome}';

export function renderTemplate(str, { env, workspaceFolder, declared }) {
	return str.replace(/\$\{([A-Za-z]+)(?::([A-Za-z0-9_]*))?\}/g, (whole, ns, arg) => {
		if (arg === undefined) {
			if (ns === 'workspaceFolder') return workspaceFolder;
			if (ns === 'userHome') return os.homedir();
			return whole; // un-namespaced ${VAR}: not ours, inert — prose mentions ${…} freely
		}
		if (ns !== 'env') throw new Error(`\${${ns}:${arg}} is not a dreamteamer variable — ${SUPPORTED}`);
		if (!arg) throw new Error(`\${env:} needs a key name — ${SUPPORTED}`);
		if (!declared.includes(arg)) throw new Error(`\${env:${arg}}: "${arg}" is not declared in dreamteamer.vars (workspace package.json) — declared: ${declared.join(', ') || '(none)'}`);
		// An empty or whitespace-only value is indistinguishable from unset to anyone reading the
		// rendered output — `FILES_FOLDER=` passes `env.has()` and silently renders to '', producing
		// a plausible-looking but wrong path. Same failure, same message: the operator can't tell
		// the two states apart from outside and doesn't care which one it is.
		if (!env.has(arg) || env.get(arg).trim() === '') throw new Error(`\${env:${arg}} is declared but has no value in .env on this machine`);
		return env.get(arg);
	});
}
