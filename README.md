# @royenheart/dsh-plugin-mcp-support

[![dsh](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Froyenheart%2Fdsh-plugin-mcp-support%2Frefs%2Fheads%2Fdsh-migrate%2Fstate%2Fbadge.json)](https://github.com/royenheart/dsh-plugin-mcp-support/tree/dsh-migrate/state)

A thin, non-duplicating wrapper over the native dsh MCP bridge
[`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness).
It makes MCP servers configurable through two layered sources:

1. **Composition config** — the plugin entry's `servers` list as a bundle
   patch supplies it.
2. **Persisted settings** — the active profile's `mcp-support` entry config
   override: what the dsh settings forms write for a volatile Config field,
   and what the settings service imports once from a legacy `settings.yaml`
   `mcp-support:` section.

`servers` is declared `.volatile()` in the plugin Config, so the harness
settings service owns persistence and a committed change re-syncs the mounted
set without remounting the wrapper.

The wrapper mounts one native `mcp-client` child fiber per effective server and
re-syncs the mounted set whenever the Loader commits a volatile config update.
It does **not** vendor or re-implement any connection, tool-discovery, or
reconnect logic.

## Layout

```
src/index.ts          # host plugin: live server config + dynamic child mounts + status route
src/client/index.ts   # browser half: "mcp" view tab (status page)
src/core/config.ts    # pure normalize/merge helpers (no cordis imports)
src/core/status.ts    # pure status-row shaping helper
tests/                # node:test suite using a real cordis Context
lib/                  # built host + client entries (npm run build)
```

## Web status view

The client half registers an `mcp` tab in the session header's view-tab row,
immediately to the right of the `轨迹` (trajectory) tab.
Selecting it fetches
`/plugins/@royenheart/dsh-plugin-mcp-support/status` and shows each effective
MCP server with its transport, mounted state, and the last mount error when
present. No servers configured renders "No MCP servers configured."

## Install into a profile

`lib/` is generated locally and is not committed. `install.py` always builds
the repository's own toolchain first (`npm install` when the toolchain is
missing, then `npm run build`) and only reports an error when npm itself is
missing.

Install/uninstall idempotently with the bundled script (stdlib-only Python).
The package ships its own `cordis.patch.yml` (id `mcp-support`) and declares
`dsh.bundle.patch`, so the script only links the package into the profile
`node_modules`, adds the `link:` dependency, and appends the package to
`dsh.profile.bundles`. The profile's own `cordis.patch.yml` is never modified:

```sh
python3 install.py install --profile web          # install
python3 install.py uninstall --profile web        # remove
python3 install.py install --profile web --home "$DSH_HOME"   # explicit home
```

Manual alternative:

```sh
dsh plugin --profile <profile-name> add link:/home/royenheart/projects/dsh-plugins/dsh-plugin-mcp-support
```

`dsh plugin` reconciles `dsh.profile.bundles` from the installed package's
`dsh.bundle` declaration, so no profile patch edit is needed either.

Restart dsh. The plugin declares `inject: ['tools']`, so it activates as soon as
the native tool registry is available — including headless profiles that mount
no HTTP server. The status route is registered in an optional
`ctx.inject(['webServer'], …)` child whenever a profile does provide the web
route registry. The persisted settings layer is read from the active profile's
config editor when the profile mounts one (`dsh-base` does); without it the
resolved entry config is the whole server list.

## Composition config example

A bundle patch layer that adds or overrides the row supplies the composition
list. The package's own `cordis.patch.yml` inserts the row without a `servers`
list, so a deployment overlay (or this package's patch, when vendored) declares
the defaults:

```yaml
- id: mcp-support
  config:
    servers:
      - transport: stdio
        serverName: filesystem
        command: npx
        args:
          - -y
          - '@modelcontextprotocol/server-filesystem'
          - /tmp
        env: {}
        cwd: ''
        toolCallTimeoutMs: 60000
        failOnStartupError: false

      - transport: streamable-http
        serverName: everything
        url: http://localhost:3000/mcp
        headers:
          Authorization: Bearer secret
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

## Settings example

Persisted settings are layered **over** the composition list. Servers are keyed
by `serverName`: a settings server with the same name overrides the composition
entry; settings-only servers are appended after composition servers.

The settings layer is the `mcp-support` entry override in the profile's own
`cordis.patch.yml` — the same row the dsh settings forms write once a
configuration page is registered for it. Edit it by hand exactly as before:

```yaml
- id: mcp-support
  config:
    servers:
      - transport: stdio
        serverName: filesystem
        command: npx
        args:
          - -y
          - '@modelcontextprotocol/server-filesystem'
          - /tmp

      - transport: streamable-http
        serverName: everything
        url: http://localhost:3000/mcp
        headers:
          Authorization: Bearer secret
```

A `settings.yaml` left by an earlier release is imported once by the harness
settings service: the `mcp-support` section is written into this profile entry
(the file is then renamed `settings.yaml.imported`), so the same layering
applies without a manual patch edit.

Both layers are ordinary Cordis Config values, so `!!js` expressions are
evaluated with the Loader's own interpolation before the wrapper reads them:

```yaml
# composition layer, evaluated at boot
env:
  GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
# settings layer, same evaluation
headers:
  Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

The harness also exposes this entry's volatile `servers` field as a settings
form (`ctx.settings.describe()`); the shipped Plugins page renders a page for a
row only when the bundle's browser half registers one, so the plugin's own page
for it is not part of this package.

Because `servers` is volatile, a plain `servers` array written to the entry is
a complete override of the composition list; the wrapper still merges it by
`serverName` against the composition layer it reads from the profile config
editor.

Each source list must use unique `serverName`s. A duplicate in the composition
or settings layer fails activation with a clear error; a duplicate that arrives
through a committed update leaves the previous mounts in place and is reported
by the status route.

## Config reference

Each `servers` entry is exactly the native `@deepseek-ai/dsh-mcp-client` config
union.

### stdio

| Field               | Required | Default | Notes |
| ------------------- | -------- | ------- | ----- |
| `transport`         | yes      | —       | `stdio` |
| `serverName`        | yes      | —       | `[A-Za-z0-9_-]{1,32}`, unique per source list |
| `command`           | yes      | —       | executable to spawn |
| `args`              | no       | `[]`    | passed without shell interpolation |
| `env`               | no       | `{}`    | merged over the scrubbed ambient env |
| `cwd`               | no       | `''`    | child working directory |
| `toolCallTimeoutMs` | no       | `60000` | per-tool-call timeout |
| `maxInstructionBytes`| no      | `32768` | maximum UTF-8 bytes of attributed server instructions |
| `failOnStartupError`| no       | `false` | reject plugin activation on initial connection failure |
| `reconnect`         | no       | native defaults | `enabled`, `initialDelayMs`, `maxDelayMs`, `maxAttempts` |

### streamable-http

| Field               | Required | Default | Notes |
| ------------------- | -------- | ------- | ----- |
| `transport`         | yes      | —       | `streamable-http` |
| `serverName`        | yes      | —       | `[A-Za-z0-9_-]{1,32}`, unique per source list |
| `url`               | yes      | —       | MCP endpoint URL |
| `headers`           | no       | `{}`    | extra request headers |
| `toolCallTimeoutMs` | no       | `60000` | per-tool-call timeout |
| `maxInstructionBytes`| no      | `32768` | maximum UTF-8 bytes of attributed server instructions |
| `failOnStartupError`| no       | `false` | reject plugin activation on initial connection failure |
| `reconnect`         | no       | native defaults | `enabled`, `initialDelayMs`, `maxDelayMs`, `maxAttempts` |

## Develop

```sh
npm run typecheck
npm run build
npm test
```
