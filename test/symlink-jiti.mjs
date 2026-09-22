/**
 * Regression test for the symlink loading path.
 *
 * pi auto-discovers extensions via jiti from ~/.pi/agent/extensions/*.ts, and
 * our global install is a symlink. jiti keeps the *symlink* path in
 * import.meta.url, so PUBLIC_DIR must realpath() it — otherwise the panel
 * serves 404 while /api/graph keeps working.
 *
 * This test loads the extension through pi's own bundled jiti + a symlink,
 * exactly like pi does, then asserts GET / returns 200.
 *
 * Run: node test/symlink-jiti.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// jiti is pi's extension loader; take it from the local devDependency install
// (fallback: the global pi installation) so this test runs on any machine.
const jitiCandidates = [
	resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.cjs"),
	"/Users/xuguangzheng/.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
];
const jitiPath = jitiCandidates.find((p) => existsSync(p));
assert.ok(jitiPath, "jiti not found — run npm install first");
const { createJiti } = require(jitiPath);

const HUB_PORT = 7733;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
process.env.CODEPLAY_HUB_PORT = String(HUB_PORT);
globalThis.__codeplayOpenHook = () => {}; // never open a browser in tests

const realIndex = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "index.ts");
const linkDir = await mkdtemp(join(tmpdir(), "codeplay-link-"));
const linkPath = join(linkDir, "codeplay.ts");
await symlink(realIndex, linkPath);
// jiti resolves deps relative to the *symlink* location, so give it access to
// the project's node_modules (in production pi's own resolution provides them).
await symlink(resolve(realIndex, "..", "node_modules"), join(linkDir, "node_modules"), "dir");

const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true });
const mod = await jiti.import(linkPath);
const codeplay = mod.default ?? mod;

const tools = new Map();
const events = new Map();
const pi = {
	registerTool(def) { tools.set(def.name, def); },
	registerCommand() {},
	on(name, handler) { (events.get(name) ?? events.set(name, []).get(name)).push(handler); },
};
codeplay(pi);

const cwd = await mkdtemp(join(tmpdir(), "codeplay-jiti-"));
const ctx = { cwd, hasUI: false, ui: { notify() {} } };
for (const h of events.get("session_start") ?? []) await h({ reason: "startup" }, ctx);

await tools.get("dag_add_node").execute("tc", { name: "探针" });

const get = (url) =>
	new Promise((res2, rej) => {
		http.get(url, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => res2({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
		}).on("error", rej);
	});

// the extension auto-spawns the hub; our project must appear and its canvas
// (static assets from the *real* extension dir, not the symlink dir) must load
let page;
for (let i = 0; i < 50 && !page; i++) {
	await new Promise((r) => setTimeout(r, 200));
	try {
		const list = JSON.parse((await get(`${HUB}/api/projects`)).body);
		const mine = list.find((p) => p.cwd === cwd);
		if (mine) {
			const r = await get(`${HUB}/${mine.slug}/`);
			if (r.status === 200) page = r;
		}
	} catch { /* hub not up yet */ }
}
assert.ok(page, "canvas served via hub via symlink+jiti load");
assert.match(page.body, /Codeplay/);

for (const h of events.get("session_shutdown") ?? []) await h({}, ctx);
try {
	const hubPid = JSON.parse((await get(`${HUB}/api/hub`)).body).pid;
	process.kill(hubPid, "SIGTERM");
} catch { /* already gone */ }
console.log("✅ symlink+jiti regression test passed");
process.exit(0);
