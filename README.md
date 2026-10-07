# Pi Command Sync for BB

Makes BB's `/` menu show the commands your Pi actually has, and answers those
commands inside BB instead of sending them to the model.

BB's built-in **Pi** provider (`pi`) runs Pi in RPC mode. This addon does not
replace that provider: it registers no provider, exports no provider bridge,
changes no default and migrates no thread. It plugs a launcher and a Pi
extension into the provider BB already has.

```
BB `/` menu  ──►  ~/.pi/bb-commands catalogs  ──►  provider-pi bridge
                        ▲                                  ▲
              written by a Pi extension            reads them per project
              loaded by our launcher               (adapter repair, below)
```

## The problem

- BB renders the command menu from **its own** command roots, not from Pi's
  registry, so Pi extensions, skills, prompts and native commands stay invisible
  in the composer.
- Slash text BB does not recognise falls through to the model: a real,
  billable turn just to print a status line — and terminal-only controls such
  as `/login`, `/tree` or `/resume` cannot work in a headless RPC child at all.
- BB 0.45.0's plugin SDK has **no additive API** for one plugin to register
  native-command roots or handled-command completion for another plugin's
  provider. That missing hook is why this addon ships in two parts.

## How it works

### 1. Environment contribution (`server.ts`)

The plugin's backend registers an environment contribution on the existing
provider:

```ts
bb.providers.experimental_contributeEnv("pi", async ({ hostId }) => {
  const { launcher } = await host.call("prepareRuntime", null, { hostId });
  return [{ name: "BB_PI_BRIDGE_COMMAND", value: launcher, reason: "Load native Pi commands in BB" }];
});
```

`BB_PI_BRIDGE_COMMAND` is the documented public provider-environment surface, so
BB itself decides to start new Pi processes through our launcher. Nothing is
written into BB's files.

### 2. Launcher and runtime (`host.ts`, `runtime/commands.ts`)

On first use, the host entry writes a private runtime directory under BB's data
dir (`<dataDir>/runtime/<sha256(…)>/`, mode `0700`):

- `commands.ts` — this addon's Pi extension (mode `0600`), generated from
  `runtime/commands.ts` and inlined into the bundle by `scripts/prepare-extension.mjs`;
- `pi-bb` — a shell launcher (mode `0700`) that exports `BB_PI_COMMAND_MENU_DIR`
  and `exec`s Pi with `--extension <commands.ts>`.

The launcher prefers the Pi CLI resolved next to the running Node
(`…/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`, realpath
checked) and falls back to `pi` on `PATH`. Terminal Pi is untouched: the
extension is loaded only through this launcher.

### 3. Catalog publishing (`runtime/commands.ts`)

On every `session_start` — and therefore on every `/reload` — the extension
reads `pi.getCommands()` and writes **content-addressed** Markdown snapshots:

```
~/.pi/bb-commands/
├── global.json                                  # { snapshot, skillRoots }
├── projects/<sha256(cwd)>.json                  # same shape, project scope
└── catalog/<sha256(entries)>/
    ├── reload.md                                # ---\ndescription: …\n---\n/reload
    └── …
```

Addressing by content means republishing is idempotent and old snapshots stay
valid, so a menu read never races a rewrite. Commands sourced from skills are
excluded from the command list but their `SKILL.md` roots are recorded as
`skillRoots` with `user` or `project` origin, and a project pointer only ever
contributes project-scoped roots.

### 4. Bridge adapter (`tools/pi-runtime/ensure-bb-slash-completion.py`)

Because the SDK has no hook, the installed `provider-pi` bundle itself carries
the read side. The helper patches that installed artifact with four exact
string edits, all checked before writing:

1. dispatch handled commands through the normal settle path;
2. treat `disposition: "handled"` as settled immediately — no waiting for an
   `agent_end` that will never arrive — while streaming, compaction and queued
   input keep their existing settlement paths;
3. extend `resolvePiNativeRoots` to import the project pointer first and
   `global.json` second, adding the command catalog directory and up to 32
   validated absolute skill roots;
4. pass `cwd` into `resolveNativeRoots` so the per-project pointer can be found.

It rewrites nothing when the bundle does not match exactly, keeps
`.before-bb-slash-completion` and `.before-bb-slash-completion-<digest12>`
backups, updates `artifactDigest`, and expects the matching backup plus
`bb plugin reload provider-pi` afterwards. See
[docs/compatibility.md](docs/compatibility.md).

### 5. Discovery without a model (`host.ts`)

`bb pi-command-sync sync` runs the launcher as

```sh
pi-bb --mode rpc --no-session        # in the requested workspace
```

writes `{"type":"get_commands","id":"pi-command-sync"}` to its stdin, waits for
the matching RPC response — never an agent turn — and kills the disposable
process group. Bounded at 20 s and 2 MiB of output, de-duplicated per
(menu, directory), and cancellable through the RPC signal. The result is one
pointer file: `projects/<sha256(cwd)>.json`, or `global.json` with `--cwd`
omitted.

