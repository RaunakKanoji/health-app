import { describe, expect, it, vi } from 'vitest';
import { verifyMissingClerkUser } from './provision.ts';

describe('trusted deleted-Clerk-identity recovery evidence',()=>{
  it('issues evidence only when the exact user lookup returns HTTP404',async()=>{
    const lookup=vi.fn().mockRejectedValue({status:404});
    const proof=await verifyMissingClerkUser('user_former',lookup);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('user_former');
    expect(proof.clerkUserId).toBe('user_former');expect(Object.isFrozen(proof)).toBe(true);
  });
  it('rejects an existing former identity even when that account is disabled',async()=>{
    await expect(verifyMissingClerkUser('user_former',async()=>({id:'user_former',banned:true}))).rejects.toMatchObject({code:'IDENTITY_STILL_EXISTS',status:409});
  });
  it.each([401,403,429,500,503])('fails closed when the former identity lookup fails with HTTP%s',async status=>{
    await expect(verifyMissingClerkUser('user_former',async()=>{throw {status};})).rejects.toMatchObject({code:'IDENTITY_LOOKUP_UNAVAILABLE',status:503});
  });
  it('rejects network errors and inexact identity selectors',async()=>{
    await expect(verifyMissingClerkUser('user_former',async()=>{throw new Error('network unavailable');})).rejects.toMatchObject({code:'IDENTITY_LOOKUP_UNAVAILABLE'});
    const lookup=vi.fn();await expect(verifyMissingClerkUser('former@example.test',lookup)).rejects.toMatchObject({code:'INVALID_IDENTITY'});expect(lookup).not.toHaveBeenCalled();
  });
});
