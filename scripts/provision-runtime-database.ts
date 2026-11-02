import {randomBytes} from 'node:crypto';
import {open,unlink} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDatabase,migrationFiles,requireMigrations} from '../packages/db/src/index.ts';
import {databaseEndpoint,readConfig,validateDatabaseSettings} from '../packages/config/src/index.ts';

// Reviewed runtime writes. Migration, seed and identity-provision commands retain
// the owner connection; future schema changes require another explicit grant review.
export const runtimeInsertTables=[
  'users','organization_memberships','role_assignments','patients','patient_identifiers','patient_consents',
  'fhir_resources','screening_results','observations','care_episodes','episode_events','episode_owners','episode_tasks',
  'clinical_reviews','referrals','referral_events','appointments','encounters','communications','message_attempts',
  'acknowledgements','clinical_documents','evidence_records','closure_decisions','audit_events','access_grants',
  'inbox_events','outbox_events','workflow_executions','model_registry','risk_predictions','ai_recommendations','scenario_runs',
  'clinician_profiles','clinician_patient_relationships','clerk_webhook_deliveries','clerk_identity_tombstones',
  'consultations','clinical_notes','medical_documents','lab_orders','lab_reports','lab_results','ai_analyses','ai_findings',
  'ai_analysis_sources','treatment_plans','followups','clinical_record_commands',
  'document_versions','document_security_checks','document_upload_sessions','document_processing_jobs','document_extractions',
  'clinical_observations','document_observation_corrections','clinical_document_reviews','document_timeline_events',
] as const;
export const runtimeUpdateTables=[
  'users','patients','screening_results','care_episodes','episode_tasks','referrals','appointments','communications',
  'evidence_records','access_grants','inbox_events','outbox_events','clinician_profiles','clinician_patient_relationships',
  'clerk_identity_tombstones','lab_orders','lab_reports','ai_analyses','ai_findings',
  'medical_documents','document_upload_sessions','document_processing_jobs','clinical_observations',
] as const;
const identifier=(name:string)=>`"${name.replaceAll('"','""')}"`;
const qualified=(schema:string,table:string)=>`${identifier(schema)}.${identifier(table)}`;

