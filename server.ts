// The tq daemon: one per project root, holding the project open so a query costs milliseconds, not a second.
// The client starts it on first use; it exits after IDLE_MS without a query, or when tq's own code changes.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Ask, openProject, type Project, runQuery } from "./engine.ts";
import { codeVersion, daemonLog, socketPath } from "./paths.ts";

const IDLE_MS = 30 * 60 * 1000;

export type Request = { kind: "query"; argv: string[]; cwd: string; version: string } | { kind: "status" } | { kind: "stop" };
export type Response =
  | { kind: "result"; stdout: string; stderr: string; code: number }
  | { kind: "restart" }
  | { kind: "status"; pid: number; root: string; files: number; queries: number; startedAt: number; version: string };

const arg = process.argv[2];
if (!arg) throw new Error("usage: bun server.ts <project root>");
const root: string = arg;
const path = socketPath(root);
const version = codeVersion();
const startedAt = Date.now();
let queries = 0;
let project: Project | undefined;

const note = (s: string) => appendFileSync(daemonLog(), `${new Date().toISOString()} ${process.pid} ${s}\n`);

// The daemon serves one root; a query for another project gets one of its own.
const open = (dir: string) => {
  project ??= openProject(dir);
  if (project.root !== root) throw new Ask(`This background process is for ${root}`, 1);
  return project;
};

let idle: ReturnType<typeof setTimeout> | undefined;
const touch = () => {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => shutdown("idle"), IDLE_MS);
};

function shutdown(why: string) {
  note(`exit: ${why}, ${queries} queries`);
  server.stop(true);
  // Only the lock's holder owns the socket; anyone else removing it would cut off the daemon that does.
  if (ownsLock()) {
    rmSync(path, { force: true });
    rmSync(lock, { force: true });
  }
  process.exit(0);
}

function ownsLock(): boolean {
  try {
    return Number(readFileSync(lock, "utf8")) === process.pid;
  } catch {
    return false;
  }
}

// Two clients starting at once each start a daemon; the lock lets one through, and the other leaves.
// Each daemon holds the whole project in memory, so a second one is no small waste.
const lock = `${path}.lock`;
function takeLock(): boolean {
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      const holder = Number(readFileSync(lock, "utf8"));
      if (holder && alive(holder)) return false;
      rmSync(lock, { force: true }); // left by a daemon that died without cleaning up
    }
  }
  return false;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function answer(req: Request): Response {
  if (req.kind === "status")
    return { kind: "status", pid: process.pid, root, files: project?.files.length ?? 0, queries, startedAt, version };
  if (req.kind === "stop") {
    setTimeout(() => shutdown("stopped"), 10);
    return { kind: "status", pid: process.pid, root, files: project?.files.length ?? 0, queries, startedAt, version };
  }
  // tq was updated since this daemon started: make way for one that runs the new code.
  if (req.version !== version) {
    setTimeout(() => shutdown("new version"), 10);
    return { kind: "restart" };
  }
  queries++;
  try {
    return { kind: "result", ...runQuery(open, req.argv, req.cwd) };
  } catch (e) {
    note(`error: ${(e as Error).stack}`);
    return { kind: "result", stdout: "", stderr: `[tq] Internal error: ${(e as Error).message}\n`, code: 1 };
  }
}

if (!takeLock()) process.exit(0);
rmSync(path, { force: true });
type Conn = { buf: string; pending?: Buffer };

// A socket takes only so much at once; write the rest as it drains, and close once all is out.
function flush(socket: Bun.Socket<Conn>) {
  const pending = socket.data.pending;
  if (!pending) return;
  const written = socket.write(pending);
  socket.data.pending = written < pending.length ? pending.subarray(written) : undefined;
  if (!socket.data.pending) socket.end();
}

const server = Bun.listen<Conn>({
  unix: path,
  socket: {
    open(socket) {
      socket.data = { buf: "" };
      touch();
    },
    data(socket, chunk) {
      socket.data.buf += chunk.toString();
      const nl = socket.data.buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(socket.data.buf.slice(0, nl)) as Request;
      socket.data.pending = Buffer.from(`${JSON.stringify(answer(req))}\n`);
      flush(socket);
    },
    drain: flush,
  },
});

// Open the project now, so the client's first query does not wait on it.
try {
  open(root);
} catch (e) {
  note(`open failed: ${(e as Error).message}`);
}
note(`listening for ${root} (${project?.files.length ?? 0} files)`);
touch();
// Without its socket no client can reach this daemon, yet its lock would keep a new one from starting.
setInterval(() => {
  if (!existsSync(path)) shutdown("socket gone");
}, 5_000);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => shutdown(sig));
