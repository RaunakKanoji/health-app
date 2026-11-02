import { z } from 'zod';
import 'dotenv/config';
const schema=z.object({
  DEMO_MODE:z.literal('true'), DATABASE_URL:z.string().min(1), DATABASE_URL_UNPOOLED:z.string().min(1).optional(),
  SESSION_SECRET:z.string().min(32),WORKER_SECRET:z.string().min(32),
  APP_ORIGIN:z.string().url().default('http://localhost:3000'),
  API_PORT:z.coerce.number().int().min(1).max(65535).default(4000),
  DATA_RETENTION_DAYS:z.coerce.number().int().min(1).default(365),
});
export function readConfig(){const result=schema.safeParse(process.env);if(!result.success)throw new Error(`Invalid environment: ${result.error.issues.map(i=>i.path.join('.')).join(', ')}. Copy .env.example and explicitly enable synthetic DEMO_MODE.`);return result.data;}
