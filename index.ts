/**
 * Codeplay — DAG visualization panel for pi
 *
 * Gives the agent a set of `dag_*` tools to maintain a directed acyclic graph
 * (task plan / architecture / dependencies / data flow) and shows it live in
 * the user's browser as a shared communication medium.
 *
 * Architecture: a single detached hub process (hub.mjs) owns one local port
 * (default 7700). Pi sessions never listen on a port — they push their full
 * graph state to the hub on every change (plus a 5s heartbeat). Each project
 * gets its canvas at http://127.0.0.1:7700/<project-name>/ and the hub index
 * at / lists all live projects.
 *
 * Graph state persists per project in `<cwd>/.codeplay/graph.json`.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { exec as childExec, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

type NodeStatus = "pending" | "active" | "done";

interface DagNode {
	id: string;
	name: string;
	brief: string;
	files: string[];
	status: NodeStatus;
}

interface DagEdge {
	id: string;
	source: string;
	target: string;
	note: string;
}

interface DagMessage {
	id: string;
	text: string;
	ts: number;
}

interface DagGraph {
	nodes: DagNode[];
	edges: DagEdge[];
	messages: DagMessage[];
}

const MAX_MESSAGES = 50;
const STATUS_VALUES: NodeStatus[] = ["pending", "active", "done"];

/** Accept common aliases (incl. Chinese) for status values. */
function normalizeStatus(raw: string): NodeStatus | undefined {
	const s = raw.trim().toLowerCase();
	if (["pending", "todo", "未开始", "待开始"].includes(s)) return "pending";
	if (["active", "in_progress", "in-progress", "doing", "进行中"].includes(s)) return "active";
	if (["done", "completed", "complete", "finished", "已完成", "完成"].includes(s)) return "done";
	return undefined;
}

function emptyGraph(): DagGraph {
	return { nodes: [], edges: [], messages: [] };
}

function sanitizeGraph(raw: unknown): DagGraph {
	const g = emptyGraph();
	if (!raw || typeof raw !== "object") return g;
	const r = raw as { nodes?: unknown; edges?: unknown; messages?: unknown };
	if (Array.isArray(r.messages)) {
		for (const m of r.messages) {
			if (!m || typeof m !== "object") continue;
			const msg = m as Partial<DagMessage>;
			if (typeof msg.id !== "string" || typeof msg.text !== "string") continue;
			g.messages.push({ id: msg.id, text: msg.text, ts: typeof msg.ts === "number" ? msg.ts : Date.now() });
		}
		if (g.messages.length > MAX_MESSAGES) g.messages = g.messages.slice(-MAX_MESSAGES);
	}
	if (Array.isArray(r.nodes)) {
		for (const n of r.nodes) {
			if (!n || typeof n !== "object") continue;
			const node = n as Partial<DagNode>;
			if (typeof node.id !== "string" || typeof node.name !== "string") continue;
			g.nodes.push({
				id: node.id,
				name: node.name,
				brief: typeof node.brief === "string" ? node.brief : "",
				files: Array.isArray(node.files) ? node.files.filter((f): f is string => typeof f === "string") : [],
				status: STATUS_VALUES.includes(node.status as NodeStatus) ? (node.status as NodeStatus) : "pending",
			});
		}
	}
	if (Array.isArray(r.edges)) {
		const ids = new Set(g.nodes.map((n) => n.id));
		for (const e of r.edges) {
			if (!e || typeof e !== "object") continue;
			const edge = e as Partial<DagEdge>;
			if (typeof edge.id !== "string" || typeof edge.source !== "string" || typeof edge.target !== "string") continue;
			if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
			g.edges.push({ id: edge.id, source: edge.source, target: edge.target, note: typeof edge.note === "string" ? edge.note : "" });
		}
	}
	return g;
}

/** URL-safe slug for a display name (ASCII only; fallback "project"). */
function slugify(name: string): string {
	const s = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	if (!s) return "project";
	return /^[a-z]/.test(s) ? s : `p-${s}`;
}

// ---------------------------------------------------------------------------
// Session state (per extension instance)
// ---------------------------------------------------------------------------

