# BB 0.45.0 compatibility adapter

Pi Command Sync 0.2.0 is an addon for the existing `pi` provider, not a replacement provider. The public SDK 0.6.15 environment API connects its launcher, but does not provide additive native-command-root or handled-command completion hooks for another provider. Installing this plugin alone does not repair an unmodified BB installation.

## Reference installation

The included [repair helper](../tools/pi-runtime/ensure-bb-slash-completion.py) is pinned to the tested BB 0.45.0 ordinary Pi bridge. Its `TARGET` currently names the Ubuntu reference installation:

```text
/home/ubuntu/.bb-server/app/node_modules/bb-app/server/dist/builtin-plugins/provider-pi/dist/host.js
```

Inspect that target before use. This path is not a portable BB installation locator, and other layouts or BB versions are not verified.

The helper checks expected source fragments, plugin metadata and artifact digests before writing. It preserves the previous source and metadata as `.before-bb-slash-completion` backups, updates the artifact digest, and refuses an incompatible bundle rather than applying a guessed patch. It does not delete backups or apply itself automatically.

For an authorized repair of the matching reference installation, from this repository root:

```sh
python3 tools/pi-runtime/ensure-bb-slash-completion.py
bb plugin reload provider-pi
```

The adapter imports global/project command catalogs and scoped skill roots, and settles native commands with `disposition: handled` without waiting for a model turn. Streaming, compaction and queued input retain their existing settlement paths.

After a BB update, recheck compatibility instead of blindly applying the old adapter. An already-running bridge must be safely stopped and the same thread resumed to adopt a replaced artifact or launcher. `/reload` reloads Pi resources; it does not replace the launcher. Do not discard the thread or its history.

## Verification

See the [plugin checks](../README.md#verify). The isolated live runner exercises six ordinary-provider commands, including a `/reload` command chip, without model prompts. The completion check covers six streaming/compaction/queue scenarios. These are not proof of adoption by an already-running chat process, nor proof of an unmodified-BB installation.
