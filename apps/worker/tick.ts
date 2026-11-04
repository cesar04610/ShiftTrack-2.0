import { pool, transaction, verifyRuntimeRole } from '../api/src/db.js';
import { generateTasks } from '../api/src/modules.js';
import { evaluateAlerts } from '../api/src/alerts.js';
import { shiftBusinessDate } from '../../packages/domain/index.js';

// Trabajo programado: genera tareas recurrentes y revisa las alertas de la tienda.
export async function tick() {
  await verifyRuntimeRole();
  const branches = (await pool.query('SELECT id,timezone FROM branches WHERE active')).rows;
  let generated = 0,
    alerts = 0;
  for (const branch of branches) {
    // Tasks belong to the work day, which runs from 05:00 to 05:00.
    const date = shiftBusinessDate(new Date(), branch.timezone);
    await transaction(branch.id, async (db) => {
      const current = (
        await db.query('SELECT active FROM branches WHERE id=$1 FOR SHARE', [branch.id])
      ).rows[0];
      if (!current?.active) return;
      generated += await generateTasks(db, branch.id, date);
      alerts += await evaluateAlerts(db, branch);
    });
  }
  return { generated, alerts };
}
if (process.argv[1]?.endsWith('tick.ts')) {
  try {
    console.log(await tick());
  } finally {
    await pool.end();
  }
}
