import assert from "node:assert/strict";
import vm from "node:vm";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const start = input.indexOf("var Jn=class ");
const end = input.indexOf(';import{homedir as FZ}', start);
assert(start >= 0 && end > start, "Expected BB 0.45 PiRpcSession seam");
const sandbox = {
  s: value => value,
  Ym: 0, yE: 8, ih: 30000,
  le: class extends Error {},
  Promise, Error, setTimeout, clearTimeout,
};
vm.runInNewContext(`${input.slice(start, end)};globalThis.Session=Jn;`, sandbox);
const Session = sandbox.Session;

async function scenario(disposition, streaming = false, compacting = false, queued = false) {
  const session = new Session({}, () => {}, () => {}, error => { throw error; });
  let calls = 0;
  session.isCompacting = compacting;
  session.child = {exited: false, requestOk: async command => {
    if (command.type === "get_state") return {isStreaming: streaming};
    calls++;
    if (queued) session.observeQueue("followUp", ["queued text"]);
    return {disposition};
  }};
  const prompt = session.prompt("/bb-probe");
  await new Promise(resolve => setTimeout(resolve, 10));
  if (queued) {
    assert.equal(session.pendingRunSettlements.length, 0);
    session.observeQueue("followUp", []);
  } else if (disposition !== "handled" || streaming || compacting) {
    assert.equal(session.pendingRunSettlements.length, 1, "Real runs must still await completion");
    session.settleRun({messages: []});
  }
  await prompt.consumed;
  const result = await Promise.race([
    prompt.settled,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Command hangs waiting for nonexistent agent_end")), 150)),
  ]);
  assert.equal(calls, 1);
  assert.equal(session.pendingRunSettlements.length, 0);
  assert.equal(session.pendingInputConsumptions.length, 0);
  if (queued) assert.equal(result, null);
  else assert.deepEqual(JSON.parse(JSON.stringify(result)), {});
  if (disposition === "handled" && !streaming && !compacting && !queued) assert.equal(session.isProcessing, false);
}

await scenario("handled");
await scenario("started");
await scenario("handled", true);
await scenario("handled", false, true);
await scenario("queued", true, false, true);
await scenario("handled", false, false, true);
console.log("PASS: handled completion; started/streaming/compaction/queued/handled-with-queue parity (6 scenarios)");
