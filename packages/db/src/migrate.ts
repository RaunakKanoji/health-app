import {createDatabase,migrate} from './index.ts';
import {readConfig} from '../../config/src/index.ts';
const config=readConfig();
const db=createDatabase(config.DATABASE_URL_UNPOOLED??config.DATABASE_URL);try{await migrate(db);process.stdout.write('Database migrations applied.\n');}finally{await db.close();}
