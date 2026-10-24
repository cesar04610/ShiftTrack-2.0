import { pool, transaction } from './db.js';
import { randomUUID } from 'node:crypto';
import { shiftBusinessDate } from '../../../packages/domain/index.js';

// Attendance follows the session: signing in clocks in, signing out (or expiring) clocks out.
export const SESSION_HOURS = 9;
// A reload or accidental close followed by a quick sign-in continues the same shift.
const REOPEN_MINUTES = 15;
type Person = { id: string; role: string; branch_id: string | null };
const tracked = (user: Person) => !!user.branch_id && user.role !== 'superadmin';

export async function clockInAtLogin(user: Person) {
  if (!tracked(user)) return;
  const branch = (
    await pool.query('SELECT timezone,active FROM branches WHERE id=$1', [user.branch_id])
  ).rows[0];
  if (!branch?.active) return;
  await transaction(user.branch_id!, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    // An entry left open longer than a session lasts ended when that session expired.
    await db.query(
      `UPDATE clock_records SET clock_out=clock_in+make_interval(hours=>$2)
       WHERE user_id=$1 AND clock_out IS NULL AND clock_in<=now()-make_interval(hours=>$2)`,
      [user.id, SESSION_HOURS],
    );
    if (
      (
        await db.query('SELECT id FROM clock_records WHERE user_id=$1 AND clock_out IS NULL', [
          user.id,
        ])
      ).rowCount
    )
      return;
    const recent = (
      await db.query(
        `SELECT id FROM clock_records WHERE user_id=$1
         AND clock_out>=now()-make_interval(mins=>$2) AND clock_in>now()-make_interval(hours=>$3)
         ORDER BY clock_out DESC LIMIT 1 FOR UPDATE`,
        [user.id, REOPEN_MINUTES, SESSION_HOURS],
      )
    ).rows[0];
    if (recent) {
      await db.query('UPDATE clock_records SET clock_out=NULL WHERE id=$1', [recent.id]);
      return;
    }
    await db.query(
      'INSERT INTO clock_records(branch_id,id,user_id,business_date,clock_in) VALUES($1,$2,$3,$4,now())',
      [user.branch_id, randomUUID(), user.id, shiftBusinessDate(new Date(), branch.timezone)],
    );
  });
}

// Called after a session was revoked: the exit counts only when no other session remains open.
export async function clockOutAtLogout(user: Person) {
  if (!tracked(user)) return;
  await transaction(user.branch_id!, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    if (
      (
        await db.query(
          'SELECT 1 FROM auth_sessions WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>now()) LIMIT 1',
          [user.id],
        )
      ).rowCount
    )
      return;
    await db.query(
      'UPDATE clock_records SET clock_out=now() WHERE user_id=$1 AND clock_out IS NULL',
      [user.id],
    );
  });
}

// Safety net for sessions that ended without a sign-out: expiry, password change, deactivation.
export async function closeAbandonedClocks() {
  let closed = 0;
  for (const branch of (await pool.query('SELECT id FROM branches')).rows)
    await transaction(branch.id, async (db) => {
      closed +=
        (
          await db.query(
            `UPDATE clock_records c SET clock_out=LEAST(now(),c.clock_in+make_interval(hours=>$1))
             WHERE c.clock_out IS NULL AND (
               c.clock_in<=now()-make_interval(hours=>$1)
               OR NOT EXISTS(SELECT 1 FROM auth_sessions s WHERE s.user_id=c.user_id
                             AND (s.expires_at IS NULL OR s.expires_at>now())))`,
            [SESSION_HOURS],
          )
        ).rowCount || 0;
    });
  return closed;
}
