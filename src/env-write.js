// The `.env` writer behind a unit's env action (cr-dt-007, D61): the engine performs the one write
// every module's setup used to carry its own copy of — a key's value span replaced in place or
// appended, every other byte kept, the file replaced whole by rename, and only while it still has
// the fingerprint the plan saw. What is written reads back through `parseEnvValues` identically:
// `envSpans` follows that reader's grammar (an unquoted value runs to end of line; a quoted one may
// span lines), so this file is the writer half of one grammar, not a second grammar.
//
// Refusals are `EnvRefusal` with a `code`, so the driver (src/setup.js) can turn the ones it can see
// before writing into a plan-time `blocked` and keep only `changed` (the file moved after the plan)
// and an I/O error as a write-time failure. Nothing here reads a value back to the caller.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export class EnvRefusal extends Error {
	constructor(code, message) { super(message); this.code = code; }
}

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
// the reader's assignment, with the value token captured: KEY=value · KEY="…" (spans lines) · KEY='…'
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\n]*)$/gm;

/** Every assignment in `.env` text, in file order: `{ key, start, end, raw, value, quoted }` where
 *  `[start, end)` is the value token's span (an unquoted value without its trailing whitespace, so a
 *  CRLF file keeps its `\r`), `raw` the text there, `value` what parseEnvValues reads, `quoted` the
 *  quote character or false. */
export function envSpans(text) {
	const out = [];
	// a leading byte-order mark is not part of the first key: scanned as if absent, offsets kept (it is one
	// UTF-16 unit, replaced by one newline so `^` still matches the first line)
	const body = String(text).replace(/^\uFEFF/, '\n');
	for (const m of body.matchAll(ASSIGNMENT)) {
		let raw = m[2];
		const quoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? '"' : raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2 ? "'" : false;
		if (!quoted) raw = raw.replace(/\s+$/, '');
		const start = m.index + m[0].length - m[2].length;
		out.push({ key: m[1], start, end: start + raw.length, raw, value: quoted ? raw.slice(1, -1) : raw.trim(), quoted });
	}
	return out;
}

/** The token written for `value`: plain when nothing in it needs quoting (a backslash reads back as
 *  itself unquoted — a Windows path), else double-quoted. Inside double quotes the reader treats `\x` as
 *  one unit, so a backslash there could swallow the closing quote: refused. */
