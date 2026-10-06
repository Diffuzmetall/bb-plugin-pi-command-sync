# Pi Command Sync for BB

An addon for the existing **Pi** provider (`pi`). Version 0.2 registers no provider, exports no provider bridge, changes no default, and migrates no thread. The former Pi+ implementation is not part of the installed package.

## Compatibility

Requires BB **0.45.0**, SDK **0.6.15**, Node 22+, installed Pi, and the ordinary Pi bridge's command-menu/completion adapter. The reference installation already has that adapter; see [the bridge repair](tools/pi-runtime/ensure-bb-slash-completion.py) and [compatibility instructions](docs/compatibility.md).

**This is not a standalone fix for an unmodified BB installation.** SDK 0.6.15 has no additive native-command-root or command-completion API for another plugin's provider. This addon does not modify BB files or apply the bridge repair. A BB update may replace that prerequisite; rerun the ordinary-provider checks before claiming compatibility. Linux is tested; macOS and Windows are not verified.

## Connect and synchronize

Clone this private repository with an authenticated GitHub account and build it:

```sh
gh repo clone Diffuzmetall/bb-plugin-pi-command-sync
cd bb-plugin-pi-command-sync
npm ci
npm run build
```

Then connect it:

```sh
bb plugin install /absolute/path/to/bb-plugin-pi-command-sync --yes
bb pi-command-sync sync --host <host-id> --cwd /absolute/workspace
```

For an existing local installation, build, reload and enable it instead of removing it:

```sh
npm run build
bb plugin reload pi-command-sync
bb plugin enable pi-command-sync
```

Continue using **Pi**, not a new provider. The addon contributes `BB_PI_BRIDGE_COMMAND` through BB's public provider-environment API. New Pi processes load a plugin-owned launcher and native-command extension. Processes already running must be gracefully restarted before that contribution applies; `/reload` cannot load a launcher it was never started with. Do not discard the thread or its history.

The first runtime preparation discovers global commands through Pi RPC `get_commands`, without prompting a model. Explicit sync reads the requested workspace. Each Pi session start and `/reload` republishes its registry into the compatible ordinary bridge's BB-only `~/.pi/bb-commands` catalogs. Reopen BB's normal `/` menu to read the refreshed snapshot. Imported skills, including Compound Engineering, remain discovered by ordinary Pi's native skill resolver; this addon adds no instruction skill of its own.

The CLI prints `{ providerId: "pi", commands, skillRoots }`. Plugin RPC `syncCommands` takes `{ hostId, cwd }`; `cwd: null` synchronizes global resources.

## Boundaries

- `/reload`, `/commands`, `/session`, `/thinking`, `/model` and `/name` have native handlers.
- `/compact` can call a model; it is not a no-model smoke test.
- Terminal-only commands such as `/settings`, `/tree`, `/login` and `/resume` explain their limitation instead of falling through to the model.
- Project trust is respected; no production workspace is automatically approved.
- Third-party commands may still require terminal UI. Discovery alone does not prove they work in headless Pi.
- Terminal Pi, BB provider selection and thread history are not rewritten.

## Verify

```sh
npm run build
npm run typecheck
npm test
python3 tests/live_bridge.py --host-artifact /absolute/installed/provider-pi/host.mjs
node tests/completion-check.mjs < /absolute/installed/provider-pi/host.mjs
```

The live runner uses the **ordinary provider-pi artifact** plus this addon's launcher and tests six commands, including a `/reload` command chip. Its separate no-model probe fails if a command reaches the agent cycle. It retains isolated test files. These checks do not prove that an already-running BB thread has adopted the new launcher; report that separately.

The former Pi+ bridge and instruction skill are not included in this repository or runtime. Runtime and live-test artifacts are retained; no cleanup is requested.
