import {describe,expect,it} from 'vitest';
import {parseConfig} from '../../packages/config/src/index.ts';
import {allowLocalBootstrap,databaseEndpoint,migrationConnection,validateDatabaseSettings} from '../../packages/config/src/database.ts';
import {createDatabase,verifyDatabase} from '../../packages/db/src/index.ts';

const local='postgresql://fixture:fixture@127.0.0.1:54329/careloop?options=-c%20search_path%3Dcareloop_test_fixture';
const pooled='postgresql://runtime:fixture@ep-synthetic-pooler.us-east-2.aws.neon.tech/careloop?sslmode=require';
const direct='postgresql://migration:fixture@ep-synthetic.us-east-2.aws.neon.tech/careloop?sslmode=require';
const remote={DATABASE_URL:pooled,DATABASE_DIRECT_URL:direct,DATABASE_ENVIRONMENT:'development' as const};

describe('database environment and target validation',()=>{
  it('preserves local development configuration and does not echo invalid values',()=>{
    expect(parseConfig({DEMO_MODE:'true',DATABASE_URL:local}).DATABASE_ENVIRONMENT).toBe('development');
    expect(()=>parseConfig({DEMO_MODE:'true',DATABASE_URL:''})).toThrow('DATABASE_URL');
    const secret='not-a-url-with-private-token';
    try{databaseEndpoint(secret);throw new Error('expected rejection');}catch(error){expect(String(error)).not.toContain(secret);}
  });
  it('requires an explicit environment and TLS for remote database URLs',()=>{
    expect(()=>parseConfig({DEMO_MODE:'true',DATABASE_URL:pooled})).toThrow('DATABASE_ENVIRONMENT');
    expect(()=>databaseEndpoint(pooled.replace('?sslmode=require',''))).toThrow('require TLS');
    expect(()=>databaseEndpoint(pooled.replace('sslmode=require','sslmode=disable'))).toThrow('require TLS');
    expect(parseConfig({...remote,DEMO_MODE:'true'}).DATABASE_ENVIRONMENT).toBe('development');
  });
  it('allows different credentials for the same pooled/direct branch',()=>{
    expect(()=>validateDatabaseSettings(remote)).not.toThrow();
    expect(migrationConnection(remote)).toBe(direct);
    expect(migrationConnection({DATABASE_URL:local})).toBe(local);
    expect(migrationConnection({DATABASE_URL:pooled,DATABASE_URL_UNPOOLED:direct,DATABASE_ENVIRONMENT:'test'})).toBe(direct);
    expect(()=>validateDatabaseSettings({...remote,DATABASE_RUNTIME_URL:pooled.replace('runtime:fixture','restricted:new-credential')})).not.toThrow();
    expect(()=>validateDatabaseSettings({...remote,DATABASE_RUNTIME_URL:pooled.replace('ep-synthetic-pooler','ep-other-pooler')})).toThrow('restricted runtime connection');
  });
  it('rejects unrelated branch, database or schema even when both endpoints have TLS',()=>{
    for(const candidate of [direct.replace('ep-synthetic.','ep-unrelated.'),direct.replace('/careloop?','/another?'),direct+'&options=-c%20search_path%3Danother']){
      expect(()=>validateDatabaseSettings({...remote,DATABASE_DIRECT_URL:candidate})).toThrow('same branch');
    }
    expect(()=>validateDatabaseSettings({...remote,DATABASE_URL_UNPOOLED:direct.replace('/careloop?','/old?')})).toThrow('same branch');
  });
  it('rejects pooled migration URLs and remote migration without a direct URL',()=>{
    expect(()=>migrationConnection({...remote,DATABASE_DIRECT_URL:pooled})).toThrow('must not use a pooled');
    expect(()=>migrationConnection({DATABASE_URL:pooled,DATABASE_ENVIRONMENT:'development'})).toThrow('DATABASE_DIRECT_URL');
  });
  it('does not permit migration or automatic bootstrap on production/staging targets',()=>{
    for(const environment of ['production','staging'] as const){
      expect(()=>migrationConnection({...remote,DATABASE_ENVIRONMENT:environment})).toThrow('restricted');
      expect(allowLocalBootstrap({DATABASE_URL:local,DATABASE_ENVIRONMENT:environment})).toBe(false);
    }
    expect(allowLocalBootstrap(remote)).toBe(false);
    expect(allowLocalBootstrap({DATABASE_URL:local})).toBe(true);
  });
  it('rejects URL destination overrides and bounds connection pools',()=>{
    expect(()=>databaseEndpoint(pooled+'&host=localhost')).toThrow('authority');
    expect(()=>databaseEndpoint(pooled+'&options=first&options=second')).toThrow('must not be repeated');
    expect(()=>createDatabase(local,{max:0})).toThrow('between 1 and 20');
    expect(()=>createDatabase(local,{max:21})).toThrow('between 1 and 20');
  });
  it('sanitizes connectivity failures',async()=>{
    const db=createDatabase('postgresql://fixture:never-log-this@127.0.0.1:1/careloop');
    try{expect(await verifyDatabase(db)).toEqual({status:'unavailable'});}finally{await db.close();}
  });
});
