import { parseArgs } from 'node:util';
import { createClerkClient } from '@clerk/backend';
import { createDatabase, requireMigrations } from '../packages/db/src/index.ts';
import { readConfig } from '../packages/config/src/index.ts';
import { provisionClerkIdentity, verifyMissingClerkUser } from '../packages/auth/src/provision.ts';
import { DomainError } from '../packages/domain/src/index.ts';

async function main(){
  const {values}=parseArgs({options:{user:{type:'string'},'clerk-user':{type:'string'},'replace-clerk-user':{type:'string'},role:{type:'string'},apply:{type:'boolean',default:false},help:{type:'boolean',default:false}}});
  if(values.help||!values.user||!values['clerk-user']){
    process.stdout.write('Usage: pnpm identity:provision --user <local-user-id> --clerk-user <user_...> [--role admin | --replace-clerk-user <expected-old-user_...>] [--apply]\nOmit --apply to review the explicit mapping without changing it. Recovery requires a missing former Clerk identity and the same verified email on an active patient account. This command never creates or modifies a Clerk account.\n');
    if(!values.help)process.exitCode=1;return;
  }
  if(values.role&&values.role!=='admin')throw new Error('Only --role admin is accepted. Omit --role to preserve the current local role.');
  if(values['replace-clerk-user']&&values.role)throw new DomainError('ROLE_CONFLICT','Identity recovery cannot be combined with a role change.',409);
  const config=readConfig();
  if(!config.CLERK_SECRET_KEY)throw new Error('CLERK_SECRET_KEY is required.');
  const client=createClerkClient({secretKey:config.CLERK_SECRET_KEY});
  const user=await client.users.getUser(values['clerk-user']);
  const email=user.emailAddresses.find(item=>item.id===user.primaryEmailAddressId);
  if(user.banned||user.locked||user.deprovisioned||email?.verification?.status!=='verified')throw new Error('The selected Clerk account must be active with a verified primary email.');
  const oldClerkId=values['replace-clerk-user'];
  const replacement=oldClerkId?{expectedClerkUserId:oldClerkId,absence:await verifyMissingClerkUser(oldClerkId,id=>client.users.getUser(id))}:undefined;
  const db=createDatabase(config.DATABASE_URL);
  try{
    await requireMigrations(db);
    const result=await provisionClerkIdentity(db,{userId:values.user,identity:{clerkUserId:user.id,email:email.emailAddress,name:user.fullName||user.firstName||'CareLoop user',emailVerified:true,updatedAt:user.updatedAt},administrator:values.role==='admin',apply:values.apply,replacement});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }finally{await db.close();}
}
main().catch(error=>{process.stderr.write((error instanceof DomainError?`${error.code}: ${error.message}`:'Provisioning could not complete. Check the selected IDs, verified Clerk account and database configuration.')+'\n');process.exitCode=1;});
