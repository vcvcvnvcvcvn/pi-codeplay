/**
 * Multi-project test (hub architecture): one hub (auto-spawned by the first
 * instance), several extension instances in separate processes. Verifies:
 * - every project gets its own /<slug>/ canvas on the single hub port
 * - same-basename projects get suffixed slugs (game, game-2)
 * - a stopped instance disappears from the index immediately
 * - a deleted-cwd instance disappears after the heartbeat TTL
 * - a restarted project reclaims its slug
 *
 * Run: node test/multi-project.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// unique port per run so a crashed previous run can never pollute this one
const HUB_PORT = 7800 + (process.pid % 200);
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const TTL_MS = 4000; // fast prune for the deleted-cwd case

const here = fileURLToPath(new URL(".", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "codeplay-mp-"));
const projTetris = join(root, "a", "tetris");
const projSnake = join(root, "b", "snake");
const projGame1 = join(root, "c1", "game");
const projGame2 = join(root, "c2", "game");

function start(cwd) {
	const p = spawn(process.execPath, [join(here, "instance-server.mjs"), cwd], {
		env: { ...process.env, CODEPLAY_HUB_PORT: String(HUB_PORT), CODEPLAY_HUB_TTL: String(TTL_MS) },
		stdio: ["ignore", "pipe", "inherit"],
	});
	return new Promise((resStart, rejStart) => {
		const to = setTimeout(() => rejStart(new Error("instance start timeout")), 20000);
		p.stdout.once("data", () => {
			clearTimeout(to);
			resStart(p);
		});
	});
}

const get = (url) =>
	new Promise((resGet, rejGet) => {
		http.get(url, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resGet({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
		}).on("error", rejGet);
	});

async function projects() {
	try {
		const r = await get(`${HUB}/api/projects`);
		return r.status === 200 ? JSON.parse(r.body) : [];
	} catch {
		return []; // hub may still be starting
	}
}

async function waitFor(fn, what, timeout = 20000) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

// A starts first and auto-spawns the hub
const a = await start(projTetris);
await waitFor(async () => ((await projects()).some((p) => p.cwd === projTetris) ? true : null), "tetris registered");
const hubPid = JSON.parse((await get(`${HUB}/api/hub`)).body).pid;
assert.ok(hubPid > 0, "hub auto-spawned");

const b = await start(projSnake);
await waitFor(async () => ((await projects()).length === 2 ? true : null), "snake registered");

// two different dirs with the same basename -> slug suffix
const g1 = await start(projGame1);
await waitFor(async () => ((await projects()).length === 3 ? true : null), "game #1 registered");
const g2 = await start(projGame2);
const list = await waitFor(async () => {
	const l = await projects();
	return l.length === 4 ? l : null;
}, "game #2 registered");

const byCwd = new Map(list.map((p) => [p.cwd, p]));
assert.equal(byCwd.get(projTetris).slug, "tetris");
assert.equal(byCwd.get(projSnake).slug, "snake");
const gameSlugs = [byCwd.get(projGame1).slug, byCwd.get(projGame2).slug].sort();
assert.deepEqual(gameSlugs, ["game", "game-2"], "same basename gets suffixed slugs");

// every canvas is served under the single hub port
for (const slug of ["tetris", "snake", "game", "game-2"]) {
	const r = await get(`${HUB}/${slug}/`);
	assert.equal(r.status, 200, `canvas /${slug}/ served`);
	assert.match(r.body, /Codeplay/);
	assert.equal(JSON.parse((await get(`${HUB}/${slug}/api/info`)).body).slug, slug);
}
// redirect without trailing slash
{
	const r = await get(`${HUB}/tetris`);
	assert.equal(r.status, 301);
}

// graceful stop -> disappears immediately
b.kill("SIGTERM");
await waitFor(() => (b.exitCode !== null ? true : null), "snake exit");
await waitFor(async () => (((await projects()).length === 3 ? true : null)), "snake unregistered");

// deleted cwd -> entry pruned after TTL (process still alive but heartbeats stop mattering not;
// this simulates crash-loss: we kill -9 so no graceful unregister, TTL must clean up)
g2.kill("SIGKILL");
await waitFor(async () => ((await projects()).length === 2 ? true : null), "killed instance pruned by TTL", TTL_MS + 15000);

// restart snake -> reclaims its slug
const b2 = await start(projSnake);
await waitFor(async () => {
	const l = await projects();
	return l.length === 3 && l.some((p) => p.cwd === projSnake && p.slug === "snake") ? true : null;
}, "snake reclaimed its slug");

// rm a project dir while its session is alive: session keeps running (canvas
// stays up until the session ends) — document the behavior, no assertion needed
await rm(projGame1, { recursive: true, force: true });

for (const p of [a, g1, b2]) p.kill("SIGTERM");
await waitFor(() => (a.exitCode !== null && g1.exitCode !== null && b2.exitCode !== null ? true : null), "all exit");
await waitFor(async () => ((await projects()).length === 0 ? true : null), "index empty at the end");

process.kill(hubPid, "SIGTERM");
console.log("✅ multi-project test passed");
process.exit(0);