let sessionCwd = process.cwd();
let graph: DagGraph = emptyGraph();
let graphLoaded = false;
let assignedSlug: string | undefined;

function graphDir(): string {
	return join(sessionCwd, ".codeplay");
}

function graphFile(): string {
	return join(graphDir(), "graph.json");
}

async function ensureLoaded(): Promise<void> {
	if (graphLoaded) return;
	graphLoaded = true;
	try {
		graph = sanitizeGraph(JSON.parse(await readFile(graphFile(), "utf8")));
	} catch {
		graph = emptyGraph();
	}
}

async function persist(): Promise<void> {
	await mkdir(graphDir(), { recursive: true });
	await writeFile(graphFile(), JSON.stringify(graph, null, 2), "utf8");
}

/** Project name is simply the working directory's folder name. */
function displayName(): string {
	const base = sessionCwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
	return base || sessionCwd;
}

// ---------------------------------------------------------------------------
// Hub client
// ---------------------------------------------------------------------------

const HUB_PORT = Number(process.env.CODEPLAY_HUB_PORT ?? 7700);
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const HEARTBEAT_MS = 5000;
const HUB_RETRY_BACKOFF_MS = 20000;
const HUB_PATH = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "hub.mjs");
const DEBUG = !!process.env.CODEPLAY_DEBUG;

let heartbeat: ReturnType<typeof setInterval> | undefined;
let hubFailBackoffUntil = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const debug = (msg: string, e?: unknown) => {
	if (DEBUG) console.error(`[codeplay] ${msg}`, e instanceof Error ? e.message : (e ?? ""));
};

/**
 * Raw node:http request to the hub. Deliberately NOT fetch(): providers/CLIs
 * may install a global undici dispatcher or proxy that would hijack (and hang)
 * requests to 127.0.0.1. node:http is immune to both that and env proxies.
 */
function hubRequest(
	method: string,
	path: string,
	body?: unknown,
	timeoutMs = 1200,
): Promise<{ status: number; json: Record<string, unknown> }> {
	return new Promise((resolveReq, rejectReq) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port: HUB_PORT,
				path,
				method,
				headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
				timeout: timeoutMs,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					let json: Record<string, unknown> = {};
					try {
						json = JSON.parse(Buffer.concat(chunks).toString() || "{}");
					} catch {
						// leave as {}
					}
					resolveReq({ status: res.statusCode ?? 0, json });
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("hub request timeout")));
		req.on("error", rejectReq);
		if (data) req.write(data);
		req.end();
	});
}

async function hubAlive(): Promise<boolean> {
	try {
		const res = await hubRequest("GET", "/api/hub", undefined, 800);
		return res.status === 200 && res.json.app === "codeplay-hub";
	} catch {
		return false;
	}
}

/** Make sure the hub daemon is running; spawn it detached if needed. Bounded and backed off. */
async function ensureHub(): Promise<void> {
	if (Date.now() < hubFailBackoffUntil) {
		throw new Error("hub marked unavailable (backoff)");
	}
	if (await hubAlive()) return;
	spawn(process.execPath, [HUB_PATH], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env },
	}).unref();
	for (let i = 0; i < 12; i++) {
		await sleep(100);
		if (await hubAlive()) return;
	}
	hubFailBackoffUntil = Date.now() + HUB_RETRY_BACKOFF_MS;
	throw new Error(`codeplay hub failed to start (is 127.0.0.1:${HUB_PORT} occupied by another program?)`);
}

/** Push the full graph state to the hub. Never throws; returns success. */
async function pushState(): Promise<boolean> {
	try {
		await ensureLoaded();
		await ensureHub();
		const want = assignedSlug ?? slugify(displayName());
		const res = await hubRequest("POST", `/api/p/${want}/state`, {
			name: displayName(),
			cwd: sessionCwd,
			graph,
			pid: process.pid,
		}, 2000);
		if (res.status === 200 && typeof res.json.slug === "string") {
			assignedSlug = res.json.slug;
			return true;
		}
		debug("pushState: unexpected hub response", res.status);
		return false;
	} catch (e) {
		debug("pushState failed", e);
		return false;
	}
}

