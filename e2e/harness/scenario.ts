/**
 * A scenario: one disposable dsh home plus the `dsh web` process serving it.
 *
 * Spec files create their scenario at module scope and start/stop it in
 * `beforeAll`/`afterAll`. The home is cloned from the prepared template (see
 * `dsh-home.ts`), so each spec file gets isolated settings and profile config
 * while sharing the installed module tree.
 */
import { materializeScenarioHome, type ScenarioHome, type ScenarioHomeOptions } from './dsh-home'
import { startDshWeb, type RunningDsh } from './dsh-process'

export interface ScenarioContext {
  home: string
  workspaceDir: string
  markersDir: string
  profileDir: string
}

export interface ScenarioOptions extends Omit<ScenarioHomeOptions, 'servers'> {
  /** Composition servers, or a builder that receives the materialized paths. */
  servers?: unknown[] | null | ((context: ScenarioContext) => unknown[] | null)
  /**
   * Called after the home is materialized and before the composition patch is
   * written. Harness-owned fixtures (the streamable-http server, whose URL the
   * composition must contain) start here.
   */
  beforeBoot?: (home: ScenarioHome) => Promise<void> | void
  /** Extra environment for the booted process. */
  env?: Record<string, string | undefined>
}

export class Scenario {
  private readonly options: ScenarioOptions
  private materialized: ScenarioHome | null = null
  private server: RunningDsh | null = null

  constructor(options: ScenarioOptions) {
    this.options = options
  }

  /** Materialize the home and boot `dsh web`; resolves once the app answers. */
  async start(): Promise<void> {
    // The home is materialized with no composition first: harness-owned
    // fixtures must be listening before the config that references them exists,
    // and the home's marker directory must exist before they log to it.
    const home = materializeScenarioHome({ ...this.options, servers: null })
    this.materialized = home
    if (this.options.beforeBoot !== undefined) await this.options.beforeBoot(home)
    const resolved = typeof this.options.servers === 'function' ? this.resolveServers() : (this.options.servers ?? null)
    home.writeComposition(resolved, this.options.extraPatch ?? [])
    this.server = await startDshWeb(home.home, {
      profile: home.profile,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    })
  }

  /** Stop the server; the home stays on disk for inspection. */
  async stop(): Promise<void> {
    await this.server?.stop()
    this.server = null
  }

  get home(): ScenarioHome {
    if (this.materialized === null) throw new Error(`scenario ${this.options.id} is not started`)
    return this.materialized
  }

  get url(): string {
    if (this.server === null) throw new Error(`scenario ${this.options.id} is not started`)
    return this.server.url
  }

  get processOutput(): string {
    return this.server?.output() ?? ''
  }

  get workspacePath(): string {
    return this.home.workspaceDir
  }

  /** Marker file inside this scenario's home. */
  marker(name: string): string {
    return `${this.home.markersDir}/${name}`
  }

  /** Rewrite the persisted settings while the server is running (live re-sync). */
  writeSettings(servers: unknown[] | null): void {
    this.home.writeSettings(servers)
  }

  private resolveServers(): unknown[] | null {
    const { servers } = this.options
    if (typeof servers !== 'function') return servers === undefined ? null : servers
    return servers({
      home: this.materialized?.home ?? '',
      workspaceDir: this.materialized?.workspaceDir ?? '',
      markersDir: this.materialized?.markersDir ?? '',
      profileDir: this.materialized?.profileDir ?? '',
    })
  }
}

/**
 * Register a scenario's lifecycle with Playwright's file-scoped hooks.
 * `beforeAll`/`afterAll` receive the runner's `test` object.
 */
export function scenarioHooks(
  test: { beforeAll: (fn: () => Promise<void>) => void; afterAll: (fn: () => Promise<void>) => void },
  scenario: Scenario,
): void {
  test.beforeAll(async () => { await scenario.start() })
  test.afterAll(async () => { await scenario.stop() })
}
