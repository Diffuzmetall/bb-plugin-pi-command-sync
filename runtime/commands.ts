import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Explicitly loaded by the BB launcher only; terminal Pi keeps its native UI.
export default function (pi: ExtensionAPI) {
  const report = (content: string) => pi.sendMessage({
    customType: "bb-pi-command", content, display: true,
  }, { triggerTurn: false });
  const reloadKey = Symbol.for("pi-command-sync-reload");
  const state = globalThis as typeof globalThis & { [reloadKey]?: boolean };

  pi.on("session_start", (_event, ctx) => {
    // BB scans Markdown command roots, not Pi's in-memory command registry.
    // Content-addressed snapshots retain old files without stale menu entries.
    const root = process.env.BB_PI_COMMAND_MENU_DIR ?? join(homedir(), ".pi", "bb-commands");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const commands = pi.getCommands().filter(c =>
      /^[a-zA-Z0-9_:.-]+$/.test(c.name) && !c.sourceInfo?.path.includes("/tests/pi_runtime/"));
    const publish = (items: typeof commands, pointer: string) => {
      const entries = items.flatMap(c => c.source === "skill" ? [] : [{ name: c.name, description: c.description ?? "Pi command" }])
        .sort((a, b) => a.name.localeCompare(b.name));
      const snapshot = hash(JSON.stringify(entries));
      const folder = join(root, "catalog", snapshot);
      mkdirSync(folder, { recursive: true });
      for (const entry of entries) {
        writeFileSync(join(folder, `${entry.name}.md`),
          `---\ndescription: ${JSON.stringify(entry.description)}\n---\n/${entry.name}\n`);
      }
      const skillRoots = new Map<string, { path: string; origin: "user" | "project" }>();
      for (const command of items) {
        const file = command.sourceInfo?.path;
        if (command.source !== "skill" || !file || basename(file) !== "SKILL.md") continue;
        const path = dirname(dirname(file));
        const origin = command.sourceInfo?.scope === "project" ? "project" : "user";
        skillRoots.set(path + origin, { path, origin });
      }
      writeFileSync(join(root, pointer), JSON.stringify({ snapshot, skillRoots: [...skillRoots.values()] }) + "\n");
    };
    try {
      mkdirSync(join(root, "projects"), { recursive: true });
      publish(commands.filter(c => c.sourceInfo?.scope !== "project"), "global.json");
      publish(commands, join("projects", `${hash(ctx.cwd)}.json`));
    } catch (error) {
      console.error("BB Pi command menu write failed:", error);
    }
    if (state[reloadKey]) {
      state[reloadKey] = false;
      report("Reloaded Pi extensions, skills, prompts, themes and context files.");
    }
  });
  pi.registerCommand("reload", {
    description: "Reload Pi resources in this BB session (no model request)",
    handler: async (args, ctx) => {
      if (args.trim()) return report("Usage: /reload");
      if (!ctx.isIdle()) return report("Wait for the current Pi run to finish before /reload.");
      state[reloadKey] = true;
      try {
        await ctx.reload();
      } catch (error) {
        state[reloadKey] = false;
        // The old pi/ctx may already be invalid: leave reporting to RPC.
        throw error;
      }
    },
  });
  pi.registerCommand("commands", {
    description: "List the actual Pi commands loaded in this BB session",
    handler: async (args) => {
      const query = args.trim().toLowerCase();
      report(pi.getCommands()
        .flatMap(c => !query || `${c.name} ${c.description ?? ""}`.toLowerCase().includes(query)
          ? [`/${c.name} — ${c.description ?? c.source}`] : [])
        .sort((a, b) => a.localeCompare(b)).join("\n") || "No matching Pi commands.");
    },
  });
  pi.registerCommand("session", {
    description: "Show current Pi session and context usage",
    handler: async (_args, ctx) => report(JSON.stringify({
      sessionId: ctx.sessionManager.getSessionId(),
      name: pi.getSessionName() ?? null,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      thinking: pi.getThinkingLevel(),
      context: ctx.getContextUsage(),
    }, null, 2)),
  });
  pi.registerCommand("name", {
    description: "Set Pi session name: /name <name>",
    handler: async (args) => {
      if (!args.trim()) return report(`Session name: ${pi.getSessionName() ?? "(unnamed)"}`);
      pi.setSessionName(args.trim());
      report(`Pi session name: ${pi.getSessionName()}`);
    },
  });
  pi.registerCommand("thinking", {
    description: "Show/set thinking: /thinking off|minimal|low|medium|high|xhigh|max",
    handler: async (args) => {
      const level = args.trim();
      if (!level) return report(`Thinking: ${pi.getThinkingLevel()}`);
      if (level !== "off" && level !== "minimal" && level !== "low" && level !== "medium" && level !== "high" && level !== "xhigh" && level !== "max") {
        return report("Usage: /thinking off|minimal|low|medium|high|xhigh|max");
      }
      pi.setThinkingLevel(level);
      report(`Thinking: ${pi.getThinkingLevel()}`);
    },
  });
  pi.registerCommand("model", {
    description: "Show/set Pi model: /model <provider/model>; use BB picker for persistent selection",
    handler: async (args, ctx) => {
      const selection = args.trim();
      if (!selection) return report(`Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)"}. Use /model provider/model or the BB model picker.`);
      const separator = selection.indexOf("/");
      const model = separator < 1 ? undefined : ctx.modelRegistry.find(selection.slice(0, separator), selection.slice(separator + 1));
      if (!model) return report("Unknown model. Usage: /model provider/model");
      report(await pi.setModel(model) ? `Pi model: ${model.provider}/${model.id}` : "Provider authentication is unavailable.");
    },
  });

  pi.registerCommand("compact", {
    description: "Compact Pi context in BB: /compact [instructions]",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return report("Wait for the current Pi run to finish before /compact.");
      await new Promise<void>(resolve => ctx.compact({
        customInstructions: args.trim() || undefined,
        onComplete: () => { report("Pi context compacted."); resolve(); },
        onError: error => { report(`Compaction failed: ${error.message}`); resolve(); },
      }));
    },
  });

  // Never turn a terminal-only control into a paid model prompt. Session
  // replacement/authentication must remain owned by BB, not desync its thread.
  const terminalCommands = ["settings", "tree", "scoped-models", "export", "import", "share", "bug", "copy", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "resume", "quit"];
  for (const name of terminalCommands) {
    pi.registerCommand(name, {
      description: `Terminal Pi control: /${name} (use BB controls or terminal Pi)`,
      handler: async () => report(`BB cannot render or safely forward /${name}'s terminal/session control. Use the corresponding BB control or run /${name} in terminal Pi. /commands lists loaded extension commands. No model request was made.`),
    });
  }
}