async function unregister(): Promise<void> {
	if (!assignedSlug) return;
	try {
		await hubRequest("DELETE", `/api/p/${assignedSlug}/state`, { cwd: sessionCwd }, 1200);
	} catch {
		// ignore
	}
}

function startHeartbeat(): void {
	stopHeartbeat();
	heartbeat = setInterval(() => {
		void pushState();
	}, HEARTBEAT_MS);
	heartbeat.unref?.();
}

function stopHeartbeat(): void {
	if (heartbeat) clearInterval(heartbeat);
	heartbeat = undefined;
}

function panelUrl(): string {
	return `${HUB_URL}/${assignedSlug ?? slugify(displayName())}/`;
}

/**
 * Run a mutation serialized on the graph file, then persist + sync to hub.
 * Hub sync is fire-and-forget so a slow/absent hub can never stall the agent;
 * the 5s heartbeat keeps the panel converging regardless.
 */
async function mutate<T>(fn: () => T | Promise<T>): Promise<T> {
	return withFileMutationQueue(graphFile(), async () => {
		await ensureLoaded();
		const result = await fn();
		await persist();
		void pushState();
		return result;
	});
}

// ---------------------------------------------------------------------------
// Browser opening (lazy: first dag_* tool call opens the panel once)
// ---------------------------------------------------------------------------

let panelOpened = false;

function openBrowser(url: string): void {
	// Test hook: lets tests observe/intercept the open instead of spawning a browser.
	const hook = (globalThis as { __codeplayOpenHook?: (url: string) => void }).__codeplayOpenHook;
	if (hook) {
		hook(url);
		return;
	}
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	childExec(`${cmd} "${url}"`, () => {
		// ignore errors (headless environments etc.)
	});
}

