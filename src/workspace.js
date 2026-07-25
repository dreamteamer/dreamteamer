// workspace discovery: the TOPMOST package.json with a `dreamteamer` section wins —
// modules are themselves dreamteamer packages (fractal), so the nearest match from
// inside a module folder would wrongly be the module, not the workspace.
import fs from 'node:fs';
import path from 'node:path';

export function findWorkspace(start = process.cwd()) {
	let dir = path.resolve(start);
	let found = null;
	while (true) {
		const p = path.join(dir, 'package.json');
		if (fs.existsSync(p)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
				if ('dreamteamer' in pkg) found = { root: dir, pkg };
			} catch { /* unparseable package.json never disqualifies a dir */ }
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!found) {
		throw new Error('not a dreamteamer workspace — no package.json with a "dreamteamer" section found here or above');
	}
	return found;
}
