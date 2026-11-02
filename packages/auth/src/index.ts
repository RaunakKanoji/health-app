import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import type { Db } from '../../db/src/index.ts';
import type { User, Role } from '../../contracts/src/careloop.ts';
import { DomainError } from '../../domain/src/index.ts';
export function hashPassword(password:string):string { const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export function verifyPassword(password:string,hash:string):boolean {const [salt,expected]=hash.split(':');if(!salt||!expected)return false;const actual=scryptSync(password,salt,64);const stored=Buffer.from(expected,'hex');return stored.length===actual.length&&timingSafeEqual(stored,actual);}
export type UserRow={id:string;organization_id:string;email:string;name:string;role:Role;patient_id:string|null;password_hash:string};
export const publicUser=(u:UserRow):User=>({id:u.id,organizationId:u.organization_id,email:u.email,name:u.name,role:u.role,patientId:u.patient_id});
export const digestToken=(token:string,secret:string)=>createHmac('sha256',secret).update(token).digest('hex');
const dummyHash=hashPassword('unusable-timing-padding-password');
export async function login(db:Db,email:string,password:string,secret:string):Promise<{user:User;token:string}> {
 const result=await db.pool.query<UserRow>('SELECT * FROM users WHERE lower(email)=lower($1)',[email]);const row=result.rows[0];const valid=verifyPassword(password,row?.password_hash??dummyHash);
 if(!row||!valid)throw new DomainError('INVALID_CREDENTIALS','Email or password is incorrect.',401);
 const token=randomBytes(32).toString('base64url');await db.pool.query('INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[digestToken(token,secret),row.id,new Date(Date.now()+8*60*60*1000)]);return {user:publicUser(row),token};
}
export async function authenticate(db:Db,token:string|undefined,secret:string):Promise<User>{if(!token)throw new DomainError('UNAUTHENTICATED','Sign in to access CareLoop.',401);const result=await db.pool.query<UserRow>('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now()',[digestToken(token,secret)]);if(!result.rows[0])throw new DomainError('UNAUTHENTICATED','Your session expired. Sign in again.',401);return publicUser(result.rows[0]);}
