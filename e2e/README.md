# End-to-end suite — `@royenheart/dsh-plugin-mcp-support`

Playwright + Chromium end-to-end coverage for the plugin's user-visible
surfaces: the browser `mcp` status view, the status HTTP route, the layered
server configuration, headless activation, and the `install.py` CLI path.

The suite boots **real** `dsh` profiles. Nothing about the harness is mocked:
each spec materializes a temporary `DSH_HOME`, installs this checkout through
the shipped `install.py`, writes the profile patch (and, where relevant, a
local composition bundle) a user would write, and then drives the real web UI
or the real CLI.

## Tooling

Same tooling as the DeepSeek Harness repository's own web end-to-end lane:
Playwright driving Chromium.

```sh
npm install --save-dev @playwright/test
npx playwright install chromium
```

The suite resolves the browser from the standard Playwright cache
(`PLAYWRIGHT_BROWSERS_PATH` is honoured automatically).

## Running

```sh
# whole suite, one worker
npx playwright test --config e2e/playwright.config.ts

# one spec
npx playwright test --config e2e/playwright.config.ts e2e/specs/web-status-empty.spec.ts
```

Environment:

| Variable | Meaning | Default |
| --- | --- | --- |
| `DSH_E2E_BIN` | `dsh` executable under test | `.dsh-migrate/dsh/dsh-<version>/bin/dsh`, then `/usr/local/bin/dsh`, `/usr/bin/dsh` |
| `DSH_E2E_PYTHON` | Python used for `install.py` | `python3` |
| `DSH_E2E_ARTIFACTS` | report/trace/screenshot root | `<repo>/.e2e-artifacts` |

The suite targets `dsh-v0.1.7-alpha.1` (`DSH_E2E_BIN` must point at that
version; `--version` is the harness contract the specs are written against).

Artifacts land in `<repo>/.e2e-artifacts/` and are intentionally outside the
package `files` list; add that directory to `.gitignore` when the suite moves
onto its own branch.

## Specs and the coverage ledger

`index.json` (the staging root's ledger, which becomes the repository-root
ledger when the suite lands) is the coverage ledger: one row per user-visible
feature, each pointing at the spec that exercises it. `state` is `passing`,
`failing`, or `unknown`; `unknown` rows live in
`specs/unreachable-surfaces.spec.ts` with the concrete reason the surface
cannot be reached hermetically, and their `lastPassedFor` is `null`.

| Spec | Covers |
| --- | --- |
| `specs/web-status-empty.spec.ts` | `mcp` view tab, empty state, refresh, status-route HTTP contract |
| `specs/web-status-layering.spec.ts` | composition layer, settings override/append, `!!js` in both layers, stdio + streamable-http rows, layout and painted-dot invariants |
| `specs/web-legacy-settings.spec.ts` | legacy `settings.yaml` import, volatile re-sync of the mounted set, per-row mount failure after a committed update |
| `specs/web-duplicate-committed-update.spec.ts` | duplicate `serverName` committed after boot: route 500 and browser error state |
| `specs/headless-activation.spec.ts` | activation without a web server, real child spawn, `failOnStartupError`, duplicate-name activation error |
| `specs/cli-install.spec.ts` | `install.py` install/idempotency/uninstall, `--dump-config` composition |
| `specs/unreachable-surfaces.spec.ts` | skipped rows documenting surfaces owned by the harness or needing unavailable inputs |

## Determinism rules the suite enforces

- **No `networkidle`.** Every wait is a predicate over an explicit observation:
  an HTTP response, a DOM read, a file, or a process log line.
- **No single transient sample.** DOM and HTTP reads used for assertions go
  through `pollStable`, which requires **two consecutive agreeing reads**.
  Where a pre-update state would already be stable (a loading placeholder, a
  still-empty list), an `accept`/`until` predicate gates which values are
  eligible to settle.
- **One console/pageerror tripwire per executing spec.** Browser specs arm
  `armConsoleTripwire` (any pageerror or console error fails, unless the spec
  explicitly allows an expected one such as the 500 the duplicate spec
  asserts). CLI/headless specs arm the equivalent `processTripwire` over the
  real `dsh` output.
- **Roles and labels, no host internals.** Selectors use ARIA roles,
  accessible names, visible text, and this plugin's own class names. Host
  `data-*` attributes are never asserted on.
- **Baseline-free visual checks.** Geometry invariants (no content clipped by
  its box, rows contained by the view, rows not overlapping) and painted-state
  invariants (mounted vs not-mounted dot colour differs, dots are visible with
  a real box) replace screenshot baselines.
- **Bounded and leak-free.** Every child process is spawned with a timeout and
  killed with its process group; every `DSH_HOME` and workspace directory is
  removed in `afterAll`.

## Known constraints

- The web specs send one prompt so the session leaves its blank hero state and
  the header's view-tab row renders. The suite configures an obviously invalid
  API key, so the model call fails; the failure is expected, never asserted on,
  and produces no browser console output (the one place it does — the 500 in
  the duplicate spec — is explicitly allowed).
- `--dump-config` can occasionally drop a bundle layer (observed once in ~56
  dumps in this environment); `cli-install.spec.ts` re-runs the dump once
  before asserting, so two consecutive drops still fail.
- The headless profile reaches the credential boundary instead of a model
  answer; activation is asserted as the absence of the loader's activation
  diagnostics plus a readiness marker written by the spawned MCP child.
