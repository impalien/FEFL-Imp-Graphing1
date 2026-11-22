import { pool, close } from './db.ts';
import { SCHEMA } from './schema.ts';

await pool.query(SCHEMA);
console.log('Database tables are ready.');
await close();