function token(key, value, preferQuoted) {
	const plain = /^[^\s#"']*$/.test(value) && value === value.trim() && !(preferQuoted && !value.includes('\\'));
	if (plain) return value;
	if (value.includes('\\')) throw new EnvRefusal('value', `${key}: a value with characters this action does not write — set it by hand`);
	return `"${value}"`;
}

/**
 * `.env` text with every key of `values` set, every other byte kept: a present key's value span is
 * replaced in place (its quoting kept when it was double-quoted); an absent key is appended as its
 * own line. `changed` lists the keys whose value differs from what the file held.
 * Refuses, by code: `twice` (a key assigned more than once — which assignment wins is the reader's
 * accident, so neither is rewritten) and `value` (a value holding `"` or NUL — the reader does not
 * unescape, so such a value cannot read back as written).
 */
export function setEnvValues(text, values) {
	let out = String(text);
	// a byte-order mark stays where it is; envSpans scans past it (the engine's reader of the unit's
	// environment, unitEnv, skips it too — held-out he1)
	const changed = [];
	for (const [key, value] of Object.entries(values)) {
		if (!ENV_KEY.test(key)) throw new EnvRefusal('key', `${key} is not an environment key`);
		if (typeof value !== 'string') throw new EnvRefusal('value', `${key}: a value that is not a string`);
		const found = envSpans(out).filter((s) => s.key === key);
		if (found.length > 1) throw new EnvRefusal('twice', `${key} is assigned more than once in .env — resolve that by hand first`);
		// a value the file already holds is done, whatever it holds: one a person set by hand after a refusal
		// is never refused again
		if (found.length === 1 && found[0].value === value) continue;
		// a `"` the reader does not unescape; `$`, a backtick or a carriage return a shell that sources .env
		// would expand or split; NUL — refused, so what is written reads back as written everywhere
		if (/["$`\r\0]/.test(value)) throw new EnvRefusal('value', `${key}: a value with characters this action does not write — set it by hand`);
		if (found.length === 1) {
			const s = found[0];
			out = out.slice(0, s.start) + token(key, value, s.quoted === '"') + out.slice(s.end);
		} else {
			const nl = out.includes('\r\n') ? '\r\n' : '\n';
			out = `${out}${out && !out.endsWith('\n') ? nl : ''}${key}=${token(key, value, false)}${nl}`;
		}
		changed.push(key);
	}
	return { text: out, changed };
}

/** `sha256:<hex>` of a regular file, `absent` when there is none; a symlink or a non-file is refused. */
export function fingerprint(file) {
	let st;
	try { st = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
	if (st.isSymbolicLink()) throw new EnvRefusal('symlink', `${path.basename(file)} is a symlink — a symlinked file is never written; replace the link with a regular file first`);
	if (!st.isFile()) throw new EnvRefusal('not-file', `${path.basename(file)} is not a regular file`);
	return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

const tempPrefix = (target) => `${path.basename(target)}.setup-`;
/** Temporary files an interrupted write of `target` left beside it — a reason to stop and name them. */
export function leftoverTemps(target) {
	try { return fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith(tempPrefix(target)) && f.endsWith('.tmp')).sort(); }
	catch { return []; }
}

// read-only git, scoped to the root: no optional locks, no fsmonitor, no GIT_* from the environment
const GIT_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME'];
function git(root, args) {
	const env = { GIT_TERMINAL_PROMPT: '0' };
	for (const k of GIT_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
	const r = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], { env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
	return { status: r.error ? null : r.status, stderr: r.stderr ?? '' };
}

/** Could workspace-relative `rel` end up in a commit? `{ safe }` or `{ safe: false, reason }`: in a
 *  repository git decides (not tracked, and ignored); outside any repository nothing can be committed. */
export function gitExposure(root, rel) {
	const top = git(root, ['rev-parse', '--show-toplevel']);
	if (top.status !== 0) {
		if (top.status === 128 && /not a git repository/i.test(top.stderr)) return { safe: true };
		if (top.status === null) return { safe: true };   // no git on this machine: nothing commits
		return { safe: false, reason: `git could not inspect this workspace — nothing was written` };
	}
	if (git(root, ['ls-files', '--error-unmatch', '--', rel]).status === 0) return { safe: false, reason: `${rel} is tracked by git, so its contents would be committed — untrack it (git rm --cached ${rel}) and ignore it first` };
	if (git(root, ['check-ignore', '-q', '--', rel]).status === 0) return { safe: true };
	return { safe: false, reason: `git would commit ${rel} — add it to .gitignore first` };
}

/** Is any component of `.env` under `root` a symlink, or does the path leave the root? */
function confinedEnv(root) {
	const real = fs.realpathSync(root);
	const target = path.join(real, '.env');
	let st = null;
	try { st = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
	if (st?.isSymbolicLink()) throw new EnvRefusal('symlink', '.env is a symlink — a symlinked file is never written; replace the link with a regular file first');
	return target;
}

/**
 * Replace `<root>/.env` with `content` by rename, only while it still has fingerprint `expect`
 * (`absent` for a file that did not exist). The temporary file is removed on every failure this
 * process survives; an existing file keeps its mode, a new one is created owner-only. The last check
 * and the rename are two calls, not a compare-and-swap — optimistic, kept as short as it can be.
 */
export function writeEnvAtomic(root, content, expect) {
	const target = confinedEnv(root);
	const stale = () => new EnvRefusal('changed', '.env changed after the preview — nothing was written; plan again');
	if (fingerprint(target) !== expect) throw stale();
	let mode = 0o600;
	try { mode = fs.statSync(target).mode & 0o777; } catch { /* a new file */ }
	const temp = path.join(path.dirname(target), `${tempPrefix(target)}${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
	const fd = fs.openSync(temp, 'wx', mode);
	try {
		try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		confinedEnv(root);
		if (fingerprint(target) !== expect) throw stale();
		fs.renameSync(temp, target);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
	return fingerprint(target);
}
