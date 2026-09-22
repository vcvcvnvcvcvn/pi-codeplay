/** Boots one extension instance for a given project dir (used by multi-project.mjs). */
import { mkdir } from "node:fs/promises";

const cwd = process.argv[2];
if (!cwd) {
	console.error("usage: instance-server.mjs <cwd>");
	process.exit(1);
}
await mkdir(cwd, { recursive: true });

globalThis.__codeplayOpenHook = () => {};

const tools = new Map();
const events = new Map();
const pi = {
	registerTool(d) { tools.set(d.name, d); },
	registerCommand() {},
	on(n, h) { (events.get(n) ?? events.set(n, []).get(n)).push(h); },
};

const { default: codeplay } = await import("../index.ts");
codeplay(pi);

const ctx = { cwd, hasUI: false, ui: { notify() {} } };
for (const h of events.get("session_start") ?? []) await h({ reason: "startup" }, ctx);

console.log("READY");

let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	for (const h of events.get("session_shutdown") ?? []) await h({}, ctx);
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1 << 30);
