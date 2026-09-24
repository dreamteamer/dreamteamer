// A fake Docker Engine API on a Unix socket — enough of /version, /images and /containers for the
// driver in src/containers.js to be driven end to end with no Docker installed. In-memory, and
// every request is recorded so a test can assert WHAT was sent (the create body's labels, bindings
// and mounts) rather than only that something answered.
//
// ⚠ RUN IT AS A CHILD PROCESS, never in the test's own process. The tests drive the CLI with
// spawnSync, which blocks the event loop — a server living in that loop cannot accept a single
// connection while the child it is meant to answer is running, and the suite hangs with zero
// requests recorded (measured: 15 s to SIGTERM, requests []). So `node fake-docker.js <socket>
// [<images-json>]` starts one and prints `ready`; the test reads its state over the same socket at
// GET /_fake/state, asynchronously, between spawnSync calls.
import http from 'node:http';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';

export function startFakeDocker(socketPath, { images = [], plain = [] } = {}) {
	const state = {
		requests: [],                       // { method, path, body }
		images: new Map(),                  // ref -> { Id, RepoTags, Labels, Created, Size }
		containers: new Map(),              // id -> { Id, Name, Config, HostConfig, Mounts, State, Created }
		volumesRemoved: [],
		pulls: [],
	};
	let n = 0;
	const addImage = (ref, labels = {}) => {
		const Id = `sha256:${String(++n).padStart(64, '0')}`;
		state.images.set(ref, { Id, RepoTags: [ref], Labels: labels, Created: 1_700_000_000, Size: 1_500_000_000, Config: { Labels: labels } });
	};
	for (const i of images) addImage(i.ref, i.labels);
	// `plain` containers are Docker containers NOT made by dreamteamer — no workspace label — so a
	// test can prove the driver leaves them alone.
	for (const name of plain) {
		const Id = `${String(++n).padStart(12, 'b')}${'0'.repeat(52)}`;
		state.containers.set(Id, { Id, Name: `/${name}`, Created: new Date().toISOString(), Config: { Image: 'nginx:latest', Labels: {}, Env: [] }, HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8100' }] } }, Mounts: [], State: { Status: 'running', StartedAt: new Date().toISOString() }, RestartCount: 0 });
	}

	const byIdOrName = (key) => {
		for (const c of state.containers.values()) if (c.Id === key || c.Id.startsWith(key) || c.Name === `/${key}`) return c;
		return null;
	};
	const labelFilter = (u) => {
		const f = u.searchParams.get('filters');
		if (!f) return () => true;
		const labels = JSON.parse(f).label ?? [];
		return (obj) => labels.every((l) => l.includes('=') ? obj.Labels?.[l.split('=')[0]] === l.split('=')[1] : l in (obj.Labels ?? {}));
	};
	const summary = (c) => ({
		Id: c.Id, Names: [c.Name], Image: c.Config.Image, State: c.State.Status, Status: c.State.Status === 'running' ? 'Up 1 second' : 'Exited (0) 1 second ago',
		// the LIST answers unix seconds while INSPECT answers an ISO string — exactly as Docker does
		Labels: c.Config.Labels, Created: Math.floor(Date.parse(c.Created) / 1000),
		Ports: c.State.Status === 'running'
			? Object.entries(c.HostConfig.PortBindings ?? {}).flatMap(([k, v]) => v.map((b) => ({ PrivatePort: Number(k.split('/')[0]), PublicPort: Number(b.HostPort), Type: 'tcp', IP: b.HostIp })))
			: [],
	});

	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (d) => { raw += d; });
		req.on('end', () => {
			const u = new URL(req.url, 'http://docker');
			const body = raw ? JSON.parse(raw) : undefined;
			state.requests.push({ method: req.method, path: u.pathname + u.search, body });
			const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
			const p = u.pathname;
			let m;
			if (p === '/_fake/state') return json(200, { requests: state.requests.slice(0, -1), pulls: state.pulls, volumesRemoved: state.volumesRemoved, containers: [...state.containers.values()], images: [...state.images.keys()] });
			if (p === '/version') return json(200, { Version: '99.0.0-fake', ApiVersion: '1.99', Os: 'linux', Arch: 'fake' });
			if (p === '/_ping') { res.writeHead(200); return res.end('OK'); }
			// images
			if (p === '/images/json') return json(200, [...state.images.values()].filter(labelFilter(u)).map(({ Config, ...i }) => i));
			if (p === '/images/create') {
				const ref = `${u.searchParams.get('fromImage')}:${u.searchParams.get('tag') ?? 'latest'}`;
				state.pulls.push(ref);
				if (ref.includes('missing')) return json(404, { message: `pull access denied for ${ref}` });
				addImage(ref, { 'dreamteamer.template': ref.split('/').pop().split(':')[0], 'dreamteamer.ports': '8080' });
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.write(JSON.stringify({ status: 'Pulling from fake' }) + '\n');
				res.write(JSON.stringify({ status: 'Download complete', id: 'abc' }) + '\n');
				return res.end(JSON.stringify({ status: `Status: Downloaded newer image for ${ref}` }) + '\n');
			}
			if ((m = p.match(/^\/images\/(.+)\/json$/))) {
				const ref = decodeURIComponent(m[1]);
				const i = state.images.get(ref) ?? [...state.images.values()].find((x) => x.Id === ref);
				return i ? json(200, { Id: i.Id, RepoTags: i.RepoTags, Created: new Date(i.Created * 1000).toISOString(), Size: i.Size, Config: { Labels: i.Labels } }) : json(404, { message: `No such image: ${ref}` });
			}
			if (req.method === 'DELETE' && (m = p.match(/^\/images\/(.+)$/))) {
				const ref = decodeURIComponent(m[1]);
				if (!state.images.delete(ref)) return json(404, { message: `No such image: ${ref}` });
				return json(200, [{ Deleted: ref }]);
			}
			// volumes
			if (req.method === 'DELETE' && (m = p.match(/^\/volumes\/(.+)$/))) { state.volumesRemoved.push(decodeURIComponent(m[1])); return json(204); }
			// containers
			if (p === '/containers/json') return json(200, [...state.containers.values()].filter((c) => labelFilter(u)({ Labels: c.Config.Labels })).map(summary));
			if (p === '/containers/create' && req.method === 'POST') {
				const name = u.searchParams.get('name');
				if (byIdOrName(name)) return json(409, { message: `Conflict. The container name "/${name}" is already in use` });
				if (!state.images.has(body.Image)) return json(404, { message: `No such image: ${body.Image}` });
				const Id = `${String(++n).padStart(12, 'a')}${'0'.repeat(52)}`;
				state.containers.set(Id, {
					Id, Name: `/${name}`, Created: new Date().toISOString(),
					Config: { Image: body.Image, Labels: body.Labels ?? {}, Env: body.Env ?? [] },
					HostConfig: body.HostConfig ?? {},
					// as Docker reports them: a volume has Name, a bind has Source, both carry RW
					Mounts: (body.HostConfig?.Mounts ?? []).map((mt) => ({ Type: mt.Type, ...(mt.Type === 'bind' ? { Source: mt.Source } : { Name: mt.Source }), Destination: mt.Target, RW: !mt.ReadOnly })),
					State: { Status: 'created', StartedAt: '' }, RestartCount: 0,
				});
				return json(201, { Id, Warnings: [] });
			}
			if ((m = p.match(/^\/containers\/([^/]+)\/json$/))) {
				const c = byIdOrName(decodeURIComponent(m[1]));
				return c ? json(200, c) : json(404, { message: `No such container: ${m[1]}` });
			}
			if ((m = p.match(/^\/containers\/([^/]+)\/(start|stop)$/)) && req.method === 'POST') {
				const c = byIdOrName(decodeURIComponent(m[1]));
				if (!c) return json(404, { message: 'No such container' });
				const want = m[2] === 'start' ? 'running' : 'exited';
				if (c.State.Status === want) return json(304);
				c.State = { Status: want, StartedAt: want === 'running' ? new Date().toISOString() : c.State.StartedAt };
				return json(204);
			}
			if (req.method === 'DELETE' && (m = p.match(/^\/containers\/([^/]+)$/))) {
				const c = byIdOrName(decodeURIComponent(m[1]));
				if (!c) return json(404, { message: 'No such container' });
				if (c.State.Status === 'running' && u.searchParams.get('force') !== 'true') return json(409, { message: 'container is running: stop it or use --force' });
				state.containers.delete(c.Id);
				return json(204);
			}
			json(404, { message: `fake docker: no route for ${req.method} ${p}` });
		});
	});
	return new Promise((resolve) => server.listen(socketPath, () => resolve({ server, state, close: () => new Promise((r) => server.close(r)) })));
}

// standalone: node fake-docker.js <socket-path> [<images-json>]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [sock, imagesJson, plainJson] = process.argv.slice(2);
	startFakeDocker(sock, { images: imagesJson ? JSON.parse(imagesJson) : [], plain: plainJson ? JSON.parse(plainJson) : [] }).then(() => { console.log('ready'); });
}
