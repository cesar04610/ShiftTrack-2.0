import { pool } from '../api/src/db.js';
import { tick } from './tick.js';

// Trabajo programado privado: termina al completar, sin puerto HTTP ni SMTP configurado.
try {
  console.log({ status: 'WORKER_COMPLETE', ...(await tick()) });
} catch {
  console.error({ status: 'WORKER_FAILED' });
  process.exitCode = 1;
} finally {
  await pool.end();
}
