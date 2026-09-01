// contract rule: YAML is parsed with the CORE schema — unquoted dates stay strings,
// never timestamp objects. ALL dreamteamer tooling loads YAML through here.
import yaml from 'js-yaml';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';

export const load = (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA });
export const dump = (obj, opts = {}) => yaml.dump(obj, { lineWidth: 120, ...opts });

// ---- writing a source a HUMAN wrote ---------------------------------------------
//
// `dump` is for GENERATED output — the compiled runtime, a record's front matter, a harness file —
// where nothing was hand-formatted and byte-stability is the only thing that matters. A module
// SOURCE is the opposite case: it is hand-written, and it is where a module records WHY a collection
// exists. `load` → mutate → `dump` destroys all of that, because a dump re-derives the whole file
// from the parsed value: every comment gone, every flow form (`templates: [a]`, `storage: { … }`)
// expanded to block, every hand-folded scalar re-wrapped at the writer's own width. One `add-field`
// on a commented descriptor took it to zero comments, and one namespacing migration lost 194 comment
// lines across 24 descriptors — headers stating what belongs in a collection and which failure mode
// it guards against. Nothing warned; the schema was unchanged, so every gate stayed green.
//
// Three hand-rolled textual workarounds were written against this before it was fixed properly (a
// `setScalar` regex, an `x-reference` line editor, and a `reattachComments` pass that could only
// carry TOP-LEVEL blocks). All three are retired by `writeSource`.
//
// ⚠ THE DOCUMENT API ALONE IS NOT ENOUGH, and that was measured rather than assumed. `yaml` keeps
// comments and key order across parse → mutate → stringify, but it re-derives STYLE from its options
// rather than from the source, so a plain round-trip still reformats: `[a, b]` gains or loses its
// padding depending on one global flag the file's own author used both ways, and a block-folded
// scalar is re-folded at `lineWidth` — hand-wrapping the library cannot see and cannot reproduce.
// Straight through the Document API, 27 of 92 hand-written sources round-tripped byte-identically.
//
// So the stringify is followed by a pass that puts the ORIGINAL BYTES back wherever nothing changed:
// walk the old and new documents together, and for every node — or every key/value pair — whose
// value is deep-equal on both sides, replace the newly-emitted span with the source it was parsed
// from. Unchanged means byte-identical BY CONSTRUCTION, so the diff can only ever be the mutation.
// With the pass, 92 of 92. `test/unit/yaml-source.test.js` is the reproduction.

// `lineWidth: 0` never re-folds — an unchanged scalar is restored verbatim below, and a changed one
// must not drag its neighbours onto new lines.
//
// ⚠ `flowCollectionPadding` is ONE flag for two conventions that genuinely differ. Counted over a
// real workspace's 92 hand-written sources: flow SEQUENCES are unpadded 183 times out of 183
// (`list_fields: [name, status]`), flow MAPPINGS are padded 118 times out of 120
// (`storage: { path: x }`). Only a CHANGED collection is re-emitted at all — everything else is
// restored byte-for-byte — and what these ops change is the sequences: `list_fields`, `required`,
// `enum` and `templates`. So the sequence convention wins, and a flow mapping loses its padding only
// on the line an `x-reference` retarget was already rewriting.
const SOURCE_OPTS = { lineWidth: 0, flowCollectionPadding: false };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const keyOf = (pair) => String(pair.key?.value ?? pair.key);

/**
 * Apply a plain JS value onto a parsed document, touching only the nodes that differ.
 *
 * Key ORDER comes from the value, which is what gives `add-field` its insert-before-body placement
 * for free; an existing key keeps its node — and therefore its comments, its quoting and its flow
 * form — whenever its value is unchanged. A node that IS replaced inherits the comments that sat on
 * the position, because those belong to the key, not to the value that happened to be there.
 */
function merge(doc, node, value) {
	if (isMap(node) && isObj(value)) {
		node.items = Object.entries(value).map(([k, v]) => {
			const pair = node.items.find((p) => keyOf(p) === k);
			if (!pair) return doc.createPair(k, v);
			pair.value = merge(doc, pair.value, v);
			return pair;
		});
		return node;
	}
	// ⚠ A SEQUENCE IS MATCHED BY VALUE FIRST, NEVER BY INDEX ALONE. A comment in a list belongs to the
	// ITEM it sits above, and index-matching hands it to whatever slides into that slot: dropping
	// `name` from `required: [name, vendor_code]` moved "name is required because…" on top of
	// `vendor_code` — an explanation attached to something it does not explain, which is worse than
	// losing it. So an unchanged item keeps its own node wherever it moved to; only what is left over
	// falls to the leftover nodes IN ORDER, which is what lets an in-place edit (an `x-reference`
	// retarget rewriting one entry) keep the comment that was always about that position.
	if (isSeq(node) && Array.isArray(value)) {
		const old = [...node.items];
		const out = new Array(value.length);
		value.forEach((v, i) => {
			const j = old.findIndex((it) => it !== undefined && same(it?.toJSON?.() ?? null, v ?? null));
			if (j !== -1) { out[i] = old[j]; old[j] = undefined; }
		});
		let k = 0;
		value.forEach((v, i) => {
			if (out[i] !== undefined) return;
			while (k < old.length && old[k] === undefined) k++;
			out[i] = k < old.length ? merge(doc, old[k++], v) : doc.createNode(v);
		});
		node.items = out;
		return node;
	}
	if (isScalar(node) && !isObj(value) && !Array.isArray(value) && node.value === value) return node;
	const fresh = doc.createNode(value);
	for (const k of ['comment', 'commentBefore', 'spaceBefore']) if (node?.[k] !== undefined) fresh[k] = node[k];
	return fresh;
}

