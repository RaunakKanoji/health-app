import { createClerkClient } from '@clerk/backend';
import type { FastifyRequest } from 'fastify';
import type { CareLoopConfig } from '../../config/src/index.ts';
import { DomainError } from '../../domain/src/index.ts';

export type VerifiedIdentity = {
  clerkUserId:string; email:string; name:string; emailVerified:boolean;
  sessionId:string; updatedAt:number;
};
export type IdentityVerifier=(request:FastifyRequest)=>Promise<VerifiedIdentity>;

function issuerFromPublishableKey(key:string):string {
  const encoded=key.match(/^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/)?.[1];
  if(!encoded)throw new DomainError('AUTH_CONFIGURATION','Authentication is not configured. Contact the administrator.',503);
  const host=Buffer.from(encoded,'base64').toString('utf8').replace(/\$$/,'');
  if(!/^[a-z0-9.-]+$/i.test(host)||!host.includes('.'))throw new DomainError('AUTH_CONFIGURATION','Authentication is not configured. Contact the administrator.',503);
  return `https://${host}`;
}
function statusOf(error:unknown):number|undefined {
  return typeof error==='object'&&error!==null&&'status' in error&&typeof error.status==='number'?error.status:undefined;
}
/** The sole production identity verifier. No legacy-cookie fallback or environment test bypass. */
export function createClerkIdentityVerifier(config:CareLoopConfig):IdentityVerifier {
  let client:ReturnType<typeof createClerkClient>|undefined;
  const publishableKey=config.CLERK_PUBLISHABLE_KEY||config.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const authorizedParties=[new URL(config.APP_ORIGIN).origin];
  const local=new URL(config.APP_ORIGIN);
  if(local.protocol==='http:'&&['localhost','127.0.0.1'].includes(local.hostname)){
    local.hostname=local.hostname==='localhost'?'127.0.0.1':'localhost';authorizedParties.push(local.origin);
  }
  return async request=>{
    if(!request.headers.authorization&&!request.cookies?.__session)throw new DomainError('UNAUTHENTICATED','Sign in to access CareLoop.',401);
    if(!config.CLERK_SECRET_KEY||!publishableKey)throw new DomainError('AUTH_CONFIGURATION','Clerk configuration is required before signing in.',503);
    client??=createClerkClient({secretKey:config.CLERK_SECRET_KEY,publishableKey});
    const headers=new Headers();
    for(const [name,value] of Object.entries(request.headers)){if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):value);}
    const incoming=new Request(new URL(request.url,config.APP_ORIGIN),{method:request.method,headers});
    try {
      const result=await client.authenticateRequest(incoming,{acceptsToken:'session_token',authorizedParties,issuer:config.CLERK_ISSUER_URL??issuerFromPublishableKey(publishableKey)});
      if(!result.isAuthenticated)throw new DomainError('UNAUTHENTICATED','Your session expired. Sign in again.',401);
      const auth=result.toAuth();
      if(!auth.userId||!auth.sessionId)throw new DomainError('UNAUTHENTICATED','An active user session is required.',401);
      // Explicit online checks prevent a revoked/deleted account from retaining access until JWT expiry.
      const [session,user]=await Promise.all([client.sessions.getSession(auth.sessionId),client.users.getUser(auth.userId)]);
      if(session.status!=='active'||session.userId!==auth.userId||user.banned||user.locked||user.deprovisioned)throw new DomainError('UNAUTHENTICATED','This session is no longer active.',401);
      const email=user.emailAddresses.find(e=>e.id===user.primaryEmailAddressId);
      if(!email||email.verification?.status!=='verified')throw new DomainError('EMAIL_VERIFICATION_REQUIRED','Verify your primary email address before continuing.',403);
      return {clerkUserId:user.id,email:email.emailAddress.toLowerCase(),name:user.fullName||user.firstName||'CareLoop user',emailVerified:true,sessionId:auth.sessionId,updatedAt:user.updatedAt};
    } catch(error){
      if(error instanceof DomainError)throw error;
      if([401,403,404].includes(statusOf(error)??0))throw new DomainError('UNAUTHENTICATED','This session is no longer active. Sign in again.',401);
      throw new DomainError('AUTH_UNAVAILABLE','Authentication is temporarily unavailable. Please retry.',503);
    }
  };
}