/** Open the browser panel exactly once per session (on first dag_* tool use). */
async function ensurePanelOpen(): Promise<void> {
	if (panelOpened) return;
	await pushState();
	panelOpened = true;
	openBrowser(panelUrl());
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function nextId(items: { id: string }[], prefix: string): string {
	const used = new Set(items.map((i) => i.id));
	for (let i = 1; ; i++) {
		const id = `${prefix}${i}`;
		if (!used.has(id)) return id;
	}
}

function findNode(id: string): DagNode | undefined {
	return graph.nodes.find((n) => n.id === id);
}

function findEdge(id: string): DagEdge | undefined {
	return graph.edges.find((e) => e.id === id);
}

/** Would adding source->target create a cycle? (DFS: is source reachable from target?) */
function createsCycle(source: string, target: string, extra?: { source: string; target: string }): boolean {
	const adj = new Map<string, string[]>();
	for (const e of graph.edges) {
		if (!adj.has(e.source)) adj.set(e.source, []);
		adj.get(e.source)?.push(e.target);
	}
	if (extra) {
		if (!adj.has(extra.source)) adj.set(extra.source, []);
		adj.get(extra.source)?.push(extra.target);
	}
	const seen = new Set<string>();
	const stack = [target];
	while (stack.length) {
		const cur = stack.pop() as string;
		if (cur === source) return true;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
	}
	return false;
}

function statusIcon(s: NodeStatus): string {
	return s === "done" ? "✓" : s === "active" ? "▶" : "○";
}

function renderGraphText(): string {
	if (graph.nodes.length === 0) return "Graph is empty. Use dag_add_node to create nodes.";
	const lines: string[] = [];
	lines.push(`Nodes (${graph.nodes.length}):`);
	for (const n of graph.nodes) {
		const brief = n.brief ? ` — ${n.brief}` : "";
		const files = n.files.length > 0 ? ` [files: ${n.files.length}]` : "";
		lines.push(`  ${n.id} ${statusIcon(n.status)} ${n.name}${brief}${files}`);
	}
	lines.push(`Edges (${graph.edges.length}):`);
	for (const e of graph.edges) {
		const note = e.note ? ` (${e.note})` : "";
		lines.push(`  ${e.id}: ${e.source} -> ${e.target}${note}`);
	}
	lines.push("Legend: ○ pending, ▶ active, ✓ done");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function err(text: string) {
	return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: {} };
}

/** Split a user/LLM-provided file list (comma or newline separated). */
function parseFiles(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((f) => f.trim().replace(/^@/, ""))
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function codeplay(pi: ExtensionAPI) {
	// -- lifecycle -----------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		sessionCwd = ctx.cwd;
		graphLoaded = false; // reload graph for (possibly) new cwd
		graph = emptyGraph();
		assignedSlug = undefined;
		await ensureLoaded();
		startHeartbeat(); // pushes state every 5s; first push spawns the hub if needed
		void pushState(); // fire-and-forget: never block pi startup on panel sync
		// The panel opens lazily on the first dag_* tool call. After a reload the
		// existing tab reconnects via SSE, so count it as already open.
		panelOpened = event.reason === "reload";
		if (ctx.hasUI) {
			ctx.ui.notify(`codeplay panel: ${panelUrl()}`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		stopHeartbeat();
		await unregister();
	});

	// -- system prompt --------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections.dag_visualization = [
			"You have a live DAG visualization panel (it opens in the user's browser the first time you use a dag_* tool) that acts as a shared communication medium between you and the user.",
			"A DAG here can represent task progress, project architecture, dependencies, or data flow.",
			"",
			"How to work with it:",
			"- Grow the graph incrementally as the work unfolds: add a node with dag_add_node when you start a new part, connect it with dag_add_edge, and keep nodes updated with dag_update_node. Do NOT draw the whole graph up front — add and refine a few nodes/edges at a time as you actually progress.",
			"- Match the graph's granularity to the task: for a simple task use finer-grained nodes (small steps, so the user sees steady progress); for a complex/hard task use coarser-grained nodes (a few big phases) and only split a node into finer ones later if that part actually needs it.",
			"- While coding, keep the graph in sync: mark nodes active when you start working on them and done when finished (dag_update_node with field=status). Attach the files each node covers (field=files).",
			"- Node status is one of: pending (未开始), active (进行中), done (已完成).",
			"- Be generous with intermediate progress updates via dag_announce (the panel's announcement board, 公告栏): announce BEFORE you start adding a new module, BEFORE you start running tests, when you finish a step, when you make a key decision, and when you hit a blocker. Frequent short messages are encouraged — never stay silent until the whole task is done.",
			"- Nodes and edges use short IDs (n1, e1, ...). dag_view shows the whole graph as compact text.",
			"- dag_update_node / dag_update_edge take (id, field, value) and update exactly one field per call.",
			"- The graph persists per directory: if the user starts a new, unrelated project in the same directory, reset the canvas first with dag_clear (confirm: true).",
			"- The graph is a communication aid, not the deliverable: keep it accurate but concise, and never let graph maintenance delay actual coding.",
		].join("\n");
	});

	// -- command ---------------------------------------------------------------

	pi.registerCommand("dag", {
		description: "Open this project's codeplay DAG panel in the browser",
		handler: async (_args, ctx) => {
			await pushState();
			panelOpened = true;
			openBrowser(panelUrl());
			ctx.ui.notify(`codeplay panel: ${panelUrl()}`, "info");
		},
	});

	// -- tools -----------------------------------------------------------------

	pi.registerTool({
		name: "dag_view",
		label: "DAG View",
		description: "View the current DAG (nodes with status, edges with notes) as compact text.",
		promptSnippet: "View the shared DAG (plan/architecture) as compact text",
		parameters: Type.Object({}),
		async execute() {
			await ensurePanelOpen();
			await ensureLoaded();
			return ok(renderGraphText());
		},
	});

	pi.registerTool({
		name: "dag_clear",
		label: "DAG Clear",
		description:
			"Wipe the whole canvas: remove ALL nodes, edges and announcement messages. The graph persists per directory, so use this when the user starts a new, unrelated project in the same directory. Requires confirm: true.",
		promptSnippet: "Wipe the whole DAG canvas (requires confirm: true)",
		promptGuidelines: [
			"Use dag_clear only when the user explicitly starts a fresh, unrelated project/canvas in the same directory — it wipes all nodes, edges and messages.",
		],
		parameters: Type.Object({
			confirm: Type.Boolean({ description: "Must be true to confirm wiping the canvas" }),
		}),
		async execute(_id, params) {
			await ensurePanelOpen();
			if (params.confirm !== true) return err("refused: pass confirm: true to wipe the canvas");
			return mutate(() => {
				const counts = `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.messages.length} messages`;
				graph.nodes = [];
				graph.edges = [];
				graph.messages = [];
				return ok(`Cleared canvas (removed ${counts})`);
			});
		},
	});

	pi.registerTool({
		name: "dag_announce",
		label: "DAG Announce",
		description:
			"Push a short milestone progress message to the panel's announcement board (公告栏). The user can expand the board in the canvas and read the messages one by one.",
		promptSnippet: "Push a milestone progress message to the panel's announcement board",
		promptGuidelines: [
			"Use dag_announce at meaningful checkpoints (phase done, key decision, blocker) to push a short progress message to the panel's announcement board.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Short progress message, one line" }),
		}),
		async execute(_id, params) {
			await ensurePanelOpen();
			return mutate(() => {
				const text = params.message.trim();
				if (!text) return err("message must not be empty");
				const id = nextId(graph.messages, "m");
				graph.messages.push({ id, text: text.slice(0, 280), ts: Date.now() });
				if (graph.messages.length > MAX_MESSAGES) graph.messages = graph.messages.slice(-MAX_MESSAGES);
				return ok(`Announced ${id}`);
			});
		},
	});

	pi.registerTool({
		name: "dag_add_node",
		label: "DAG Add Node",
		description: "Add a node to the DAG. Returns the new short node id (e.g. n3).",
		promptSnippet: "Add a node to the shared DAG",
		promptGuidelines: [
			"Use dag_add_node to create plan/architecture nodes before or while coding so the user can follow progress in the DAG panel.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short node name" }),
			brief: Type.Optional(Type.String({ description: "One-line description of the node" })),
			files: Type.Optional(Type.String({ description: "Files covered by this node, comma-separated" })),
			status: Type.Optional(Type.String({ description: "pending | active | done (default: pending)" })),
		}),
		async execute(_id, params) {
			await ensurePanelOpen();
			return mutate(() => {
				const status = params.status ? normalizeStatus(params.status) : "pending";
				if (!status) return err(`invalid status "${params.status}", use pending/active/done`);
				const id = nextId(graph.nodes, "n");
				graph.nodes.push({
					id,
					name: params.name,
					brief: params.brief ?? "",
					files: params.files ? parseFiles(params.files) : [],
					status,
				});
				return ok(`Added node ${id} (${params.name})`);
			});
		},
	});

	pi.registerTool({
		name: "dag_update_node",
		label: "DAG Update Node",
		description:
			"Update one field of a node. field is one of: name, brief, status, files. value is the new content of that field (for files: comma-separated paths; for status: pending/active/done).",
		promptSnippet: "Update one field (name/brief/status/files) of a DAG node",
		promptGuidelines: [
			"Use dag_update_node with field=status to mark nodes active/done as you work, and field=files to record which files each node covers.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Node id, e.g. n1" }),
			field: StringEnum(["name", "brief", "status", "files"] as const),
			value: Type.String({ description: "New value for the field" }),
		}),
		async execute(_id, params) {
			await ensurePanelOpen();
			return mutate(() => {
				const node = findNode(params.id);
				if (!node) return err(`node ${params.id} not found`);
				switch (params.field) {
					case "name":
						node.name = params.value;
						break;
					case "brief":
						node.brief = params.value;
						break;
					case "files":
						node.files = parseFiles(params.value);
						break;
					case "status": {
						const status = normalizeStatus(params.value);
						if (!status) return err(`invalid status "${params.value}", use pending/active/done`);
						node.status = status;
						break;
					}
				}
				return ok(`Updated ${params.id}.${params.field}`);
			});
		},
	});

	pi.registerTool({
		name: "dag_remove_node",
		label: "DAG Remove Node",
		description: "Remove a node and all edges connected to it.",
		promptSnippet: "Remove a node (and its edges) from the DAG",
		parameters: Type.Object({
			id: Type.String({ description: "Node id, e.g. n1" }),
		}),
		async execute(_id, params) {
			await ensurePanelOpen();
			return mutate(() => {
				const node = findNode(params.id);
				if (!node) return err(`node ${params.id} not found`);
				graph.nodes = graph.nodes.filter((n) => n.id !== params.id);
				const removedEdges = graph.edges.filter((e) => e.source === params.id || e.target === params.id).length;
				graph.edges = graph.edges.filter((e) => e.source !== params.id && e.target !== params.id);
				return ok(`Removed node ${params.id} (${node.name}) and ${removedEdges} connected edge(s)`);
			});
		},
	});

	pi.registerTool({
		name: "dag_add_edge",
		label: "DAG Add Edge",
		description: "Add a directed edge between two nodes. Cycles are rejected (the graph must stay acyclic).",
		promptSnippet: "Add a directed edge to the shared DAG",
		parameters: Type.Object({
			source: Type.String({ description: "Source node id, e.g. n1" }),
			target: Type.String({ description: "Target node id, e.g. n2" }),
			note: Type.Optional(Type.String({ description: "Edge note, e.g. 'depends on', 'data flow'" })),
		}),
		async execute(_id, params) {
			await ensurePanelOpen();
			return mutate(() => {
				if (!findNode(params.source)) return err(`node ${params.source} not found`);
				if (!findNode(params.target)) return err(`node ${params.target} not found`);
				if (params.source === params.target) return err("self-loops are not allowed in a DAG");
				if (createsCycle(params.source, params.target)) {
					return err(`edge ${params.source} -> ${params.target} would create a cycle`);
				}
				const id = nextId(graph.edges, "e");
				graph.edges.push({ id, source: params.source, target: params.target, note: params.note ?? "" });
				return ok(`Added edge ${id}: ${params.source} -> ${params.target}`);
			});
		},
	});

	pi.registerTool({
		name: "dag_update_edge",
		label: "DAG Update Edge",
		description:
			"Update one field of an edge. field is one of: source, target, note. value is the new content of that field.",
		promptSnippet: "Update one field (source/target/note) of a DAG edge",
		parameters: Type.Object({
			id: Type.String({ description: "Edge id, e.g. e1" }),
			field: StringEnum(["source", "target", "note"] as const),
			value: Type.String({ description: "New value for the field" }),
		}),
		async execute(_id, params) {
			await ensurePanelOpen();
			return mutate(() => {
				const edge = findEdge(params.id);
				if (!edge) return err(`edge ${params.id} not found`);
				if (params.field === "note") {
					edge.note = params.value;
					return ok(`Updated ${params.id}.note`);
				}
				const nodeId = params.value.trim();
				if (!findNode(nodeId)) return err(`node ${nodeId} not found`);
				const nextSource = params.field === "source" ? nodeId : edge.source;
				const nextTarget = params.field === "target" ? nodeId : edge.target;
				if (nextSource === nextTarget) return err("self-loops are not allowed in a DAG");
				// Temporarily remove this edge, then test the re-pointed edge for cycles.
				graph.edges = graph.edges.filter((e) => e.id !== edge.id);
				const cycle = createsCycle(nextSource, nextTarget);
				graph.edges.push(edge);
				if (cycle) return err(`re-pointing ${params.id} to ${nextSource} -> ${nextTarget} would create a cycle`);
				edge.source = nextSource;
				edge.target = nextTarget;
				return ok(`Updated ${params.id}.${params.field}`);
			});
		},
	});

	pi.registerTool({
		name: "dag_remove_edge",
		label: "DAG Remove Edge",
		description: "Remove an edge from the DAG.",
		promptSnippet: "Remove an edge from the DAG",
		parameters: Type.Object({
			id: Type.String({ description: "Edge id, e.g. e1" }),
		}),
		async execute(_id, params) {
			await ensurePanelOpen();
			return mutate(() => {
				const edge = findEdge(params.id);
				if (!edge) return err(`edge ${params.id} not found`);
				graph.edges = graph.edges.filter((e) => e.id !== params.id);
				return ok(`Removed edge ${params.id} (${edge.source} -> ${edge.target})`);
			});
		},
	});
}
