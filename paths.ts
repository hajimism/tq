// Where tq keeps its sockets, logs, and usage record. Shared by the client and the daemon, and loads no TypeScript.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const here = import.meta.dir;

/** A socket per project root. Kept short: a Unix socket path must fit in about 100 bytes. */
export function socketPath(root: string): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(tmpdir(), `tq-${id}.sock`);
}

export function cacheDir(): string {
  const dir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "tq");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const usageLog = () => join(cacheDir(), "usage.jsonl");
export const daemonLog = () => join(cacheDir(), "daemon.log");

/** Changes whenever tq's own code does, so a daemon running old code steps aside. */
export function codeVersion(): string {
  return ["engine.ts", "server.ts", "paths.ts"].map((f) => statSync(join(here, f)).mtimeMs).join("-");
}

/** The directory holding the tsconfig.json that applies to dir, found the way TypeScript finds it. */
export function findRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "tsconfig.json"))) return d;
    if (dirname(d) === d) return undefined;
  }
}
