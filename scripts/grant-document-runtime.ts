import {pathToFileURL} from 'node:url';
import {createDatabase,requireMigrations} from '../packages/db/src/index.ts';
import {readConfig,validateDatabaseSettings} from '../packages/config/src/index.ts';

export const documentReadInsertTables=['document_versions','document_upload_sessions','document_processing_jobs','document_extractions','clinical_observations','document_observation_corrections','clinical_document_reviews','document_timeline_events','document_security_checks'] as const;
export const documentUpdateTables=['medical_documents','document_upload_sessions','document_processing_jobs','clinical_observations'] as const;
const identifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
/** Add reviewed table grants to the existing role; never rotate its credentials or grant DDL/delete. */
export async function grantDocumentRuntime(args:string[]){
 if(args.some(arg=>arg!=='--apply'&&!arg.startsWith('--role=')))throw new Error('Use --apply and optionally --role=careloop_runtime.');
 const role=args.find(arg=>arg.startsWith('--role='))?.slice(7)??'careloop_runtime';
 if(!/^careloop_[a-z0-9_]{1,40}$/.test(role))throw new Error('Invalid runtime role name.');
 const config=readConfig();validateDatabaseSettings(config);
 const direct=config.DATABASE_DIRECT_URL??config.DATABASE_URL_UNPOOLED;
 if(!direct||new URL(direct).hostname.includes('-pooler.'))throw new Error('A direct owner connection is required.');
 const db=createDatabase(direct,{max:1});
 try{
  await requireMigrations(db);
  const state=(await db.pool.query<{schema:string;role_exists:boolean;owner:string}>('SELECT current_schema() AS schema,current_user AS owner,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1 AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole) AS role_exists',[role])).rows[0]!;
  if(!state.role_exists||!state.schema||state.schema.startsWith('pg_')||state.owner===role)throw new Error('Use the migration owner and an existing restricted runtime role.');
  const qualified=(table:string)=>`${identifier(state.schema)}.${identifier(table)}`;
  if(args.includes('--apply'))await db.transaction(async tx=>{
   await tx.query("SELECT pg_advisory_xact_lock(hashtext('careloop-document-runtime-grants'))");
   await tx.query(`GRANT SELECT,INSERT ON TABLE ${documentReadInsertTables.map(qualified).join(',')} TO ${identifier(role)}`);
   await tx.query(`GRANT UPDATE ON TABLE ${documentUpdateTables.map(qualified).join(',')} TO ${identifier(role)}`);
  });
  process.stdout.write(JSON.stringify({role,readInsertTables:documentReadInsertTables.length,updateTables:documentUpdateTables.length,deleteTables:0,schemaChanges:false,credentialsChanged:false,applied:args.includes('--apply')})+'\n');
 }finally{await db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{await grantDocumentRuntime(process.argv.slice(2));}catch{process.stderr.write('Document runtime grant update failed. Check the selected owner connection, applied migrations and existing restricted runtime role. No credentials were logged.\n');process.exitCode=1;}
}
