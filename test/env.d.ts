import type { Env as AppEnv } from '../src/env.ts';

// The installed @cloudflare/vitest-pool-workers (0.22.0) types `env` from 'cloudflare:test'
// as `Cloudflare.Env`, not `ProvidedEnv` — augment the actual merge point declared (empty)
// in worker-configuration.d.ts.
declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging requires an interface, not a type alias
    interface Env extends AppEnv {}
  }
}
