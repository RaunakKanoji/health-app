import {createDatabase,verifyDatabase,verifyMigrations} from './index.ts';
import {readConfig} from '../../config/src/index.ts';

try {
  const config=readConfig();
  const db=createDatabase(config.DATABASE_RUNTIME_URL??config.DATABASE_URL,{max:1});
  try {
    if((await verifyDatabase(db)).status!=='ok')throw new Error('unavailable');
    const migrations=await verifyMigrations(db);
    process.stdout.write(JSON.stringify({status:migrations.pending.length?'migrations_pending':'ok',environment:config.DATABASE_ENVIRONMENT,applied:migrations.applied.length,pending:migrations.pending})+'\n');
    if(migrations.pending.length)process.exitCode=1;
  } finally {await db.close();}
} catch {
  process.stderr.write('Database verification failed. Check environment configuration, connectivity and migration checksums. No connection details are logged.\n');
  process.exitCode=1;
}
