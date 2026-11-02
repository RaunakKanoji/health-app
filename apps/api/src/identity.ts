import { verifyWebhook } from '@clerk/backend/webhooks';
import { z } from 'zod';
import type { CareLoopApp } from './app.ts';
import { DomainError } from '../../../packages/domain/src/index.ts';
import { readConfig } from '../../../packages/config/src/index.ts';
import type { IdentityService } from '../../../packages/auth/src/identity.ts';
import { accountStatusSchema, clinicianOnboardingSchema, clinicianReviewSchema, patientOnboardingSchema, relationshipSchema, roleChangeSchema } from '../../../packages/contracts/src/identity.ts';

export async function registerIdentityRoutes(app:CareLoopApp,identity:IdentityService){
  app.get('/api/identity',async request=>identity.state(await app.authenticate(request)));
  app.post('/api/onboarding/patient',async request=>identity.onboardPatient(await app.authenticate(request),patientOnboardingSchema.parse(request.body)));
  app.post('/api/onboarding/clinician',async request=>identity.onboardClinician(await app.authenticate(request),clinicianOnboardingSchema.parse(request.body)));
  app.get('/api/admin/users',async request=>({users:await identity.listUsers(await app.authenticate(request))}));
  app.get('/api/admin/clinicians',async request=>({clinicians:await identity.listClinicians(await app.authenticate(request))}));
  app.post<{Params:{userId:string}}>('/api/admin/clinicians/:userId/review',async request=>{
    const actor=await app.authenticate(request),input=clinicianReviewSchema.parse(request.body);
    return {clinician:await identity.reviewClinician(actor,request.params.userId,input.decision,input.reason)};
  });
  app.post<{Params:{id:string}}>('/api/admin/users/:id/status',async request=>{
    const actor=await app.authenticate(request),input=accountStatusSchema.parse(request.body);
    return {user:await identity.setAccountStatus(actor,request.params.id,input.accountStatus)};
  });
  app.post<{Params:{id:string}}>('/api/admin/users/:id/role',async request=>{
    const actor=await app.authenticate(request),input=roleChangeSchema.parse(request.body);
    return {user:await identity.setRole(actor,request.params.id,input.role)};
  });
  app.get('/api/admin/relationships',async request=>identity.relationships(await app.authenticate(request)));
  app.post('/api/admin/relationships',async request=>({relationship:await identity.grantRelationship(await app.authenticate(request),relationshipSchema.parse(request.body))}));
  app.post<{Params:{id:string}}>('/api/admin/relationships/:id/revoke',async request=>{
    const actor=await app.authenticate(request);z.object({}).strict().parse(request.body??{});
    await identity.revokeRelationship(actor,request.params.id);return {ok:true};
  });
  app.get('/api/admin/audit',async request=>({events:await identity.auditEvents(await app.authenticate(request))}));

  // Preserve the exact signed payload only in this plugin; other JSON routes keep Fastify parsing.
  await app.register(async webhook=>{
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser('application/json',{parseAs:'string'},(_request,body,done)=>done(null,body));
    webhook.post('/api/webhooks/clerk',async request=>{
      const config=readConfig();
      if(!config.CLERK_WEBHOOK_SIGNING_SECRET)throw new DomainError('WEBHOOK_CONFIGURATION','Webhook verification is not configured.',503);
      if(typeof request.body!=='string')throw new DomainError('WEBHOOK_INVALID','A signed JSON payload is required.',400);
      const headers=new Headers();
      for(const name of ['svix-id','svix-timestamp','svix-signature']){
        const value=request.headers[name];if(typeof value==='string')headers.set(name,value);
      }
      let event;
      try {event=await verifyWebhook(new Request(new URL(request.url,config.APP_ORIGIN),{method:'POST',headers,body:request.body}),{signingSecret:config.CLERK_WEBHOOK_SIGNING_SECRET});}
      catch {throw new DomainError('WEBHOOK_INVALID','Webhook signature verification failed.',400);}
      if(!['user.created','user.updated','user.deleted'].includes(event.type))return {ok:true,ignored:true};
      const deliveryId=headers.get('svix-id');
      if(!deliveryId||!Number.isSafeInteger(event.timestamp)||event.timestamp<=0)throw new DomainError('WEBHOOK_INVALID','Webhook metadata is invalid.',400);
      if(event.type==='user.deleted'){
        if(!event.data.id)throw new DomainError('WEBHOOK_INVALID','Webhook identity is missing.',400);
        return {ok:true,...await identity.synchronize({deliveryId,type:event.type,clerkUserId:event.data.id,timestamp:event.timestamp})};
      }
      if(event.type==='user.created'||event.type==='user.updated'){
        const data=event.data,email=data.email_addresses.find(item=>item.id===data.primary_email_address_id);
        const updatedAt=data.updated_at;
        if(!data.id||!Number.isSafeInteger(updatedAt)||updatedAt<=0)throw new DomainError('WEBHOOK_INVALID','Webhook identity is invalid.',400);
        return {ok:true,...await identity.synchronize({deliveryId,type:event.type,clerkUserId:data.id,timestamp:updatedAt,disabled:data.banned||data.locked||data.deprovisioned,identity:{clerkUserId:data.id,email:email?.email_address.toLowerCase()??'',name:[data.first_name,data.last_name].filter(Boolean).join(' ')||'CareLoop user',emailVerified:email?.verification?.status==='verified',updatedAt}})};
      }
      return {ok:true,ignored:true};
    });
  });
}
