import type { Env } from './env.ts';

export { SessionObject } from './session.ts';

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response('ok');
  },
} satisfies ExportedHandler<Env>;
