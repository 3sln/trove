# plugins/

Plugins we ship. Each directory here builds into **one signed zip** — which is what a
plugin's artifact actually is, and the reason this is not `packages/`.

## Why a separate tree

`packages/` is a convention rather than a declaration: the root manifest has no
`workspaces` field, the whole repo publishes as the single `@3sln/trove` package, and its
`exports` map into `packages/*/src`. A plugin does not fit that shape. Its artifact is a
zip the server independently re-parses, digests and installs (`core/src/plugins/package.js`)
— never an npm dependency, never imported by anything in `packages/`. So `plugins/*` is a
**build location**, not a dependency graph, and each entry needs three things:

- `manifest.json` — identity, capabilities, and the `contributes` map
- `src/` — ESM modules, bundled with the plugin as one module tree
- a build step that produces `dist/<name>-<version>.zip`

## Building

```
bun plugins/build.mjs                 # every plugin
bun plugins/build.mjs audiobook       # one
bun plugins/build.mjs --sign key.pem  # and sign it
```

The build inlines nothing and installs nothing: it bundles `src/` with the same bundler the
web package uses, writes the manifest beside it, and zips the result. The output is the
same bytes a user would drag into the install dialog, which is deliberate — there is no
privileged path for our own plugins.

## Distribution

Built plugins are **not** in the npm tarball. The root `files` list names source
directories, and a zip is neither source nor something `import` can reach; shipping one
inside the package would put a binary artifact on every install of the library for the
benefit of the few deployments that want that plugin. They are built in CI and attached to
the GitHub release instead, where an operator can download and install one — the same act,
through the same dialog, as installing anyone else's.

Nothing here is preinstalled. A drive with a plugin its owner did not choose is a drive
with a capability grant its owner did not make, and the review dialog exists precisely so
that choosing is explicit.

## Writing one

`audiobook/` is the reference, and was written to be one — it is the first plugin in this
repository, so whatever it does is what the next one will copy. In particular it shows:

- **the manifest is the contract.** Contributions are declared there and registered by the
  host before any plugin code runs, so a plugin can only ever drive what it declared.
- **capabilities are asked for, minimally.** The audiobook player wants `files`, `ui`,
  `media` and `dock`, and does not ask for `network` or `storage` because it needs neither.
- **the sandbox is real.** A plugin runs in `sandbox="allow-scripts"` on an opaque origin:
  no cookies, no `Authorization` header, no same-origin fetch. Everything — bytes,
  settings, the media session — arrives over the `MessagePort` the host transfers in.
