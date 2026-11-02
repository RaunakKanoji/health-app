import {buildApp} from './app.ts';
import {readConfig} from '../../../packages/config/src/index.ts';
const config=readConfig();const app=await buildApp();
await app.listen({port:config.API_PORT,host:'127.0.0.1'});
process.stdout.write(`CareLoop API ready on http://127.0.0.1:${config.API_PORT} (synthetic demo).\n`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
