/**
 * Features the suite cannot exercise end to end, recorded as `unknown`.
 *
 * These tests are intentionally skipped. They carry the ledger rows whose
 * surface is owned by the harness or depends on hostile input the suite cannot
 * supply hermetically; each skip message states the concrete reason, so the
 * coverage ledger's `unknown` states stay honest instead of being silently
 * absent. No tripwire runs here because no test body executes; every executing
 * spec in this directory carries its own console/pageerror or process-output
 * tripwire.
 */
import { test } from '@playwright/test'

test.describe('surfaces that stay unknown', () => {
  test.skip('settings-form-page: the harness Plugins page renders no page for this row', () => {
    // README: "the shipped Plugins page renders a page for a row only when the
    // bundle's browser half registers one, so the plugin's own page for it is
    // not part of this package." This bundle registers only the `mcp`
    // conversation-view tab, so there is no `servers` form control a user
    // could click; the layered sources are exercised through the profile patch
    // and the legacy `settings.yaml` import instead
    // (web-status-layering.spec.ts, web-legacy-settings.spec.ts).
    // Reaching this surface would need a harness-owned generic form, which
    // 0.1.7-alpha.1 does not ship.
  })

  test.skip('manual-plugin-add: `dsh plugin add link:<path>` needs pnpm and a registry-capable environment', () => {
    // Verified in this environment: `dsh plugin --profile web --help` exits
    // with "dsh: pnpm was not found; install pnpm and make it available on
    // PATH." The hermetic equivalent (symlink + dependency + bundle entry) is
    // what install.py performs, and cli-install.spec.ts covers it end to end.
  })

  test.skip('js-expression-env-headers: `!!js` values in env/headers have no user-visible projection', () => {
    // The status route reports only serverName, transport, mounted, and error,
    // so an evaluated env entry or request header cannot be observed from this
    // plugin's own surface. Evaluation itself is proven for `command` and
    // `url` in both layers by web-status-layering.spec.ts; asserting the
    // header value would require a bespoke authenticated MCP endpoint, which
    // adds a mock server the suite does not otherwise need.
  })

  test.skip('tool-call-timeout-and-instruction-limit: pass-through fields need a model-driven tool call', () => {
    // `toolCallTimeoutMs` and `maxInstructionBytes` are forwarded verbatim to
    // the native `@deepseek-ai/dsh-mcp-client` config and only become visible
    // when a model actually calls an MCP tool (a timeout) or when instructions
    // are truncated. No credentials exist in the suite, and manufacturing the
    // condition would test the native bridge rather than this wrapper.
  })

  test.skip('reconnect-policy: reconnect behaviour needs a server that drops mid-session', () => {
    // `reconnect` is passed through to the native bridge; observing backoff or
    // attempt exhaustion requires a controllable MCP endpoint that dies and
    // recovers, plus a live tool call to trigger it. The plugin adds no logic
    // here (README: "It does not vendor or re-implement any connection,
    // tool-discovery, or reconnect logic."), so the wrapper-specific risk is
    // an unsupported field shape, which the Config schema already rejects.
  })
})
