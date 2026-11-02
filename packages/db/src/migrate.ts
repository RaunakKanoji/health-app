import {createDatabase,migrate} from './index.ts';
import {migrationConnection,readConfig} from '../../config/src/index.ts';
try {
  const config=readConfig();
  const db=createDatabase(migrationConnection(config),{max:1});
  try{await migrate(db);process.stdout.write('Database migrations applied to the selected development database.\n');}
  finally{await db.close();}
} catch {
  process.stderr.write('Database migration failed. Check the selected development environment, matching direct connection, connectivity and migration checksums. No connection details are logged.\n');
  process.exitCode=1;
}
