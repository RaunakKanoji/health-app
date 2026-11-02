import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { z, ZodError } from 'zod';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { createDatabase, migrate, type Db } from '../../../packages/db/src/index.ts';
import { readConfig } from '../../../packages/config/src/index.ts';
import { WorkflowService } from '../../../packages/workflows/src/service.ts';
import { authenticate, login, digestToken } from '../../../packages/auth/src/index.ts';
import { DomainError, policies } from '../../../packages/domain/src/index.ts';
import { commandSchema, type User } from '../../../packages/contracts/src/careloop.ts';
import { seedDatabase } from '../../../scripts/seed/index.ts';
import { registerScenarioRoutes } from './scenarios.ts';
import { registerMlRoutes } from './ml.ts';
export type CareLoopApp = FastifyInstance & {db:Db;service:WorkflowService;authenticate:(request:FastifyRequest)=>Promise<User>};
export type AppOptions={databaseUrl?:string;seed?:boolean;clock?:()=>string;demoMode?:boolean};
export async function buildApp(options:AppOptions={}):Promise<CareLoopApp>{
 const config=readConfig();if(options.demoMode===false)throw new Error('This prototype requires explicit synthetic demonstration mode.');
 const db=createDatabase(options.databaseUrl??config.DATABASE_URL);await migrate(db);if(options.seed!==false)await seedDatabase(db);
 const app=Fastify({logger:false,bodyLimit:1024*1024,trustProxy:false}) as unknown as CareLoopApp;
 const service=new WorkflowService(db,options.clock);
 app.decorate('db',db);app.decorate('service',service);app.decorate('authenticate',(request:FastifyRequest)=>authenticate(db,request.cookies.careloop_session,config.SESSION_SECRET));
 await app.register(cookie);await app.register(rateLimit,{max:300,timeWindow:'1 minute'});await app.register(helmet,{contentSecurityPolicy:false});
 app.addHook('onClose',async()=>{await db.close();});
 app.addHook('onRequest',async(request,reply)=>{
  reply.header('Cache-Control','private, no-store, max-age=0');reply.header('Pragma','no-cache');
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){
   const origin=request.headers.origin;
   if(origin&&origin!==config.APP_ORIGIN)throw new DomainError('ORIGIN_DENIED','Request origin is not permitted.',403);
   if(request.headers['sec-fetch-site']==='cross-site')throw new DomainError('ORIGIN_DENIED','Cross-site requests are not permitted.',403);
  }
 });
 app.setErrorHandler(async(error,request,reply)=>{
  if(error instanceof DomainError&&[403,404].includes(error.status)){try{const actor=await app.authenticate(request);await db.pool.query('INSERT INTO audit_events(id,organization_id,actor_id,action,request_id,metadata) VALUES(gen_random_uuid()::text,$1,$2,$3,$4,$5)',[actor.organizationId,actor.id,'authorization_denied',request.id,JSON.stringify({code:error.code,method:request.method,route:request.routeOptions.url??'unknown'})]);}catch{/* No identity is asserted when authentication failed. */}}
  if(error instanceof DomainError)return reply.code(error.status).send({error:{code:error.code,message:error.message,requestId:request.id}});
  if(error instanceof ZodError)return reply.code(422).send({error:{code:'INVALID_INPUT',message:'Check the required fields and input formats.',requestId:request.id}});
  const statusCode=typeof error==='object'&&error!==null&&'statusCode' in error&&typeof error.statusCode==='number'?error.statusCode:500;
  if(statusCode<500)return reply.code(statusCode).send({error:{code:'REQUEST_REJECTED',message:statusCode===429?'Too many requests. Please wait before retrying.':'The request was rejected.',requestId:request.id}});
  process.stderr.write(JSON.stringify({level:'error',event:'request_failed',requestId:request.id,code:'INTERNAL_ERROR'})+'\n');
  return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'The request could not be completed. Retry or contact the care team.',requestId:request.id}});
 });
 app.get('/api/health',async()=>{await db.pool.query('SELECT 1');return {status:'ok',mode:'synthetic-demo',database:'postgresql',externalMessaging:false};});
 app.post('/api/auth/login',{config:{rateLimit:{max:15,timeWindow:'1 minute'}}},async(request,reply)=>{
  const input=z.object({email:z.string().email().max(254),password:z.string().min(1).max(200)}).strict().parse(request.body);
  const session=await login(db,input.email,input.password,config.SESSION_SECRET);
  reply.setCookie('careloop_session',session.token,{httpOnly:true,sameSite:'strict',secure:config.APP_ORIGIN.startsWith('https:'),path:'/',maxAge:8*60*60});return {user:session.user};
 });
 app.get('/api/auth/me',async request=>({user:await app.authenticate(request)}));
 app.post('/api/auth/logout',async(request,reply)=>{const token=request.cookies.careloop_session;if(token)await db.pool.query('DELETE FROM sessions WHERE id=$1',[digestToken(token,config.SESSION_SECRET)]);reply.clearCookie('careloop_session',{path:'/'});return {ok:true};});
 app.get('/api/workspace',async request=>service.workspace(await app.authenticate(request)));
 app.get('/api/episodes',async request=>({episodes:await service.listEpisodes(await app.authenticate(request))}));
 app.get<{Params:{id:string}}>('/api/episodes/:id',async request=>({episode:await service.getEpisode(await app.authenticate(request),request.params.id)}));
 app.post<{Params:{id:string}}>('/api/episodes/:id/actions',async request=>{
  const actor=await app.authenticate(request);const command=commandSchema.parse(request.body);const key=z.string().min(1).max(200).parse(request.headers['idempotency-key']);
  return trace.getTracer('careloop-api').startActiveSpan('episode.command',async span=>{span.setAttribute('careloop.action',command.type);try{return {episode:await service.command(actor,request.params.id,command,key)};}catch(error){span.setStatus({code:SpanStatusCode.ERROR});throw error;}finally{span.end();}});
 });
 app.post<{Params:{id:string}}>('/api/episodes/:id/assistant',async request=>{const actor=await app.authenticate(request);const {question}=z.object({question:z.string().trim().min(1).max(2000)}).strict().parse(request.body);return service.assistant(actor,request.params.id,question);});
 app.get('/api/policies',async request=>{await app.authenticate(request);return {policies};});
 app.get('/api/metrics',async request=>{const actor=await app.authenticate(request);if(actor.role==='patient'||actor.role==='receiver')throw new DomainError('FORBIDDEN','Population reporting requires organization staff access.',403);let episodes=await service.listEpisodes(actor);const filter=z.object({pathway:z.enum(['diabetes','colorectal','hypertension']).optional(),organizationId:z.string().optional(),from:z.string().date().optional(),to:z.string().date().optional()}).parse(request.query);if(filter.organizationId&&filter.organizationId!==actor.organizationId)throw new DomainError('NOT_FOUND','Organization unavailable.',404);if(filter.pathway)episodes=episodes.filter(e=>e.pathway===filter.pathway);if(filter.from)episodes=episodes.filter(e=>e.createdAt>=filter.from!);if(filter.to)episodes=episodes.filter(e=>e.createdAt.slice(0,10)<=filter.to!);return service.calculateMetrics(episodes);});
 app.post('/api/fhir/ingest',async request=>{const actor=await app.authenticate(request);const input=z.object({source:z.string().min(1).max(200),eventId:z.string().min(1).max(200),resource:z.unknown()}).strict().parse(request.body);return service.ingest(actor,{...input,resource:input.resource});});
 app.get('/api/audit',async request=>{const actor=await app.authenticate(request);if(!['admin','clinician','coordinator'].includes(actor.role))throw new DomainError('FORBIDDEN','Audit access requires authorized organization staff.',403);return {events:(await db.pool.query('SELECT id,actor_id,episode_id,action,request_id,metadata,created_at FROM audit_events WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200',[actor.organizationId])).rows};});
 app.get('/api/inbox',async request=>{const actor=await app.authenticate(request);const episodes=await service.listEpisodes(actor);return {communications:episodes.flatMap(e=>e.communications.map(c=>({...c,episodeId:e.id,patientName:e.patient.name,simulated:true})))};});
 app.get('/api/operations',async request=>{const actor=await app.authenticate(request);if(!['admin','coordinator','clinician'].includes(actor.role))throw new DomainError('FORBIDDEN','Operational queues require staff access.',403);return {outbox:(await db.pool.query('SELECT id,episode_id,kind,status,attempts,available_at,last_error FROM outbox_events WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',[actor.organizationId])).rows,deadLetters:(await db.pool.query("SELECT id,source,event_id,status,error,created_at FROM inbox_events WHERE organization_id=$1 AND status='DEAD_LETTER' ORDER BY created_at DESC LIMIT 100",[actor.organizationId])).rows};});
 app.post('/api/admin/tick',async request=>{const actor=await app.authenticate(request);if(actor.role!=='admin')throw new DomainError('FORBIDDEN','Only demonstration administrators may trigger the worker.',403);return service.tick(service.clock(),undefined,actor.organizationId);});
 await registerScenarioRoutes(app);
 await registerMlRoutes(app);
 return app;
}