const lineEnd = (text, from) => { const nl = text.indexOf('\n', from); return nl === -1 ? text.length : nl; };
const commentLines = (node) => (node?.comment == null ? 0 : node.comment.split('\n').length);

/**
 * Where a node's source really ends. `range[1]` stops at the VALUE, so a trailing `# comment` sits
 * outside it and its alignment is lost with it.
 *
 * ⚠ Counts COMMENT lines, not total lines, and takes the count from the ORIGINAL side. The two sides
 * spell one comment differently: a source writes `icon: star   # why` on one line, while the library
 * re-emits a MULTI-line comment on lines of its own — so the same comment spans two lines in the
 * source and three in the output. A following line is only ever consumed when it is nothing but a
 * comment, so a wrong count can shorten the span but can never swallow content.
 */
function endOf(text, from, lines) {
	if (lines <= 0) return from;
	let end = lineEnd(text, from);
	let got = text.slice(from, end).includes('#') ? 1 : 0;
	while (got < lines && end < text.length) {
		const next = lineEnd(text, end + 1);
		if (!/^\s*#/.test(text.slice(end + 1, next))) break;
		end = next;
		got++;
	}
	return end;
}

const nodeSpan = (text, n, lines) => [n.range[0], endOf(text, n.range[1], lines)];
/** A pair's whole source — the key, the value, and any comment sitting between or after them. */
const pairSpan = (text, p, lines) => [p.key.range[0], endOf(text, (p.value?.range ? p.value : p.key).range[1], lines)];

/** Emit the document, restoring the original bytes of everything that did not change. */
function emit(doc, originalText) {
	const out = doc.toString(SOURCE_OPTS);
	if (originalText == null) return out;
	const oldRoot = parseDocument(originalText, { schema: 'core' }).contents;
	const newRoot = parseDocument(out, { schema: 'core' }).contents;
	const kind = (x) => (isMap(x) ? 'map' : isSeq(x) ? 'seq' : isScalar(x) ? 'scalar' : null);
	const edits = [];

	const visit = (o, n) => {
		if (!o?.range || !n?.range || kind(o) === null || kind(o) !== kind(n)) return;
		if (same(o.toJSON(), n.toJSON())) {
			const lines = commentLines(o);
			edits.push([...nodeSpan(out, n, lines), originalText.slice(...nodeSpan(originalText, o, lines))]);
			return;
		}
		// A changed collection is still mostly unchanged — descend, so one edited field restores every
		// sibling verbatim instead of re-emitting the whole block around it.
		if (isMap(o) && isMap(n)) {
			for (const np of n.items) {
				const op = o.items.find((p) => keyOf(p) === keyOf(np));
				if (!op) continue;
				if (same(op.value?.toJSON?.() ?? null, np.value?.toJSON?.() ?? null)) {
					const lines = commentLines(op.value);
					edits.push([...pairSpan(out, np, lines), originalText.slice(...pairSpan(originalText, op, lines))]);
				} else visit(op.value, np.value);
			}
		} else if (isSeq(o) && isSeq(n)) {
			for (let i = 0; i < Math.min(o.items.length, n.items.length); i++) visit(o.items[i], n.items[i]);
		}
	};
	visit(oldRoot, newRoot);

	// right-to-left, so an earlier splice cannot shift a later one's offsets. Descending into a node
	// only happens when it was NOT spliced, so no two spans overlap.
	let res = out;
	for (const [s, e, src] of edits.sort((a, b) => b[0] - a[0])) res = res.slice(0, s) + src + res.slice(e);
	// ⚠ FAIL CLOSED. Splicing bytes is only safe because it is checked: if the result does not parse
	// back to exactly the document that was asked for, the plain stringify is returned instead — a
	// reformatted file rather than a wrong one.
	try {
		if (!same(parseDocument(res, { schema: 'core' }).toJS(), doc.toJS())) return out;
	} catch { return out; }
	return res;
}

/**
 * Serialize `value` back over the source it came from, keeping everything the change did not touch.
 *
 * `previousText` is the bytes on disk, or null for a file that does not exist yet — a new file has no
 * formatting to preserve and no comments to lose, so it is `dump`ed exactly as before.
 */
export function writeSource(previousText, value) {
	if (previousText === null || previousText === undefined) return dump(value);
	const doc = parseDocument(previousText, { schema: 'core' });
	doc.contents = merge(doc, doc.contents, value);
	return emit(doc, previousText);
}

/** Lines that are nothing but a comment — the quantity `writeGated`'s invariant protects. */
export const commentCount = (text) => text.split('\n').filter((l) => l.trimStart().startsWith('#')).length;
