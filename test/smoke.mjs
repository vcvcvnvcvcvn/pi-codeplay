/**
 * Smoke test: drives the extension with a mocked ExtensionAPI against a real
 * hub (auto-spawned by the extension on a test port).
 * Run: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HUB_PORT = 7731;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
process.env.CODEPLAY_HUB_PORT = String(HUB_PORT);

const tools = new Map();
const events = new Map();
const commands = new Map();

const pi = {
	registerTool(def) {
		tools.set(def.name, def);
	},
	registerCommand(name, def) {
		commands.set(name, def);
	},
	on(name, handler) {
		if (!events.has(name)) events.set(name, []);
		events.get(name).push(handler);
	},
};

// intercept browser opens
const opened = [];
globalThis.__codeplayOpenHook = (url) => opened.push(url);

const { default: codeplay } = await import("../index.ts");
codeplay(pi);

// -- helpers -------------------------------------------------------------------
const get = (url, headers = {}) =>
	new Promise((resolveGet, rejectGet) => {
		http.get(url, { headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolveGet({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
		}).on("error", rejectGet);
	});

async function waitFor(fn, what, timeout = 15000) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

function slugify(name) {
	const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	if (!s) return "project";
	return /^[a-z]/.test(s) ? s : `p-${s}`;
}

// -- fire session_start with a temp project dir ------------------------------
const cwd = await mkdtemp(join(tmpdir(), "codeplay-test-"));
const slug = slugify(cwd.split("/").pop());
const base = `${HUB}/${slug}`;
const notifications = [];
const ctx = {
	cwd,
	hasUI: true,
	ui: { notify: (msg, level) => notifications.push([level, msg]) },
};
for (const h of events.get("session_start") ?? []) {
	await h({ reason: "startup" }, ctx);
}
assert.equal(opened.length, 0, "browser must NOT open on session_start (lazy open)");

// hub should be auto-spawned by the first push
const hubInfo = await waitFor(async () => {
	try {
		const r = await get(`${HUB}/api/hub`);
		return r.status === 200 ? JSON.parse(r.body) : null;
	} catch {
		return null;
	}
}, "hub to come up");
assert.equal(hubInfo.app, "codeplay-hub");

const call = async (name, params) => {
	const tool = tools.get(name);
	assert.ok(tool, `tool ${name} registered`);
	const res = await tool.execute("tc", params);
	return res.content[0].text;
};

// -- tools --------------------------------------------------------------------
const EXPECTED_TOOLS = [
	"dag_view",
	"dag_clear",
	"dag_announce",
	"dag_add_node",
	"dag_update_node",
	"dag_remove_node",
	"dag_add_edge",
	"dag_update_edge",
	"dag_remove_edge",
];
for (const t of EXPECTED_TOOLS) assert.ok(tools.has(t), `missing tool ${t}`);

assert.match(await call("dag_view", {}), /empty/);
assert.equal(opened.length, 1, "first dag_* tool call opens the browser");
assert.equal(opened[0], `${base}/`, "opens this project's canvas URL");

await call("dag_add_node", { name: "需求分析", brief: "梳理需求", status: "done" });
await call("dag_add_node", { name: "架构设计", files: "docs/arch.md, src/core.ts" });
await call("dag_add_node", { name: "编码实现" });
assert.match(await call("dag_add_node", { name: "坏状态", status: "weird" }), /Error: invalid status/);

await call("dag_add_edge", { source: "n1", target: "n2", note: "产出架构" });
await call("dag_add_edge", { source: "n2", target: "n3" });
assert.match(await call("dag_add_edge", { source: "n3", target: "n1" }), /cycle/);
assert.match(await call("dag_add_edge", { source: "n1", target: "n9" }), /not found/);
assert.equal(opened.length, 1, "browser opens only once per session");

await call("dag_update_node", { id: "n2", field: "status", value: "进行中" });
await call("dag_update_node", { id: "n2", field: "files", value: "a.ts, b.ts" });
await call("dag_update_node", { id: "n2", field: "brief", value: "更新后的简介" });
await call("dag_update_node", { id: "n2", field: "name", value: "架构设计v2" });
assert.match(await call("dag_update_node", { id: "n9", field: "name", value: "x" }), /not found/);

await call("dag_update_edge", { id: "e1", field: "note", value: "输出架构文档" });
assert.match(await call("dag_update_edge", { id: "e2", field: "source", value: "n3" }), /cycle|Error/);
assert.match(await call("dag_update_edge", { id: "e2", field: "target", value: "n9" }), /not found/);

const view = await call("dag_view", {});
console.log("---- dag_view ----\n" + view + "\n------------------");
assert.match(view, /n1 ✓ 需求分析/);
assert.match(view, /n2 ▶ 架构设计v2/);
assert.match(view, /e1: n1 -> n2 \(输出架构文档\)/);

// parallel mutations must not corrupt the file (queue serializes them)
await Promise.all(Array.from({ length: 8 }, (_, i) => call("dag_add_node", { name: `并发${i}` })));

const persisted = JSON.parse(await readFile(join(cwd, ".codeplay", "graph.json"), "utf8"));
assert.equal(persisted.nodes.length, 11);
assert.equal(persisted.edges.length, 2);
assert.equal(persisted.nodes.find((n) => n.id === "n2").status, "active");
assert.deepEqual(persisted.nodes.find((n) => n.id === "n2").files, ["a.ts", "b.ts"]);

// announcements
await call("dag_announce", { message: "脚手架搭建完成" });
await call("dag_announce", { message: "引擎联调通过" });
assert.match(await call("dag_announce", { message: "  " }), /must not be empty/);

{
	const persisted2 = JSON.parse(await readFile(join(cwd, ".codeplay", "graph.json"), "utf8"));
	assert.equal(persisted2.messages.length, 2);
	assert.equal(persisted2.messages[0].id, "m1");
	assert.equal(persisted2.messages[1].text, "引擎联调通过");
}

// remove node cascades to edges
await call("dag_remove_node", { id: "n3" });
assert.match(await call("dag_view", {}), /Edges \(1\)/);
await call("dag_remove_edge", { id: "e1" });
assert.match(await call("dag_view", {}), /Edges \(0\)/);

// -- hub-served canvas + API ---------------------------------------------------
await waitFor(async () => {
	const r = await get(`${HUB}/api/projects`);
	return r.status === 200 && r.body.includes(`"slug":"${slug}"`) ? true : null;
}, "project visible in hub index");

const api = JSON.parse((await get(`${base}/api/graph`)).body);
assert.equal(api.nodes.length, 10);
assert.equal(api.messages.length, 2);

const info = JSON.parse((await get(`${base}/api/info`)).body);
assert.equal(info.project, cwd.split("/").pop(), "display name defaults to cwd basename (original case)");
assert.equal(info.slug, slug, "slug is the lowercase slugified basename");

assert.equal((await get(`${base}/`)).status, 200);
assert.match((await get(`${base}/`)).body, /Codeplay/);
assert.equal((await get(`${base}/app.js`)).status, 200);
assert.equal((await get(`${base}/vendor/cytoscape.min.js`)).status, 200);
assert.equal((await get(`${base}/..%2f..%2fetc%2fpasswd`)).status, 404);

const indexPage = await get(`${HUB}/`);
assert.equal(indexPage.status, 200);
assert.match(indexPage.body, /项目索引/);
const projectsList = JSON.parse((await get(`${HUB}/api/projects`)).body);
assert.equal(projectsList.length, 1);
assert.equal(projectsList[0].cwd, cwd);

// unknown project -> 404
assert.equal((await get(`${HUB}/nonexistent/`)).status, 404);

// SSE: first frame is the snapshot; a mutation must broadcast a new frame
await new Promise((resolveSse, rejectSse) => {
	const req = http.get(`${base}/api/events`, (res) => {
		let buf = "";
		res.on("data", (c) => {
			buf += c.toString();
			const frames = (buf.match(/data: /g) ?? []).length;
			if (frames === 1) {
				call("dag_add_node", { name: "SSE测试" }).catch(rejectSse);
			}
			if (frames >= 2) {
				assert.match(buf, /SSE测试/);
				req.destroy();
				resolveSse();
			}
		});
	});
	req.on("error", (e) => (e.code === "ECONNRESET" ? resolveSse() : rejectSse(e)));
	setTimeout(() => rejectSse(new Error("SSE timeout")), 5000);
});

// dag_clear wipes the canvas (requires confirm)
assert.match(await call("dag_clear", {}), /refused/);
assert.match(await call("dag_clear", { confirm: false }), /refused/);
assert.match(await call("dag_clear", { confirm: true }), /Cleared canvas \(removed 11 nodes, 0 edges, 2 messages\)/);
{
	// pushState is fire-and-forget; wait for the hub to converge
	const g = await waitFor(async () => {
		const gg = JSON.parse((await get(`${base}/api/graph`)).body);
		return gg.nodes?.length === 0 ? gg : null;
	}, "hub graph to converge after dag_clear");
	assert.equal(g.edges.length, 0);
	assert.equal(g.messages.length, 0);
	const persistedClear = JSON.parse(await readFile(join(cwd, ".codeplay", "graph.json"), "utf8"));
	assert.equal(persistedClear.nodes.length, 0);
}

// /dag command re-opens the panel on demand
const dagCmd = commands.get("dag");
assert.ok(dagCmd, "/dag command registered");
await dagCmd.handler("", ctx);
assert.equal(opened.length, 2, "/dag opens the browser on demand");
assert.equal(opened[1], `${base}/`);

// before_agent_start injects the DAG section
const opts = { sections: {} };
for (const h of events.get("before_agent_start") ?? []) await h({ systemPromptOptions: opts }, ctx);
assert.ok(!opts.sections.dag_visualization.includes("dag_set_project"), "no project-name logic in prompt");
assert.match(opts.sections.dag_visualization, /incrementally/);
assert.match(opts.sections.dag_visualization, /fine-grained|finer/);
assert.match(opts.sections.dag_visualization, /dag_announce/);
assert.match(opts.sections.dag_visualization, /BEFORE you start adding a new module/);
assert.match(opts.sections.dag_visualization, /BEFORE you start running tests/);
assert.match(opts.sections.dag_visualization, /pending \(未开始\)/);

// -- shutdown: unregister from the hub ------------------------------------------
for (const h of events.get("session_shutdown") ?? []) await h({}, ctx);
await waitFor(async () => {
	const r = JSON.parse((await get(`${HUB}/api/projects`)).body);
	return r.length === 0 ? true : null;
}, "project unregistered after shutdown");
assert.equal((await get(`${base}/`)).status, 404);

// kill the hub the extension spawned
const hubPid = JSON.parse((await get(`${HUB}/api/hub`)).body).pid;
process.kill(hubPid, "SIGTERM");

console.log("✅ all smoke tests passed");
process.exit(0);
