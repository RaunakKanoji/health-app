import { z } from 'zod';
import 'dotenv/config';
import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { databaseEnvironment, validateDatabaseSettings } from './database.ts';
export { allowLocalBootstrap, assertDevelopmentDatabase, databaseEndpoint, databaseEnvironment, isLocalDatabase, migrationConnection, validateDatabaseSettings } from './database.ts';
// The CLI owns this file. Load it only at runtime; existing process settings win.
loadEnvironment({path:fileURLToPath(new URL('../../../apps/web/.env.local',import.meta.url)),override:false,quiet:true});
// A separately provisioned application role never replaces the owner connection
// managed by Neon CLI. Explicit process settings remain authoritative.
loadEnvironment({path:fileURLToPath(new URL('../../../.env.runtime',import.meta.url)),override:false,quiet:true});
const schema=z.object({
  DEMO_MODE:z.literal('true'), DATABASE_URL:z.string().min(1), DATABASE_URL_UNPOOLED:z.string().min(1).optional(),
  DATABASE_DIRECT_URL:z.string().min(1).optional(),
  DATABASE_RUNTIME_URL:z.string().min(1).optional(),
  DATABASE_ENVIRONMENT:z.enum(['development','test','staging','production']).optional(),
  DATABASE_POOL_MAX:z.coerce.number().int().min(1).max(20).optional(),
  // Legacy secrets may remain configured; they no longer authorize HTTP users.
  SESSION_SECRET:z.string().optional(),WORKER_SECRET:z.string().optional(),
  APP_ORIGIN:z.string().url().default('http://localhost:3001'),
  API_PORT:z.coerce.number().int().min(1).max(65535).default(4001),
  DATA_RETENTION_DAYS:z.coerce.number().int().min(1).default(365),
  DEFAULT_ORGANIZATION_ID:z.string().min(1).default('org-screening'),
  CLERK_SECRET_KEY:z.string().optional(),
  CLERK_PUBLISHABLE_KEY:z.string().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:z.string().optional(),
  CLERK_WEBHOOK_SIGNING_SECRET:z.string().optional(),
  CLERK_ISSUER_URL:z.preprocess(value=>value===''?undefined:value,z.string().url().optional()),
});
export type CareLoopConfig=z.infer<typeof schema>;
export function parseConfig(environment:Record<string,unknown>):CareLoopConfig {
  const result=schema.safeParse(environment);
  if(!result.success)throw new Error(`Invalid environment: ${result.error.issues.map(i=>i.path.join('.')).join(', ')}. Explicit synthetic DEMO_MODE is required.`);
  validateDatabaseSettings(result.data);
  return {...result.data,DATABASE_ENVIRONMENT:databaseEnvironment(result.data)};
}
export function readConfig(){return parseConfig(process.env);}
