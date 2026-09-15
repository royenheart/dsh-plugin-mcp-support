# End-to-end suite — `@royenheart/dsh-plugin-mcp-support`

Playwright + Chromium end-to-end coverage for the plugin's user-visible
surface, run against a real `dsh` profile. Target harness:
**dsh 0.1.6-alpha.1** (the version this suite was authored against; older
harnesses do not ship the `ctx.inject(['webServer'])` seam the plugin now uses).

The suite lives in its own package so the plugin's published dependency set is
untouched. It stages no fixtures inside the checkout under test: `install.py`
and `npm run build` write `lib/`, so the specs run them against a disposable
copy materialized under the run's temp root.

## Requirements

- Node.js 24+ and npm
- Python 3 (the plugin's own `install.py`)
- Chromium: `npm --prefix e2e run e2e:install-browser`
- network access on the first run of a fresh temp root (dsh installs the
  shipped `@deepseek-ai/dsh-base` / `dsh-web-app` profile bundles with pnpm)

## Run

```sh
cd e2e
npm install
npm run e2e:install-browser

# Point the suite at the dsh build under test (otherwise `dsh` is taken from PATH):
DSH_E2E_DSH_BIN=/path/to/dsh-0.1.6-alpha.1/bin/dsh npm run e2e
```

Useful variants:

```sh
npm run e2e -- specs/status-tab.spec.ts       # one spec
npm run e2e:headed                            # watch the browser
npm run e2e:report                            # open the HTML report
npm run e2e:typecheck                         # tsc over harness + specs
```

### Environment knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_E2E_DSH_BIN` | `dsh` from `PATH` | dsh launcher under test |
| `DSH_E2E_PACKAGE_ROOT` | the checkout containing `e2e/` | plugin tree the suite installs and drives |
| `DSH_E2E_TMP` | `<os tmp>/dsh-mcp-support-e2e` | run-owned temp root (dsh homes, markers, package copy) |
| `DSH_E2E_TEMPLATE_HOME` | `<tmp>/template` | prepared home every scenario clones |
| `DSH_E2E_FRESH_TEMPLATE` | unset (reuse if prepared) | `1` forces re-preparation of the template home |
| `DSH_E2E_BOOT_TIMEOUT_MS` | `240000` | `dsh web` boot budget |
| `DSH_E2E_PYTHON` | `python3` | interpreter for `install.py` |

## How a scenario is built

`global-setup.ts` prepares one template dsh home:

1. boot `dsh web --port 0` once so the shipped `web` profile and the shared
   `profiles/node_modules` tree exist;
2. materialize the shipped `headless` profile with `--dump-config` (no model
   call);
3. run the package's own `install.py install` for both profiles, from the
   disposable package copy.

Each spec file then clones that template into its own home — profiles copied,
`profiles/node_modules` shared by symlink, its own `settings.yaml` and
`cordis.patch.yml` — and boots `dsh web` on an OS-assigned port. Profile
preparation cost is paid once per run; scenario homes cost milliseconds.

## Determinism rules this suite follows

- **No network-idle waits.** The web client holds an SSE stream open, so
  `networkidle` never resolves. Journeys wait on roles, text, specific
  responses, or marker files.
- **Two consecutive equal reads.** `harness/poll.ts` only returns a value that
  two consecutive reads agree on; every visible state assertion goes through
  `statusSnapshot()` or `waitForMarker()`. A single DOM sample is never
  asserted.
- **Roles and text first, geometry as the invariant.** Assertions use
  accessible roles/names and visible text; layout is checked with invariants
  (content wider/taller than its box, overlapping boxes, tab order) instead of
  pixel baselines. No host `data-*` attribute is read: class selectors only
  target the plugin's own markup (its public CSS contract) and, for modal
  readiness, the app's CSS-module mask anchor.
- **Deterministic state, not timing.** The session view is reached by real
  gestures (dismiss first-run dialogs → choose a workspace in the picker →
  commit one composer turn → select the tab). Model credentials are scrubbed
  from every spawned process, so the turn fails with `MISSING_CREDENTIAL`
  deterministically while the user message persists — which is what makes the
  session non-blank and the view-tab row appear.
- **Markers over inference.** The MCP fixtures append `ready`,
  `method initialize`, `method tools/list`, `method tools/call` to a marker
  file. A rendered row cannot prove the native bridge spawned a child or
  discovered tools; the marker can.
- **Console/pageerror tripwire per browser spec.** The wrapped `page` fixture
  fails a test on any unexpected console error or page error. CLI-only specs
  (no browser surface) use `assertCliTripwire` on the process output instead.
- **No retries.** A flake means real nondeterminism; `retries: 0`.

## Coverage ledger

| Spec | Features |
| --- | --- |
| `specs/status-tab.spec.ts` | `mcp` view tab and its position, empty state, refresh |
| `specs/composition-servers.spec.ts` | composition server list/order, stdio mount + tool discovery, streamable-http handshake + tool discovery, mounted state |
| `specs/settings-namespace.spec.ts` | settings namespace layering (override + append), live re-sync on settings change |
| `specs/mount-error.spec.ts` | failed-mount row and its error message |
| `specs/status-route.spec.ts` | status HTTP route: GET/HEAD/405, exact path |
| `specs/headless-boot.spec.ts` | activation without `webServer`, bundle row in the composed tree, config union accept/reject, `failOnStartupError` behaviour |
| `specs/install-cli.spec.ts` | `install.py` install/uninstall idempotency, bundle wiring, boot after install |
| `specs/dev-surface.spec.ts` | `npm run typecheck`, `npm run build`, `npm test` |

`index.json` in the run's staging directory is the machine-readable ledger with
one row per feature and its verification state.

## Fixtures

- `fixtures/mcp-stdio-server.mjs` — MCP stdio server (echo tool) that logs its
  lifecycle to `MCP_E2E_READY_FILE`. dsh spawns it through the native
  `@deepseek-ai/dsh-mcp-client` bridge.
- `fixtures/mcp-http-server.mjs` — MCP streamable-http server on
  `MCP_E2E_PORT`, harness-owned (a remote transport has no child process to
  spawn), same marker protocol.

Both use the official `@modelcontextprotocol/server` already in the plugin's
dev toolchain; the suite adds no protocol implementation of its own.

## Notes / known gaps

- The status views are Chinese-labelled (`MCP 状态`, `刷新`) because the plugin
  ships those strings; the browser runs `en-US` so the host's own role names
  stay stable.
- `localhost`-only: the fixtures bind `127.0.0.1`, and `dsh web` is started
  with `--host 127.0.0.1 --port 0` so parallel local runs never collide.
- Scenario homes are left under `DSH_E2E_TMP` after a run for debugging; delete
  the directory to reclaim space, or set `DSH_E2E_TMP` to a scratch volume.
