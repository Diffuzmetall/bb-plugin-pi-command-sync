# BB 0.45.0 compatibility adapter

Pi Command Sync 0.2.0 is an addon for the existing `pi` provider, not a
replacement provider. The public SDK 0.6.15 environment API lets it hand BB a
launcher, but does not provide additive native-command-root or handled-command
completion hooks for another provider. Installing this plugin alone therefore
does not repair an unmodified BB installation: the read side has to live in the
installed `provider-pi` bundle, and this repository ships the exact patch for
the build it was written against.

## What the patch changes

Four string edits, each applied only when it matches exactly once:

1. Handled commands are dispatched through the normal settle path instead of
   returning early.
2. `disposition: "handled"` settles the run immediately — without waiting for an
   `agent_end` that a handled command never produces — while streaming,
   compaction and queued input keep their existing settlement behaviour.
3. `resolvePiNativeRoots` also imports the `BB_PI_COMMAND_MENU_DIR` catalogs:
   the project pointer first, `global.json` second, adding the command catalog
   directory and up to 32 validated absolute skill roots (`user`/`project`,
   project roots never taken from `global.json`).
4. `resolveNativeRoots` receives `cwd`, so the per-project pointer can be found.

The helper refuses an incompatible bundle instead of guessing: unreadable or
mismatched metadata (`pluginId: "provider-pi"`, `artifactDigest`) aborts with no
files changed, and a bundle whose edits do not match is reported for review.
It keeps `.before-bb-slash-completion` and
`.before-bb-slash-completion-<digest12>` backups, writes the new
`artifactDigest`, and never deletes a backup or applies itself automatically.

## Reference installation

The helper is pinned to the tested BB 0.45.0 ordinary Pi bridge. Its default
`TARGET` names the Ubuntu reference installation:

```text
/home/ubuntu/.bb-server/app/node_modules/bb-app/server/dist/builtin-plugins/provider-pi/dist/host.js
```

Inspect that target before use — the default is not a portable BB installation
locator, and other layouts or BB versions are not verified. Point the helper at
another artifact with the environment variable:

```sh
BB_PI_HOST_ARTIFACT=/absolute/path/to/provider-pi/dist/host.js \
  python3 tools/pi-runtime/ensure-bb-slash-completion.py
```

For an authorized repair of the matching installation, from the repository
root:

```sh
python3 tools/pi-runtime/ensure-bb-slash-completion.py
bb plugin reload provider-pi
```

## After a BB update

Recheck compatibility instead of blindly reapplying the adapter: a new BB build
may ship its own hook, or may have moved the code the patch targets. An
already-running bridge must be safely stopped and the same thread resumed to
adopt a replaced artifact or launcher; `/reload` reloads Pi resources and does
not replace the launcher. Do not discard the thread or its history.

## Verification

See the [plugin checks](../README.md#verification). The isolated live runner
exercises six ordinary-provider commands, including a `/reload` command chip,
without model prompts, and the completion check covers six streaming,
compaction and queue scenarios. Neither proves adoption by an already-running
chat process, nor that the patch applies to a differently built BB.
