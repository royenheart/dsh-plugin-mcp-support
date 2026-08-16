# @royenheart/dsh-plugin-mcp-support

A thin, non-duplicating wrapper over the native dsh MCP bridge
[`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness).
It makes MCP servers configurable through two layered sources:

1. **Composition config** — the plugin entry's `servers` list.
2. **Persisted dsh settings** — the `mcp-support` settings namespace.

The wrapper mounts one native `mcp-client` child fiber per effective server and
re-syncs the mounted set whenever the settings section changes. It does **not**
vendor or re-implement any connection, tool-discovery, or reconnect logic.

## Layout

```
src/index.ts          # host plugin: settings registration + dynamic child mounts + status route
src/client/index.ts   # browser half: "mcp" view tab (status page)
src/core/config.ts    # pure normalize/merge helpers (no cordis imports)
src/core/status.ts    # pure status-row shaping helper
tests/                # node:test suite using a real cordis Context
lib/                  # built host + client entries (npm run build)
```

## Web status view

The client half registers an `mcp` tab in the session header's view-tab row,
immediately to the right of the `轨迹` (trajectory) tab and before any later
tabs such as `技能`. Selecting it fetches
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

Restart dsh. The plugin declares `inject: ['settings', 'tools']`, so it loads
once both the dsh settings service and the native tool registry are available.

## Composition config example

Configure the bundle-inserted row by id in the profile's own
`cordis.patch.yml` (the bundle patch already inserts the row; this patch only
overrides its config):

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

The namespace is `mcp-support`. (If `settings.yaml` still carries the key from
an earlier misspelled build, rename that key to `mcp-support` once.)

In the profile's settings document (`settings.yaml`):

```yaml
mcp-support:
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
| `failOnStartupError`| no       | `false` | reject plugin activation on initial connection failure |
| `reconnect`         | no       | native defaults | `enabled`, `initialDelayMs`, `maxDelayMs`, `maxAttempts` |

## Develop

```sh
npm run typecheck
npm run build
npm test
```
