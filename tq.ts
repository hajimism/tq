#!/usr/bin/env bun
// tq: ask a TypeScript project about a symbol, and get back only what answers it.
// This is the client: it loads no TypeScript, hands the query to the project's daemon, and starts one if none runs.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codeVersion, daemonLog, findRoot, socketPath, usageLog } from "./paths.ts";
import type { Request, Response } from "./server.ts";

type Result = { stdout: string; stderr: string; code: number };

const START_TIMEOUT_MS = 20_000;
const RESPAWN_MS = 5_000;

/** The daemon answered, but not whole: asking again would only repeat the query. */
class BrokenReply extends Error {}

function send(path: string, req: Request): Promise<Response> {
  return new Promise((ok, fail) => {
    let buf = "";
    Bun.connect({
      unix: path,
      socket: {
        open: (s) => void s.write(`${JSON.stringify(req)}\n`),
        data: (_s, chunk) => void (buf += chunk.toString()),
        close: () => {
          try {
            ok(JSON.parse(buf) as Response);
          } catch (e) {
            fail(new BrokenReply(String(e)));
          }
        },
        error: (_s, e) => fail(e),
        connectError: (_s, e) => fail(e),
      },
    }).catch(fail);
  });
}

function startDaemon(root: string) {
  const child = spawn(process.execPath, [join(import.meta.dir, "server.ts"), root], { detached: true, stdio: "ignore" });
  child.unref();
}

async function viaDaemon(root: string, argv: string[]): Promise<Result | undefined> {
  const path = socketPath(root);
  const req: Request = { kind: "query", argv, cwd: process.cwd(), version: codeVersion() };
  const deadline = Date.now() + START_TIMEOUT_MS;
  let spawnedAt = 0;
  while (Date.now() < deadline) {
    try {
      const res = await send(path, req);
      if (res.kind === "result") return res;
      // The daemon runs older code and is stepping aside; start one with the new.
      spawnedAt = 0;
    } catch (e) {
      if (e instanceof BrokenReply) return undefined;
      // Start one, and again if it has not answered in a while: a start can lose to a daemon
      // that was still shutting down. The daemon's lock keeps extra starts from running twice.
      if (Date.now() - spawnedAt > RESPAWN_MS) {
        startDaemon(root);
        spawnedAt = Date.now();
      }
    }
    await Bun.sleep(100);
  }
  return undefined;
}

async function inProcess(argv: string[]): Promise<Result> {
  const { openProject, runQuery } = await import("./engine.ts");
  return runQuery(openProject, argv, process.cwd());
}

function record(entry: Record<string, unknown>) {
  try {
    appendFileSync(usageLog(), `${JSON.stringify(entry)}\n`);
  } catch {
    // The record is for evaluating tq; never let it break a query.
  }
}

// ---------- stats ----------

type Entry = { time: string; root: string; cmd: string; targets: string[]; tokens: number; ms: number; daemon: boolean; code: number };

function stats(args: string[]) {
  const i = args.indexOf("--days");
  const days = i >= 0 ? Number(args[i + 1]) : 7;
  const since = Date.now() - days * 86_400_000;
  const entries = existsSync(usageLog())
    ? readFileSync(usageLog(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Entry)
        .filter((e) => Date.parse(e.time) >= since)
    : [];
  if (!entries.length) return console.log(`No records in the last ${days} days (${usageLog()})`);
  const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  console.log(`Last ${days} days: ${entries.length} queries, ~${entries.reduce((a, e) => a + e.tokens, 0)} output tokens in total`);
  console.log(`Through the background process: ${entries.filter((e) => e.daemon).length} queries, median ${median(entries.filter((e) => e.daemon).map((e) => e.ms))}ms`);
  console.log("\nBy command:");
  for (const [cmd, es] of Map.groupBy(entries, (e) => e.cmd)) {
    const asked = es.filter((e) => e.code === 2).length;
    const failed = es.filter((e) => e.code === 1).length;
    console.log(
      `  ${cmd.padEnd(8)} ${String(es.length).padStart(4)} queries  avg ~${avg(es.map((e) => e.tokens))} tokens  avg ${avg(es.map((e) => e.ms))}ms` +
        (asked ? `  asked to pick ${asked}` : "") +
        (failed ? `  failed ${failed}` : ""),
    );
  }
  console.log("\nBy project:");
  for (const [root, es] of Map.groupBy(entries, (e) => e.root)) console.log(`  ${root}: ${es.length} queries`);
  const symbols = [...Map.groupBy(entries.flatMap((e) => e.targets), (t) => t)].map(([t, xs]) => [t, xs.length] as const);
  symbols.sort((a, b) => b[1] - a[1]);
  console.log("\nMost asked:");
  for (const [t, n] of symbols.slice(0, 10)) console.log(`  ${String(n).padStart(3)}  ${t}`);
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

// ---------- daemon control ----------

async function daemon(sub: string | undefined, root: string | undefined) {
  if (!root) return console.log("No tsconfig.json found");
  const path = socketPath(root);
  if (sub !== "status" && sub !== "stop") return console.log("tq daemon status|stop");
  try {
    const res = await send(path, { kind: sub });
    if (res.kind !== "status") return;
    const mins = Math.round((Date.now() - res.startedAt) / 60_000);
    console.log(`${sub === "stop" ? "Stopped" : "Running"}: pid ${res.pid}, ${res.root}, ${res.files} files, ${res.queries} queries, up ${mins} min`);
    if (res.version !== codeVersion()) console.log("(Running old code. It will be replaced on the next query.)");
  } catch {
    console.log(`Not running (${root}). Log: ${daemonLog()}`);
  }
}

// ---------- main ----------

const argv = process.argv.slice(2);
const noDaemon = argv.includes("--no-daemon");
const args = argv.filter((a) => a !== "--no-daemon");
const pi = args.indexOf("--project");
const root = findRoot(resolve((pi >= 0 && args[pi + 1]) || "."));

if (args[0] === "stats") {
  stats(args);
} else if (args[0] === "daemon") {
  await daemon(args[1], root);
} else {
  const t0 = performance.now();
  const wantsProject = args.length > 1 && args[0] !== "help";
  let result: Result | undefined;
  let daemonUsed = false;
  if (wantsProject && root && !noDaemon) {
    result = await viaDaemon(root, args);
    daemonUsed = !!result;
  }
  result ??= await inProcess(args);
  process.stdout.write(result.stdout);
  if (process.env.TQ_VERBOSE) process.stderr.write(result.stderr);
  if (wantsProject) {
    const flagsWithValue = new Set(["--project", "--budget", "--limit"]);
    const targets = args.slice(1).filter((a, i, xs) => !a.startsWith("--") && !flagsWithValue.has(xs[i - 1] ?? ""));
    record({
      time: new Date().toISOString(),
      root,
      cmd: args[0],
      targets,
      flags: args.filter((a) => a.startsWith("--")),
      tokens: Math.ceil(Buffer.byteLength(result.stdout) / 4),
      ms: Math.round(performance.now() - t0),
      daemon: daemonUsed,
      code: result.code,
    });
  }
  process.exitCode = result.code;
}
