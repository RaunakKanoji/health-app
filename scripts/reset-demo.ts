import { createDatabase,migrate } from '../packages/db/src/index.ts';
import { readConfig } from '../packages/config/src/index.ts';
import { seedDatabase } from './seed/index.ts';

const config=readConfig();const url=new URL(config.DATABASE_URL);
if(!process.argv.includes('--confirm-synthetic-reset')||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/careloop'||url.port!=='54329')throw new Error('Reset is restricted to the local careloop database on port 54329 and requires --confirm-synthetic-reset. Stop the app and worker first.');
const db=createDatabase(config.DATABASE_URL);
try{
 await db.transaction(async tx=>{await tx.query('DROP SCHEMA public CASCADE');await tx.query('CREATE SCHEMA public');});
 await migrate(db);await seedDatabase(db);console.log('Local synthetic demonstration reset and reseeded.');
}finally{await db.close();}
