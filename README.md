# @royenheart/dsh-plugin-mcp-suppor

A thin, non-duplicating wrapper over the native dsh MCP bridge
[`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness).
It makes MCP servers configurable through two layered sources:

1. **Composition config** — the plugin entry's `servers` list.
2. **Persisted dsh settings** — the `mcp-suppor` settings namespace.

The wrapper mounts one native `mcp-client` child fiber per effective server and
re-syncs the mounted set whenever the settings section changes. It does **not**
vendor or re-implement any connection, tool-discovery, or reconnect logic.

## Layout

```
src/index.ts          # host plugin: settings registration + dynamic child mounts
src/core/config.ts    # pure normalize/merge helpers (no cordis imports)
tests/                # node:test suite using a real cordis Context
lib/                  # built host entry (npm run build)
```

## Install into a profile

Build the package first:

```sh
cd /home/royenheart/projects/dsh-plugins/dsh-plugin-mcp-suppor
npm run build
```

Then add the plugin to a profile:

```sh
dsh plugin --profile <profile-name> add link:/home/royenheart/projects/dsh-plugins/dsh-plugin-mcp-suppor
```

Restart dsh. The plugin declares `inject: ['settings', 'tools']`, so it loads
once both the dsh settings service and the native tool registry are available.

## Composition config example

In the profile composition (`cordis.yml`), configure the plugin row:

```yaml
plugins:
  '@royenheart/dsh-plugin-mcp-suppor':
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

In the profile's settings document (`settings.yaml`):

```yaml
mcp-suppor:
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