export async function provisionRuntimeDatabase(args:string[]){
  if(args.some(value=>value!=='--apply'&&!value.startsWith('--role=')))throw new Error('Use --apply and optionally --role=careloop_runtime.');
  const role=args.find(value=>value.startsWith('--role='))?.slice(7)??'careloop_runtime';
  if(!/^careloop_[a-z0-9_]{1,40}$/.test(role))throw new Error('Runtime role names must use the careloop_ prefix and lowercase identifier characters.');
  const config=readConfig();validateDatabaseSettings(config);
  const direct=config.DATABASE_DIRECT_URL??config.DATABASE_URL_UNPOOLED;
  if(!direct)throw new Error('A direct owner connection is required.');
  const endpoint=databaseEndpoint(direct);
  if(!endpoint.hostname.endsWith('.neon.tech')||endpoint.hostname.includes('-pooler.'))throw new Error('Provisioning requires the selected direct Neon connection.');
  const db=createDatabase(direct,{max:1});
  try {
    await requireMigrations(db);
    const state=(await db.pool.query<{schema:string;database:string;role_exists:boolean}>('SELECT current_schema() AS schema,current_database() AS database,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS role_exists',[role])).rows[0]!;
    if(state.role_exists)throw new Error('The runtime role already exists; it will not be modified.');
    if(!state.schema||state.schema.startsWith('pg_'))throw new Error('Select an application schema before provisioning.');
    const tables=new Set<string>(['schema_migrations']);
    for(const file of await migrationFiles())for(const match of file.sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_]+)/g))tables.add(match[1]!);
    for(const name of [...runtimeInsertTables,...runtimeUpdateTables])if(!tables.has(name))throw new Error('The reviewed grants do not match the checked-in schema.');
    const summary={role,selectTables:tables.size,insertTables:runtimeInsertTables.length,updateTables:runtimeUpdateTables.length,deleteTables:['role_assignments'],schemaChanges:false,applied:false};
    if(!args.includes('--apply')){process.stdout.write(JSON.stringify(summary)+'\n');return;}
    const file=fileURLToPath(new URL('../.env.runtime',import.meta.url));
    // Reserve the ignored destination before creating a credential. Never replace a file.
    const handle=await open(file,'wx',0o600);let committed=false,readyToCommit=false;
    const password=randomBytes(32).toString('base64url');
    const runtime=databaseEndpoint(config.DATABASE_URL);runtime.username=role;runtime.password=password;runtime.searchParams.set('sslmode','verify-full');
    const credentialText=`# Generated application role. Never commit or print this file.\nDATABASE_RUNTIME_URL=${runtime.href}\n`;
    try {
      await db.transaction(async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`careloop-runtime-provision:${role}`]);
        if((await tx.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)throw new Error('Runtime role already exists.');
        // The role is restricted to an identifier alphabet and the generated password
        // to base64url. CREATE ROLE does not accept protocol bind parameters.
        await tx.query(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 30 PASSWORD '${password}'`);
        await tx.query(`GRANT CONNECT ON DATABASE ${identifier(state.database)} TO ${identifier(role)}`);
        await tx.query(`GRANT USAGE ON SCHEMA ${identifier(state.schema)} TO ${identifier(role)}`);
        await tx.query(`GRANT SELECT ON TABLE ${[...tables].map(table=>qualified(state.schema,table)).join(',')} TO ${identifier(role)}`);
        await tx.query(`GRANT INSERT ON TABLE ${runtimeInsertTables.map(table=>qualified(state.schema,table)).join(',')} TO ${identifier(role)}`);
        await tx.query(`GRANT UPDATE ON TABLE ${runtimeUpdateTables.map(table=>qualified(state.schema,table)).join(',')} TO ${identifier(role)}`);
        // PostgreSQL requires a column UPDATE grant for SELECT ... FOR SHARE.
        // Signed-note immutability remains enforced by the existing trigger.
        await tx.query(`GRANT UPDATE(id) ON ${qualified(state.schema,'clinical_notes')} TO ${identifier(role)}`);
        await tx.query(`GRANT DELETE ON TABLE ${qualified(state.schema,'role_assignments')} TO ${identifier(role)}`);
        const sequence=(await tx.query<{sequence:string|null}>('SELECT pg_get_serial_sequence($1,$2) AS sequence',[`${state.schema}.patient_consents`,'sequence'])).rows[0]?.sequence;
        if(sequence)await tx.query(`GRANT USAGE ON SEQUENCE ${sequence} TO ${identifier(role)}`);
        const privileges=(await tx.query<{schema_create:boolean;database_create:boolean;superuser:boolean;create_role:boolean;create_database:boolean;bypass_rls:boolean;replication:boolean}>("SELECT has_schema_privilege($1,$2,'CREATE') AS schema_create,has_database_privilege($1,current_database(),'CREATE') AS database_create,rolsuper AS superuser,rolcreaterole AS create_role,rolcreatedb AS create_database,rolbypassrls AS bypass_rls,rolreplication AS replication FROM pg_roles WHERE rolname=$1",[role,state.schema])).rows[0]!;
        if(Object.values(privileges).some(Boolean))throw new Error('Inherited privileges exceed the runtime policy; provisioning was rolled back.');
        readyToCommit=true;
      });
      committed=true;
      await handle.writeFile(credentialText,'utf8');
      await handle.sync();
      process.stdout.write(JSON.stringify({...summary,applied:true,credentialFile:'.env.runtime'})+'\n');
    } catch(error) {
      // A failed file write after commit requires operator recovery; do not modify
      // the new role or erase a possibly written credential automatically.
      if(!committed&&readyToCommit){
        // COMMIT acknowledgement can be lost even when PostgreSQL committed.
        // Preserve the new credential privately so an operator can inspect safely.
        await handle.writeFile(credentialText,'utf8').catch(()=>{});await handle.sync().catch(()=>{});
      } else if(!committed){await handle.close();await unlink(file).catch(()=>{});}
      throw error;
    } finally {await handle.close().catch(()=>{});}
  } finally {await db.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await provisionRuntimeDatabase(process.argv.slice(2));}
  catch{process.stderr.write('Runtime database role provisioning failed. Verify the selected Neon owner connection, applied migrations, absence of the requested role and absence of .env.runtime. No credentials were logged.\n');process.exitCode=1;}
}
