import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import plugin from "../dist/server.js";
import hostEntry from "../dist/host.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), "pi-command-sync-test-"));
console.log("Retained fixtures:", fixture);

// The backend harness deletes its storage directory on dispose. Do not invoke
// that cleanup; these tests allocate no database, service, or external thread.
test("ordinary Pi addon, validated RPC, CLI and no provider registration", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "pi-command-sync",
    experimental_callHostRpc: ({ method }) => method === "prepareRuntime"
      ? { launcher: "/owned/pi-bb" } : { commands: 7, skillRoots: 2 },
  });
  plugin(bb);
  assert.deepEqual(harness.inspection.registrations.providerRegistrations, []);
  assert.deepEqual([...harness.inspection.registrations.providerEnvResolvers.keys()], ["pi"]);
  const env = await harness.inspection.registrations.providerEnvResolvers.get("pi")({ hostId: "host-test" });
  assert.deepEqual(env, [{ name: "BB_PI_BRIDGE_COMMAND", value: "/owned/pi-bb", reason: "Load native Pi commands in BB" }]);
  assert.deepEqual(await harness.behavior.callRpc("syncCommands", { hostId: "host-test", cwd: null }), { commands: 7, skillRoots: 2 });
  await assert.rejects(harness.behavior.callRpc("syncCommands", { hostId: "host-test", cwd: null, unexpected: true }));
  const cli = await harness.behavior.runCli(["sync", "--host", "host-test", "--cwd", "/workspace"]);
  assert.equal(cli.exitCode, 0);
  assert.equal(JSON.parse(cli.stdout).providerId, "pi");
  assert.equal((await harness.behavior.runCli(["sync", "--host", "host-test", "--bad"])).exitCode, 1);
  assert.equal(harness.inspection.sdk.calls.length, 0, "No default-provider or thread mutation");
});

test("packaged source uses public contracts and carries no master checkout dependency", () => {
  const target = join(fixture, "package");
  mkdirSync(target);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  cpSync(join(root, "package.json"), join(target, "package.json"));
  for (const entry of manifest.files) cpSync(join(root, entry), join(target, entry), { recursive: true });
  const scan = experimental_scanPublicSdkOnly(target, { allow: [/^@earendil-works\/pi-coding-agent$/, /^typebox$/] });
  // Its regex also reads diagnostic strings and terminal command names as
  // imports. Bound the three exact false captures; never allow private packages.
  const falseCaptures = new Set(["runtime/commands.ts:, "]);
  const violations = scan.violations.filter(v => {
    const key = v.file + ":" + v.specifier;
    return !(v.reason === "outside-allowlist" && falseCaptures.delete(key));
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(scan.privateDependencies, []);
  const artifact = readFileSync(join(root, "dist/host.js"), "utf8");
  // The built artifact must not depend on the author's checkout layout.
  assert(!/\/Users\/|\/home\/[a-z0-9_-]+\/Projects\//i.test(artifact));
  assert(!artifact.includes("experimental_providerBridge"), "Addon must not ship a second bridge");
  assert(!manifest.bb.skills, "Do not register stale Pi+ instructions");
  assert(!manifest.files.includes("vendor"));
});

test("real cold Pi registry exports commands and imported project skill roots", async () => {
  const dataDir = join(fixture, "data's quoted directory");
  const cwd = join(fixture, "workspace");
  mkdirSync(cwd);
  mkdirSync(join(cwd, ".pi/extensions"), { recursive: true });
  writeFileSync(join(cwd, ".pi/extensions/menu-probe.ts"),
    'export default pi => pi.registerCommand("menu-sync-probe", {description:"Isolated menu test", handler: async()=>{}});');
  const importedSkills = join(fixture, "imported-skills");
  mkdirSync(join(importedSkills, "ce-imported-probe"), { recursive: true });
  writeFileSync(join(importedSkills, "ce-imported-probe/SKILL.md"),
    "---\nname: ce-imported-probe\ndescription: Isolated imported skill fixture\n---\nUse only in the isolated test.\n");
  writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ skills: [importedSkills] }));
  const agentDir = join(fixture, "isolated-agent-profile");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", enableInstallTelemetry: false }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.HOME = fixture;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: fixture } });
  try {
    const first = await harness.experimental_call("prepareRuntime", null);
    assert.equal(first.launcher, (await harness.experimental_call("prepareRuntime", null)).launcher);
    assert(readFileSync(first.launcher, "utf8").includes("--extension"));
    const counts = await harness.experimental_call("syncCommands", { cwd });
    assert(counts.commands >= 7);
    const menu = join(fixture, ".pi/bb-commands");
    const key = createHash("sha256").update(cwd).digest("hex");
    const pointerPath = join(menu, "projects", key + ".json");
    const snapshot = JSON.parse(readFileSync(pointerPath, "utf8"));
    assert.match(snapshot.snapshot, /^[a-f0-9]{64}$/);
    const directory = join(menu, "catalog", snapshot.snapshot);
    const names = readdirSync(directory);
    assert(names.includes("reload.md"));
    assert(names.includes("menu-sync-probe.md"));
    assert(snapshot.skillRoots.some(r => r.path === importedSkills && r.origin === "project"), "Imported project skills retain their scope");
    writeFileSync(pointerPath, JSON.stringify({ snapshot: "../../outside", skillRoots: [] }));
    await harness.experimental_call("syncCommands", { cwd });
    assert.match(JSON.parse(readFileSync(pointerPath, "utf8")).snapshot, /^[a-f0-9]{64}$/);
    await assert.rejects(harness.experimental_call("resolveNativeRoots", { providerId: "pi", cwd }));
    await assert.rejects(harness.experimental_call("syncCommands", { cwd: "relative" }));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(harness.experimental_call("syncCommands", { cwd }, { signal: controller.signal }));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await harness.experimental_dispose();
  }
});
