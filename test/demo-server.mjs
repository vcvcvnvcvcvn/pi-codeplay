/** Demo server: boots the extension with a mock pi and seeds a sample graph. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tools = new Map();
const events = new Map();
const pi = {
	registerTool(def) { tools.set(def.name, def); },
	registerCommand() {},
	on(name, handler) { (events.get(name) ?? events.set(name, []).get(name)).push(handler); },
};

globalThis.__codeplayOpenHook = (url) => console.log("[open suppressed]", url);

const { default: codeplay } = await import("../index.ts");
codeplay(pi);

const cwd = await mkdtemp(join(tmpdir(), "codeplay-demo-"));
const ctx = { cwd, hasUI: true, ui: { notify: (m) => console.log("[notify]", m) } };
for (const h of events.get("session_start") ?? []) await h({ reason: "reload" }, ctx);

const call = (name, params) => tools.get(name).execute("tc", params);

await call("dag_add_node", { name: "需求分析", brief: "梳理用户需求与边界", status: "done", files: "docs/req.md" });
await call("dag_add_node", { name: "架构设计", brief: "模块划分与数据流", status: "done", files: "docs/arch.md, src/core.ts" });
await call("dag_add_node", { name: "前端面板", brief: "Cytoscape  DAG 展示", status: "active", files: "public/app.js, public/style.css, public/index.html" });
await call("dag_add_node", { name: "工具层", brief: "7 个 dag_* 工具", status: "active", files: "index.ts" });
await call("dag_add_node", { name: "联调测试", status: "pending" });
await call("dag_add_node", { name: "文档与发布", status: "pending" });
await call("dag_add_edge", { source: "n1", target: "n2", note: "产出架构" });
await call("dag_add_edge", { source: "n2", target: "n3" });
await call("dag_add_edge", { source: "n2", target: "n4" });
await call("dag_add_edge", { source: "n3", target: "n5", note: "依赖工具层" });
await call("dag_add_edge", { source: "n4", target: "n5" });
await call("dag_add_edge", { source: "n5", target: "n6" });
await call("dag_announce", { message: "需求与架构阶段完成，开始搭建前端面板与工具层" });
await call("dag_announce", { message: "发现 jiti 符号链接路径问题，已修复并补回归测试" });
await call("dag_announce", { message: "多项目索引页 /projects 上线" });

console.log("demo ready");

async function shutdown() {
	for (const h of events.get("session_shutdown") ?? []) await h({}, ctx);
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1 << 30);
