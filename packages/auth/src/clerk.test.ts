import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { createClerkIdentityVerifier } from './clerk.ts';
import type { CareLoopConfig } from '../../config/src/index.ts';

const mock=vi.hoisted(()=>({authenticateRequest:vi.fn(),getSession:vi.fn(),getUser:vi.fn()}));
vi.mock('@clerk/backend',()=>({createClerkClient:()=>({authenticateRequest:mock.authenticateRequest,sessions:{getSession:mock.getSession},users:{getUser:mock.getUser}})}));
const publishableKey=`pk_test_${Buffer.from('isolated-test.clerk.accounts.dev$').toString('base64')}`;
const config:CareLoopConfig={DEMO_MODE:'true',DATABASE_URL:'unused',APP_ORIGIN:'http://localhost:3000',API_PORT:4000,DATA_RETENTION_DAYS:365,DEFAULT_ORGANIZATION_ID:'org-test',CLERK_SECRET_KEY:'sk_test_synthetic',NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:publishableKey};
const request=()=>({url:'/api/identity',method:'GET',headers:{authorization:'Bearer synthetic-test-token'},cookies:{}} as unknown as FastifyRequest);
const clerkUser=()=>({id:'user_test',emailAddresses:[{id:'email_test',emailAddress:'synthetic@example.test',verification:{status:'verified'}}],primaryEmailAddressId:'email_test',fullName:'Synthetic User',updatedAt:123,banned:false,locked:false});

describe('production Clerk verifier boundaries',()=>{
  beforeEach(()=>{vi.resetAllMocks();mock.authenticateRequest.mockResolvedValue({isAuthenticated:true,toAuth:()=>({userId:'user_test',sessionId:'sess_test'})});mock.getSession.mockResolvedValue({status:'active',userId:'user_test'});mock.getUser.mockResolvedValue(clerkUser());});
  it('uses session-only verification, explicit issuer and exact permitted origins, then checks Clerk online',async()=>{
    const result=await createClerkIdentityVerifier(config)(request());
    expect(result).toMatchObject({clerkUserId:'user_test',sessionId:'sess_test',emailVerified:true});
    expect(mock.authenticateRequest).toHaveBeenCalledWith(expect.any(Request),{acceptsToken:'session_token',issuer:'https://isolated-test.clerk.accounts.dev',authorizedParties:['http://localhost:3000','http://127.0.0.1:3000']});
    expect(mock.getSession).toHaveBeenCalledWith('sess_test');expect(mock.getUser).toHaveBeenCalledWith('user_test');
  });
  it('rejects legacy cookies and missing Clerk configuration without a fallback',async()=>{
    const legacy={url:'/api/identity',method:'GET',headers:{cookie:'careloop_session=legacy'},cookies:{careloop_session:'legacy'}} as unknown as FastifyRequest;
    await expect(createClerkIdentityVerifier(config)(legacy)).rejects.toMatchObject({status:401});
    await expect(createClerkIdentityVerifier({...config,CLERK_SECRET_KEY:undefined})(request())).rejects.toMatchObject({status:503});
    expect(mock.authenticateRequest).not.toHaveBeenCalled();
  });
  it('rejects expired/invalid JWTs without calling the user lookup',async()=>{
    mock.authenticateRequest.mockResolvedValue({isAuthenticated:false});
    await expect(createClerkIdentityVerifier(config)(request())).rejects.toMatchObject({status:401});
    expect(mock.getSession).not.toHaveBeenCalled();expect(mock.getUser).not.toHaveBeenCalled();
  });
  it.each(['revoked','ended','removed'])('rejects a %s session despite a valid JWT',async status=>{
    mock.getSession.mockResolvedValue({status,userId:'user_test'});
    await expect(createClerkIdentityVerifier(config)(request())).rejects.toMatchObject({status:401});
  });
  it('rejects a deleted user and fails closed on Clerk availability errors',async()=>{
    mock.getUser.mockRejectedValue({status:404});await expect(createClerkIdentityVerifier(config)(request())).rejects.toMatchObject({status:401});
    mock.getUser.mockRejectedValue({status:503});await expect(createClerkIdentityVerifier(config)(request())).rejects.toMatchObject({status:503});
  });
  it('rejects unverified primary email, disabled users and sessions from another user',async()=>{
    const unverified=clerkUser();unverified.emailAddresses[0]!.verification.status='unverified';mock.getUser.mockResolvedValue(unverified);
    await expect(createClerkIdentityVerifier(config)(request())).rejects.toMatchObject({status:403});
    mock.getUser.mockResolvedValue({...clerkUser(),banned:true});await expect(createClerkIdentityVerifier(config)(request())).rejects.toMatchObject({status:401});
    mock.getUser.mockResolvedValue({...clerkUser(),deprovisioned:true});await expect(createClerkIdentityVerifier(config)(request())).rejects.toMatchObject({status:401});
    mock.getUser.mockResolvedValue(clerkUser());mock.getSession.mockResolvedValue({status:'active',userId:'user_other'});
    await expect(createClerkIdentityVerifier(config)(request())).rejects.toMatchObject({status:401});
  });
});
