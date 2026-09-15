/**
 * One-time preparation for the whole run.
 *
 * Boots a throwaway dsh home so the shipped `web`/`headless` profiles exist,
 * then installs the plugin under test into both with the package's own
 * `install.py`. Spec files clone this template, so the registry install cost is
 * paid once per run. Reuse is controlled by `DSH_E2E_FRESH_TEMPLATE=1`.
 */
import { ensureTemplateHome } from './harness/dsh-home'

export default async function globalSetup(): Promise<void> {
  const home = await ensureTemplateHome()
  console.log(`[e2e] template dsh home ready: ${home}`)
}
