import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

export class SessionObject extends DurableObject<Env> {}
