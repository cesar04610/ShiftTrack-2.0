import { pool, transaction, verifyRuntimeRole } from '../api/src/db.js';
import { assignWorkingStaff } from '../api/src/task-setup.js';
import { evaluateAlerts } from '../api/src/alerts.js';

// Trabajo programado: completa las tareas de quien está trabajando y revisa las alertas de la tienda.
export async function tick() {
  await verifyRuntimeRole();
  const branches = (await pool.query('SELECT id,timezone FROM branches WHERE active')).rows;
  let generated = 0,
    alerts = 0;
  for (const branch of branches) {
    await transaction(branch.id, async (db) => {
      const current = (
        await db.query('SELECT active FROM branches WHERE id=$1 FOR SHARE', [branch.id])
      ).rows[0];
      if (!current?.active) return;
      generated += await assignWorkingStaff(db, branch);
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
