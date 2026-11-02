import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { z, ZodError } from 'zod';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { createDatabase, migrate, requireMigrations, verifyDatabase, type Db } from '../../../packages/db/src/index.ts';
import { readConfig, parseConfig, allowLocalBootstrap, databaseEndpoint, isLocalDatabase } from '../../../packages/config/src/index.ts';
import { WorkflowService } from '../../../packages/workflows/src/service.ts';
import { IdentityService } from '../../../packages/auth/src/identity.ts';
import { createClerkIdentityVerifier, type IdentityVerifier } from '../../../packages/auth/src/clerk.ts';
import { DomainError, policies } from '../../../packages/domain/src/index.ts';
import { commandSchema, type User } from '../../../packages/contracts/src/careloop.ts';
import { seedDatabase } from '../../../scripts/seed/index.ts';
import { registerScenarioRoutes } from './scenarios.ts';
import { registerMlRoutes } from './ml.ts';
import { registerIdentityRoutes } from './identity.ts';
import { registerClinicalRecordRoutes } from './clinical-records.ts';
import { registerDocumentRoutes } from './documents.ts';
import type { PrivateDocumentStore } from '../../../packages/workflows/src/medical-documents.ts';
export type CareLoopApp = FastifyInstance & {db:Db;service:WorkflowService;identity:IdentityService;authenticate:(request:FastifyRequest)=>Promise<User>};
export type AppOptions={databaseUrl?:string;seed?:boolean;clock?:()=>string;demoMode?:boolean;identityVerifier?:IdentityVerifier;documentStore?:PrivateDocumentStore|null};
export async function buildApp(options:AppOptions={}):Promise<CareLoopApp>{
 const config=options.databaseUrl?parseConfig({...process.env,DATABASE_URL:options.databaseUrl,DATABASE_DIRECT_URL:undefined,DATABASE_URL_UNPOOLED:undefined,DATABASE_RUNTIME_URL:undefined,DATABASE_ENVIRONMENT:isLocalDatabase(databaseEndpoint(options.databaseUrl))?'test':process.env.DATABASE_ENVIRONMENT}):readConfig();if(options.demoMode===false)throw new Error('This prototype requires explicit synthetic demonstration mode.');
 const allowedOrigins=new Set([new URL(config.APP_ORIGIN).origin]);
 const loopback=new URL(config.APP_ORIGIN);
 if(loopback.protocol==='http:'&&['localhost','127.0.0.1'].includes(loopback.hostname)){
  loopback.hostname=loopback.hostname==='localhost'?'127.0.0.1':'localhost';allowedOrigins.add(loopback.origin);
 }
 const databaseUrl=options.databaseUrl??config.DATABASE_RUNTIME_URL??config.DATABASE_URL;
 const db=createDatabase(databaseUrl,{max:config.DATABASE_POOL_MAX});
 try{
  if(allowLocalBootstrap({...config,DATABASE_URL:databaseUrl})){await migrate(db);if(options.seed!==false)await seedDatabase(db);}
  else await requireMigrations(db);
 }catch(error){await db.close();throw error;}
 const app=Fastify({logger:false,bodyLimit:1024*1024,trustProxy:false}) as unknown as CareLoopApp;
 const service=new WorkflowService(db,options.clock);
 const identity=new IdentityService(db,{verifyIdentity:options.identityVerifier??createClerkIdentityVerifier(config),organizationId:config.DEFAULT_ORGANIZATION_ID});
 app.decorate('db',db);app.decorate('service',service);app.decorate('identity',identity);
 // Request-local memoization never persists identity or authorization across requests.
 const identities=new WeakMap<FastifyRequest,Promise<User>>();
 app.decorate('authenticate',(request:FastifyRequest)=>{let resolved=identities.get(request);if(!resolved){resolved=identity.authenticate(request);identities.set(request,resolved);}return resolved;});
 await app.register(cookie);await app.register(rateLimit,{max:300,timeWindow:'1 minute'});await app.register(helmet,{contentSecurityPolicy:false});
 app.addHook('onClose',async()=>{await db.close();});
 app.addHook('onRequest',async(request,reply)=>{
  reply.header('Cache-Control','private, no-store, max-age=0');reply.header('Pragma','no-cache');
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){
   const origin=request.headers.origin;
   if(origin&&!allowedOrigins.has(origin))throw new DomainError('ORIGIN_DENIED','Request origin is not permitted.',403);
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
 app.get('/api/health',async(_request,reply)=>{const health=await verifyDatabase(db);return reply.code(health.status==='ok'?200:503).send(health);});
 app.get('/api/health/database',async(request,reply)=>{await app.authenticate(request);const health=await verifyDatabase(db);return reply.code(health.status==='ok'?200:503).send(health);});
 app.post('/api/auth/login',async()=>{throw new DomainError('CLERK_REQUIRED','Sign in through the Clerk sign-in page.',410);});
 app.get('/api/auth/me',async request=>({user:await app.authenticate(request)}));
 app.post('/api/auth/logout',async()=>{throw new DomainError('CLERK_REQUIRED','Sign out using the Clerk account control.',410);});
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
 app.get('/api/audit',async request=>{
  const actor=await app.authenticate(request);
  if(!['clinician','coordinator'].includes(actor.role))throw new DomainError('FORBIDDEN','Clinical audit access requires an authorized care-team member. Administrators use the security audit.',403);
  const episodeIds=(await service.listEpisodes(actor)).map(e=>e.id);
  return {events:(await db.pool.query('SELECT id,actor_id,episode_id,action,request_id,metadata,created_at FROM audit_events WHERE organization_id=$1 AND episode_id=ANY($2::text[]) ORDER BY created_at DESC LIMIT 200',[actor.organizationId,episodeIds])).rows};
 });
 app.get('/api/inbox',async request=>{const actor=await app.authenticate(request);const episodes=await service.listEpisodes(actor);return {communications:episodes.flatMap(e=>e.communications.map(c=>({...c,episodeId:e.id,patientName:e.patient.name,simulated:true})))};});
 app.get('/api/operations',async request=>{
  const actor=await app.authenticate(request);
  if(!['admin','coordinator','clinician'].includes(actor.role))throw new DomainError('FORBIDDEN','Operational queues require staff access.',403);
  const episodeIds=(await service.listEpisodes(actor)).map(e=>e.id);
  // Inbound dead letters may contain source identifiers or narratives. Only aggregate
  // counts belong in administration; clinical queue rows require explicit care access.
  return {outbox:(await db.pool.query('SELECT id,episode_id,kind,status,attempts,available_at,last_error FROM outbox_events WHERE organization_id=$1 AND episode_id=ANY($2::text[]) ORDER BY created_at DESC LIMIT 100',[actor.organizationId,episodeIds])).rows,deadLetters:[],deadLetterCount:Number((await db.pool.query<{count:string}>("SELECT count(*) AS count FROM inbox_events WHERE organization_id=$1 AND status='DEAD_LETTER'",[actor.organizationId])).rows[0]?.count??0)};
 });
 app.post('/api/admin/tick',async request=>{const actor=await app.authenticate(request);if(actor.role!=='admin')throw new DomainError('FORBIDDEN','Only demonstration administrators may trigger the worker.',403);return service.tick(service.clock(),undefined,actor.organizationId);});
 await registerScenarioRoutes(app);
 await registerMlRoutes(app);
 await registerIdentityRoutes(app,identity);
 await registerClinicalRecordRoutes(app);
 await registerDocumentRoutes(app,options.documentStore);
 return app;
}
