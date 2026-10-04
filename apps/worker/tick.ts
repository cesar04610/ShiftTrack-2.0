import { pool, transaction, verifyRuntimeRole } from '../api/src/db.js';
import { generateTasks } from '../api/src/modules.js';
import { localTime } from '../../packages/domain/index.js';
import { randomUUID } from 'node:crypto';
import { notify, dispatchMail } from './mail.js';
export async function tick() {
  await verifyRuntimeRole();
  const branches = (await pool.query('SELECT id,timezone FROM branches WHERE active')).rows;
  let generated = 0,
    alerts = 0;
  for (const branch of branches) {
    const date = localTime(new Date(), branch.timezone).date;
    await transaction(branch.id, async (db) => {
      const current = (
        await db.query('SELECT active FROM branches WHERE id=$1 FOR SHARE', [branch.id])
      ).rows[0];
      if (!current?.active) return;
      generated += await generateTasks(db, branch.id, date);
      const settings = (await db.query('SELECT * FROM alert_settings')).rows[0] || {
        absence_tolerance_minutes: 15,
        cut_delay_minutes: 30,
      };
      const schedules = (
        await db.query(
          `SELECT s.*,u.name FROM schedules s JOIN users u ON u.id=s.user_id WHERE business_date=$1 AND u.active`,
          [date],
        )
      ).rows;
      for (const s of schedules) {
        const current = localTime(new Date(), branch.timezone).minutes,
          start = Number(s.start_time.slice(0, 2)) * 60 + Number(s.start_time.slice(3, 5));
        const present = (
          await db.query('SELECT id FROM clock_records WHERE user_id=$1 AND business_date=$2', [
            s.user_id,
            date,
          ])
        ).rowCount;
        if (!present && current >= start + settings.absence_tolerance_minutes) {
          const r = await db.query(
            'INSERT INTO alerts(branch_id,id,type,message,source_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [
              branch.id,
              randomUUID(),
              'absence',
              `Sin registro de entrada recibido: ${s.name}. Aviso provisional; puede haber capturas pendientes.`,
              s.id,
            ],
          );
          alerts += r.rowCount || 0;
          if (r.rowCount)
            await notify(
              db,
              branch.id,
              `absence:${s.id}`,
              'Mostrador · Ausencia provisional',
              `Sin registro de entrada recibido: ${s.name}. Puede haber capturas pendientes. Fecha ${date}; horario ${s.start_time}–${s.end_time}.`,
            );
        } else if (present) {
          await db.query(
            "UPDATE alerts SET resolved=true,message=$2 WHERE type='absence' AND source_key=$1",
            [s.id, `Registro de entrada recibido: ${s.name}. Aviso provisional resuelto.`],
          );
        }
        const end = Number(s.end_time.slice(0, 2)) * 60 + Number(s.end_time.slice(3, 5));
        const hasCut = (await db.query('SELECT id FROM cuts WHERE schedule_id=$1', [s.id]))
          .rowCount;
        if (present && !hasCut && current >= end + settings.cut_delay_minutes) {
          const result = await db.query(
            'INSERT INTO alerts(branch_id,id,type,message,source_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [
              branch.id,
              randomUUID(),
              'missing_cut',
              `Corte pendiente: ${s.name}. Aviso provisional; puede haber capturas pendientes.`,
              s.id,
            ],
          );
          alerts += result.rowCount || 0;
          if (result.rowCount)
            await notify(
              db,
              branch.id,
              `missing_cut:${s.id}`,
              'Mostrador · Corte pendiente',
              `${s.name}: corte del horario ${s.start_time}–${s.end_time}, fecha ${date}. Aviso provisional.`,
            );
        } else if (hasCut)
          await db.query(
            "UPDATE alerts SET resolved=true,message=$2 WHERE type='missing_cut' AND source_key=$1",
            [s.id, `Corte recibido: ${s.name}. Aviso resuelto.`],
          );
      }
      const lastEnd = schedules.reduce(
        (max: number, s: any) =>
          Math.max(max, Number(s.end_time.slice(0, 2)) * 60 + Number(s.end_time.slice(3, 5))),
        0,
      );
      if (schedules.length && localTime(new Date(), branch.timezone).minutes > lastEnd) {
        const summary = (
          await db.query(
            'SELECT count(*)::text total,count(completed_at)::text completed FROM tasks WHERE due_date=$1',
            [date],
          )
        ).rows[0];
        await notify(
          db,
          branch.id,
          `task_summary:${date}`,
          'Mostrador · Resumen de tareas',
          `Fecha ${date}: ${summary.completed} de ${summary.total} tareas completadas. Los dispositivos desconectados pueden tener capturas pendientes.`,
        );
      }
    });
  }
  return { generated, alerts, ...(await dispatchMail()) };
}
if (process.argv[1]?.endsWith('tick.ts')) {
  try {
    console.log(await tick());
  } finally {
    await pool.end();
  }
}
