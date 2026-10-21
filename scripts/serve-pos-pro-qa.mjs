// Manual localhost QA only: deliberately never imports src/server.js or workers.
import {assertPosProQaEnvironment} from './seed-pos-pro-qa.mjs';
assertPosProQaEnvironment();
const [{app},{pool},{verifyDatabaseSchema}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/db/verifySchema.js')]);
await verifyDatabaseSchema(pool);
const server=app.listen(4000,'127.0.0.1',()=>console.log('QA API http://127.0.0.1:4000; Telegram/webhook/AI workers NOT started'));
const stop=()=>server.close(()=>pool.end());process.once('SIGINT',stop);process.once('SIGTERM',stop);