## Requirements

| Component | Version |
| --- | --- |
| BB | 0.45.0 |
| `@get-bb/plugin-sdk` | 0.6.15 |
| Node | 22+ |
| Pi | `@earendil-works/pi-coding-agent` installed |

Linux is tested. macOS is declared but unverified; Windows is refused by the
host entry. The adapter repair is pinned to **one** BB 0.45.0 build and is
**not** a fix that works on an arbitrary BB installation — see
[docs/compatibility.md](docs/compatibility.md) before assuming it applies.

## Install

```sh
git clone https://github.com/Diffuzmetall/bb-plugin-pi-command-sync
cd bb-plugin-pi-command-sync
npm ci
npm run build          # generates extension-source.ts, then `bb plugin build`

bb plugin install "$PWD" --yes
bb pi-command-sync sync --host <host-id> --cwd /absolute/workspace
```

`<host-id>` comes from `bb host list`. Omitting `--cwd` syncs global resources
only; the command prints `{"providerId":"pi","commands":N,"skillRoots":M}`.

If the bridge has not been repaired yet on this host, apply the adapter and
reload it:

```sh
python3 tools/pi-runtime/ensure-bb-slash-completion.py
bb plugin reload provider-pi
```

BB can also install straight from the repository URL
(`bb plugin install https://github.com/Diffuzmetall/bb-plugin-pi-command-sync`),
which builds the plugin on the host and needs `npm`; the local-path route above
is the one verified here.

### For an existing local installation

```sh
npm run build
bb plugin reload pi-command-sync
bb plugin enable pi-command-sync
```

Keep using **Pi**, not a new provider. A Pi process that was already running
started without our launcher, so it must be gracefully restarted once before
the contribution applies — `/reload` reloads Pi resources, but it cannot load a
launcher the process was never started with. Do not discard the thread or its
history.

## Commands

Run inside BB, answered by the extension without a model request:

| Command | Behaviour |
| --- | --- |
| `/reload` | Reload Pi extensions, skills, prompts, themes and context files |
| `/commands [query]` | List the commands actually loaded in this session |
| `/session` | Session id, name, model, thinking level, context usage (JSON) |
| `/name [name]` | Show or set the session name |
| `/thinking [level]` | Show or set `off…max` |
| `/model [provider/model]` | Show or set the model; the BB picker owns persistent selection |
| `/compact [instructions]` | Compact context — **the only command here that calls a model** |

Terminal-only controls (`/settings`, `/tree`, `/login`, `/resume`, `/fork`,
`/export`, …) are registered as explainers: they print why BB cannot forward
them and make no model request, instead of silently costing a turn.

## Verification

```sh
npm run build
npm run typecheck
npm test
python3 tests/live_bridge.py --host-artifact /absolute/installed/provider-pi/host.mjs
node tests/completion-check.mjs < /absolute/installed/provider-pi/host.mjs
```

- `npm test` — plugin registrations and RPC/CLI validation against a fake host,
  a public-SDK-only scan of the packaged files, and a real cold Pi discovery
  run in an isolated `HOME`/`PI_CODING_AGENT_DIR`.
- `tests/completion-check.mjs` — extracts the RPC session seam from the
  installed bridge artifact in a VM and replays handled / started / streaming /
  compaction / queued settlement, failing a hang.
- `tests/live_bridge.py` — drives the real provider bridge and a real Pi child
  over JSON-RPC and asserts six commands, including a `/reload` command chip,
  produce native results and **no** model turn.

They leave their isolated fixtures in place on purpose. None of them proves that
an already-running BB thread adopted the new launcher, and the adapter helper is
the only component that touches files outside this repository.

## Layout

```
server.ts                          plugin backend: env contribution, RPC, CLI
host.ts                            host entry: launcher, discovery, sync
contract.ts                        zod RPC contracts (server ⇄ host)
runtime/commands.ts                the Pi extension that publishes catalogs
extension-source.ts                generated inline copy of runtime/commands.ts
scripts/prepare-extension.mjs      regenerates extension-source.ts
tools/pi-runtime/…-completion.py   provider-pi adapter repair
tests/                             unit, completion and live-bridge checks
docs/compatibility.md              what the adapter patches and why
```

## Uninstall

```sh
bb plugin remove pi-command-sync
```

Then restore the bridge backups if you want an unpatched BB:

```sh
cd <installed provider-pi directory>
mv host.js.before-bb-slash-completion host.js
mv host.meta.json.before-bb-slash-completion host.meta.json
bb plugin reload provider-pi
```

`~/.pi/bb-commands` is only a cache; delete it whenever you like.

## License

MIT — see [LICENSE](LICENSE).
