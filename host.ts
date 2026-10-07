import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { extensionSource } from "./extension-source.js";
import { hostContract } from "./contract.js";

const pointerSchema = z.object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/), skillRoots: z.array(z.object({ path: z.string().refine(isAbsolute), origin: z.enum(["user", "project"]) })).max(32).default([]) });
const responseSchema = z.object({ type: z.literal("response"), id: z.literal("pi-command-sync"), success: z.boolean() });
const pending = new Map<string, Promise<void>>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let cliPath: string | null | undefined;
function npmPiEntry() {
  if (cliPath !== undefined) return cliPath;
  const candidates = [
    join(dirname(dirname(process.execPath)), "lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).flatMap(directory => directory ? [join(directory, "pi")] : []),
  ];
  cliPath = null;
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (resolved.includes("/node_modules/@earendil-works/pi-coding-agent/") && resolved.endsWith(".js")) {
        cliPath = resolved; break;
      }
    } catch { /* Try the next installed executable, without invoking npm. */ }
  }
  return cliPath;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// One launcher, so a second addon cannot replace this one's extension by
// contributing BB_PI_BRIDGE_COMMAND itself. The optional extension is loaded
// only when another plugin supplies all five variables, and never for the
// --no-session discovery child.
function launcherSource(invocation: string, extension: string, menu: string) {
  const commands = `--extension ${quote(extension)}`;
  return `#!/bin/sh\nexport BB_PI_COMMAND_MENU_DIR=${quote(menu)}\n` +
    `if [ -n "\${BB_PI_SUBAGENTS_EXTENSION:-}" ] && [ -n "\${BB_PI_SUBAGENTS_ROOT:-}" ] && [ -n "\${BB_PI_SUBAGENTS_THREAD_ID:-}" ] && [ -n "\${BB_PI_SUBAGENTS_SLOT:-}" ] && [ -n "\${BB_PI_SUBAGENTS_NONCE:-}" ]; then\n` +
    `  for arg in "$@"; do\n    if [ "$arg" = "--no-session" ]; then exec ${invocation} "$@" ${commands}; fi\n  done\n` +
    `  exec ${invocation} "$@" ${commands} --extension "$BB_PI_SUBAGENTS_EXTENSION"\nfi\n` +
    `exec ${invocation} "$@" ${commands}\n`;
}

export function prepareRuntime(dataDir: string) {
  if (process.platform === "win32") throw new Error("Pi Command Sync supports Linux and macOS hosts; Windows is not verified.");
  const cli = npmPiEntry();
  const invocation = cli ? `${quote(process.execPath)} ${quote(cli)}` : "pi";
  // The compatible ordinary-Pi bridge reads this BB-only catalog, not terminal Pi skills.
  const menu = join(homedir(), ".pi", "bb-commands");
  const folder = join(dataDir, "runtime", hash(extensionSource + invocation + menu + "pi-subagents-env-bridge-v1"));
  const extension = join(folder, "commands.ts");
  const launcher = join(folder, "pi-bb");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!existsSync(extension)) writeFileSync(extension, extensionSource, { mode: 0o600 });
  if (!existsSync(launcher)) writeFileSync(launcher, launcherSource(invocation, extension, menu), { mode: 0o700 });
  return { launcher, menu };
}

function pointer(menu: string, cwd: string | null) {
  const keys = cwd ? [join("projects", hash(cwd) + ".json"), "global.json"] : ["global.json"];
  for (const key of keys) {
    try {
      const data = pointerSchema.parse(JSON.parse(readFileSync(join(menu, key), "utf8")));
      const directory = join(menu, "catalog", data.snapshot);
      if (existsSync(directory)) return { ...data, directory };
    } catch { /* A missing/incomplete snapshot is not a trusted root. */ }
  }
  return null;
}

async function collect(launcher: string, cwd: string, signal: AbortSignal) {
  if (!isAbsolute(cwd)) throw new Error("Pi command sync requires an absolute cwd.");
  if (signal.aborted) throw new Error("Pi command sync cancelled.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher, ["--mode", "rpc", "--no-session"], { cwd, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let completed = false;
    const timer = setTimeout(() => finish(new Error("Pi command discovery timed out.")), 20_000);
    const cancel = () => finish(new Error("Pi command sync cancelled."));
    function finish(error?: Error) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      child.once("close", () => { if (error) reject(error); else resolve(); });
      if (child.pid !== undefined) {
        // Only this disposable discovery group; retain its files and skip cleanup hooks.
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }
    signal.addEventListener("abort", cancel, { once: true });
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.on("exit", () => { if (!completed) finish(new Error("Pi exited before reporting commands.")); });
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error("Pi discovery output exceeded the limit."));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const response = responseSchema.safeParse(JSON.parse(line));
          if (response.success) finish(response.data.success ? undefined : new Error("Pi rejected get_commands."));
        } catch { /* Unrelated startup diagnostics are not RPC responses. */ }
      }
    });
    child.stdin.write(JSON.stringify({ type: "get_commands", id: "pi-command-sync" }) + "\n");
  });
}

async function synchronize(cwd: string | null, context: ExperimentalHostRpcContext, force: boolean) {
  if (cwd !== null && !isAbsolute(cwd)) throw new Error("Pi command sync requires an absolute cwd.");
  const runtime = prepareRuntime(context.experimental_paths.dataDir);
  const directory = cwd ?? homedir();
  const projectPointer = join(runtime.menu, "projects", hash(directory) + ".json");
  if (force || !existsSync(projectPointer) || pointer(runtime.menu, directory) === null) {
    const key = runtime.menu + "\0" + directory;
    let work = pending.get(key);
    if (!work) {
      work = collect(runtime.launcher, directory, context.signal).finally(() => pending.delete(key));
      pending.set(key, work);
    }
    await work;
  }
  const snapshot = pointer(runtime.menu, directory);
  if (!snapshot) throw new Error("Pi did not export a valid command menu.");
  return snapshot;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    prepareRuntime: async (_input, context) => {
      await synchronize(null, context, false);
      return { launcher: prepareRuntime(context.experimental_paths.dataDir).launcher };
    },
    syncCommands: async ({ cwd }, context) => {
      const snapshot = await synchronize(cwd, context, true);
      return { commands: readdirSync(snapshot.directory).filter(file => file.endsWith(".md")).length, skillRoots: snapshot.skillRoots.length };
    },
  },
});
