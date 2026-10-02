// record⇄command evaluation — which bound commands apply to a record (or a list
// selection), and in which state. a binding is a `command-bindings` record: a m2m
// join (command × collection) carrying `available_when` / `done_when` filter predicates,
// evaluated with the SAME operator set as list-view filters plus one-hop outbound
// ref traversal (tier 1). serves `dreamteamer commands for`, GET /api/commands/:name,
// and (through the extension's api.ts port) the studio's Commands tab.
import { matchesFilter } from './filter.js';
import { parseRef } from './namespace.js';

// memoized `<collection>/<id>` → parsed fields (or null) for ONE evaluation pass:
// overlapping refs across a 50-record selection parse once, and filter.js stays
// pure — it never learns about the store, it just gets this callback.
export function recordResolver(store) {
	const memo = new Map();
	return (ref) => {
		if (memo.has(ref)) return memo.get(ref);
		let target = null;
		// ⚠ `parseRef`, NEVER `ref.indexOf('/')`. This split at the first slash until 0.13.3, which
		// made `family/people/dana-levi` the collection `family` (a NAMESPACE, not a collection) holding
		// the id `people/dana-levi`. `store.read` threw, the catch below swallowed it, and the caller got
		// null — which filter.js is documented to treat as NARROWING. So every one-hop relational
		// filter over a namespaced collection matched ZERO records, with no error anywhere, while the
		// identical filter over a default-namespace ref worked. Measured on a real vault: 151 rows via
		// `companies/<id>`, 0 rows via `family/people/<id>`, 273 for the same records addressed flat.
		// The blast radius was not only filtering — this resolver also evaluates `available_when`/`done_when`
		// below, so a binding predicate hopping a namespaced ref reported "not available".
		const parsed = parseRef(ref, store.namespaces);
		if (parsed) {
			try {
				const { fields } = store.read(parsed.collection, parsed.id);
				target = { ...fields, id: parsed.id };
			} catch { /* dangling ref or unknown collection — narrows, never widens */ }
		}
		memo.set(ref, target);
		return target;
	};
}

/**
 * every command bound to `collection`, evaluated over `ids` (possibly empty).
 * scope=collection bindings need no record — always runnable, invocation carries the
 * collection name (so a command bound to several collections knows where to write).
 * scope=record bindings get a per-id state:
 *   done            done_when passes (the command's post-condition already holds)
 *   available       available_when passes (or there is none) and done_when doesn't
 *   not-applicable  available_when fails (or the record doesn't resolve)
 * `invocation` covers the ELIGIBLE ids only, space-separated — a deliberate contract:
 * the UI shows it verbatim in an editable textarea, so nothing is silently dropped.
 */
export function commandsFor(store, collection, ids = []) {
	store.descriptor(collection); // unknown collection throws here, not deep inside a filter walk
	const resolve = recordResolver(store);
	const commands = new Map();
	for (const { id, fields } of store.readAll('commands')) commands.set(`commands/${id}`, fields);
	const rows = [];
	for (const { id: bindingId, fields: b } of store.readAll('command-bindings')) {
		if (b.collection !== `collections/${collection}`) continue;
		const cmd = commands.get(b.command);
		if (!cmd) continue; // compile rejects dangling binding refs; stay safe on a stale runtime
		const row = {
			binding: `command-bindings/${bindingId}`,
			command: b.command,
			name: cmd.name,
			description: b.description ?? cmd.description ?? '',
			'argument-hint': cmd['argument-hint'] ?? null,
			scope: b.scope ?? 'record',
		};
		if (row.scope === 'collection') {
			rows.push({ ...row, invocation: `/${cmd.name} ${collection}` });
			continue;
		}
		const states = {};
		for (const id of ids) {
			const record = resolve(`${collection}/${id}`);
			let state = 'not-applicable';
			if (record) {
				if (b.done_when && matchesFilter(record, b.done_when, resolve)) state = 'done';
				else if (!b.available_when || matchesFilter(record, b.available_when, resolve)) state = 'available';
			}
			states[id] = state;
		}
		const eligible = ids.filter((id) => states[id] === 'available');
		rows.push({
			...row,
			states,
			eligible,
			done: ids.filter((id) => states[id] === 'done'),
			invocation: eligible.length ? `/${cmd.name} ${eligible.map((id) => `${collection}/${id}`).join(' ')}` : null,
		});
	}
	// record commands first (the headline on a record page), then collection commands; name-sorted within
	rows.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'collection' ? 1 : -1));
	return { collection, ids, commands: rows };
}
