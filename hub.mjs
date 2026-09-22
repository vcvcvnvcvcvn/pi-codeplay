/**
 * Codeplay hub — single-port panel server.
 *
 * One detached hub process owns the port (default 7700). Pi sessions never
 * listen on a port; they push their full graph state to the hub:
 *
 *   POST   /api/p/:slug/state   { name, cwd, graph, pid }  (also the heartbeat)
 *   DELETE /api/p/:slug/state   { cwd }                    (graceful unregister)
 *
 * The hub serves:
 *   GET /                     project index
 *   GET /api/hub              hub identity/health
 *   GET /api/projects         JSON list of live projects
 *   GET /<slug>/              canvas page for a project
 *   GET /<slug>/api/graph     current graph JSON
 *   GET /<slug>/api/info      project info
 *   GET /<slug>/api/events    SSE stream (broadcast on every state change)
 *   GET /<slug>/<static>      panel assets (app.js, style.css, vendor/...)
 *
 * Liveness: projects heartbeat every ~5s; entries with no push for TTL_MS are
 * pruned. The hub exits after IDLE_EXIT_MS with zero projects.
 */

import { createReadStream, existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CODEPLAY_HUB_PORT ?? 7700);
const TTL_MS = Number(process.env.CODEPLAY_HUB_TTL ?? 15000);
const IDLE_EXIT_MS = Number(process.env.CODEPLAY_HUB_IDLE_EXIT ?? 300000);
const PUBLIC_DIR = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "public");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
};

/** slug -> { slug, name, cwd, pid, startedAt, lastSeen, lastJson, clients:Set } */
const projects = new Map();
let emptySince = Date.now();

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function sendJson(res, code, obj) {
	res.writeHead(code, JSON_HEADERS);
	res.end(JSON.stringify(obj));
}

function broadcast(p) {
	const payload = `data: ${p.lastJson}\n\n`;
	for (const res of p.clients) {
		try {
			res.write(payload);
		} catch {
			p.clients.delete(res);
		}
	}
}

function removeProject(p) {
	for (const res of p.clients) {
		try {
			res.end();
		} catch {
			// ignore
		}
	}
	p.clients.clear();
	projects.delete(p.slug);
	if (projects.size === 0) emptySince = Date.now();
}

function readBody(req) {
	return new Promise((resolveBody, rejectBody) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > 10 * 1024 * 1024) {
				rejectBody(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolveBody(Buffer.concat(chunks).toString()));
		req.on("error", rejectBody);
	});
}

function serveStatic(rel, res) {
	const filePath = normalize(join(PUBLIC_DIR, rel));
	if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
		res.writeHead(404).end("Not found");
		return;
	}
	res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
	createReadStream(filePath).pipe(res);
}

/** First free slug candidate for a cwd-owned rename/conflict. */
function freeSlug(base, cwd) {
	let cand = base;
	let i = 2;
	while (projects.has(cand) && projects.get(cand).cwd !== cwd) {
		cand = `${base}-${i++}`;
	}
	return cand;
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;

		// -- hub-level ---------------------------------------------------------
		if (path === "/api/hub") {
			sendJson(res, 200, { app: "codeplay-hub", version: 1, pid: process.pid, projects: projects.size });
			return;
		}
		if (path === "/api/projects") {
			sendJson(res, 200, [...projects.values()].map((p) => ({
				slug: p.slug,
				project: p.name,
				cwd: p.cwd,
				startedAt: p.startedAt,
			})));
			return;
		}

		// -- session state push / unregister ------------------------------------
		const sm = path.match(/^\/api\/p\/([a-z0-9][a-z0-9-]*)\/state$/);
		if (sm && req.method === "POST") {
			const body = JSON.parse(await readBody(req));
			const { name, cwd, graph, pid } = body ?? {};
			if (typeof name !== "string" || typeof cwd !== "string" || !graph || typeof graph !== "object") {
				sendJson(res, 400, { error: "bad state payload" });
				return;
			}
			let slug = sm[1];
			const byCwd = [...projects.values()].find((p) => p.cwd === cwd);
			if (byCwd && byCwd.slug !== slug) {
				// rename: same session proposing a new slug -> move the entry
				const clients = byCwd.clients;
				const startedAt = byCwd.startedAt;
				projects.delete(byCwd.slug);
				slug = freeSlug(slug, cwd);
				projects.set(slug, { slug, name, cwd, pid, startedAt, lastSeen: Date.now(), lastJson: "", clients });
			} else if (!byCwd) {
				slug = freeSlug(slug, cwd);
				projects.set(slug, { slug, name, cwd, pid, startedAt: Date.now(), lastSeen: Date.now(), lastJson: "", clients: new Set() });
			}
			const entry = projects.get(slug);
			entry.name = name;
			entry.pid = pid;
			entry.lastSeen = Date.now();
			emptySince = null;
			const json = JSON.stringify(graph);
			if (json !== entry.lastJson) {
				entry.lastJson = json;
				broadcast(entry);
			}
			sendJson(res, 200, { slug });
			return;
		}
		if (sm && req.method === "DELETE") {
			const body = JSON.parse((await readBody(req)) || "{}");
			const entry = projects.get(sm[1]);
			if (entry && entry.cwd === body.cwd) removeProject(entry);
			sendJson(res, 200, { ok: true });
			return;
		}

		// -- hub index -----------------------------------------------------------
		if (path === "/" || path === "/projects") {
			serveStatic("projects.html", res);
			return;
		}

		// -- per-project canvas ---------------------------------------------------
		const pm = path.match(/^\/([a-z0-9][a-z0-9-]*)(\/(.*))?$/);
		if (pm) {
			const slug = pm[1];
			const rest = pm[3] ?? "";
			const p = projects.get(slug);
			if (!p) {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(`unknown project "${slug}" — see http://127.0.0.1:${PORT}/ for live projects`);
				return;
			}
			if (pm[2] === undefined) {
				res.writeHead(301, { Location: `/${slug}/` });
				res.end();
				return;
			}
			if (rest === "") {
				serveStatic("index.html", res);
				return;
			}
			if (rest === "api/graph") {
				res.writeHead(200, JSON_HEADERS);
				res.end(p.lastJson || "{}");
				return;
			}
			if (rest === "api/info") {
				sendJson(res, 200, { project: p.name, cwd: p.cwd, slug: p.slug, port: PORT });
				return;
			}
			if (rest === "api/events") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				res.write(`data: ${p.lastJson || "{}"}\n\n`);
				p.clients.add(res);
				req.on("close", () => p.clients.delete(res));
				return;
			}
			serveStatic(rest, res);
			return;
		}

		res.writeHead(404).end("Not found");
	} catch (e) {
		sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`codeplay hub listening on http://127.0.0.1:${PORT}/`);
});

setInterval(() => {
	const now = Date.now();
	for (const p of [...projects.values()]) {
		if (now - p.lastSeen > TTL_MS) removeProject(p);
	}
	if (projects.size === 0 && emptySince !== null && now - emptySince > IDLE_EXIT_MS) {
		process.exit(0);
	}
}, 5000).unref();
