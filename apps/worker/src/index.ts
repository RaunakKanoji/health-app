import { createDatabase,migrate,requireMigrations } from '../../../packages/db/src/index.ts';
import { readConfig,allowLocalBootstrap } from '../../../packages/config/src/index.ts';
import { WorkflowService } from '../../../packages/workflows/src/service.ts';
const config=readConfig();const db=createDatabase(config.DATABASE_RUNTIME_URL??config.DATABASE_URL,{max:config.DATABASE_POOL_MAX});
try{if(allowLocalBootstrap(config))await migrate(db);else await requireMigrations(db);}catch(error){await db.close();throw error;}
const service=new WorkflowService(db);let running=false;
async function tick(){if(running)return;running=true;try{const result=await service.tick();if(result.processed||result.escalated)process.stdout.write(JSON.stringify({event:'worker_tick',...result})+'\n');}catch{process.stderr.write(JSON.stringify({event:'worker_failure',recovery:'durable pending jobs retained'})+'\n');}finally{running=false;}}
await tick();const interval=setInterval(()=>void tick(),5000);process.stdout.write('CareLoop simulated worker running. No external messages are sent.\n');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{clearInterval(interval);void db.close().then(()=>process.exit(0));});
