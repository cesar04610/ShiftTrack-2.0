import nodemailer from 'nodemailer';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction, pool } from '../api/src/db.js';
export function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}
export function smtp() {
  if (!smtpConfigured()) throw Error('SMTP no configurado.');
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: process.env.NODE_ENV === 'production',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 10000,
    socketTimeout: 20000,
  });
}
export async function notify(
  db: pg.PoolClient,
  branch: string,
  key: string,
  subject: string,
  body: string,
) {
  const settings = (await db.query('SELECT * FROM alert_settings')).rows[0];
  if (!settings?.email_enabled || !settings.recipients.length) return;
  await db.query(
    'INSERT INTO notification_outbox(branch_id,id,source_key,recipients,subject,body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(branch_id,source_key) DO NOTHING',
    [branch, randomUUID(), key, settings.recipients, subject, body],
  );
}
export async function dispatchMail() {
  if (!smtpConfigured()) return { sent: 0, failed: 0 };
  const branches = (await pool.query('SELECT id FROM branches')).rows,
    transport = smtp();
  let sent = 0,
    failed = 0;
  const maxAttempts = Math.min(5, Math.max(1, Number(process.env.SMTP_MAX_ATTEMPTS || 1)));
  try {
    for (const branch of branches) {
      const enabled = await transaction(
        branch.id,
        async (db) =>
          (await db.query('SELECT email_enabled FROM alert_settings')).rows[0]?.email_enabled,
      );
      if (!enabled) continue;
      await transaction(branch.id, async (db) => {
        await db.query(
          "UPDATE notification_outbox SET status='needs_review',last_error='Entrega incierta: proceso interrumpido; revisar antes de reintentar' WHERE status='sending' AND lease_until<now()",
        );
      });
      for (let count = 0; count < 20; count++) {
        const row = await transaction(branch.id, async (db) => {
          const pending = (
            await db.query(
              "SELECT * FROM notification_outbox WHERE status IN ('pending','retry_wait') AND next_attempt_at<=now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1",
            )
          ).rows[0];
          if (!pending) return null;
          await db.query(
            "UPDATE notification_outbox SET status='sending',attempts=attempts+1,lease_until=now()+interval '2 minutes' WHERE id=$1",
            [pending.id],
          );
          return pending;
        });
        if (!row) break;
        try {
          const info = await transport.sendMail({
            from: process.env.SMTP_FROM,
            to: row.recipients,
            subject: row.subject,
            text: row.body,
          });
          if (info.rejected?.length)
            throw Error('Destinatarios rechazados; revisar entrega parcial.');
          await transaction(branch.id, async (db) => {
            await db.query(
              "UPDATE notification_outbox SET status='sent',sent_at=now(),last_error=NULL WHERE id=$1",
              [row.id],
            );
          });
          sent++;
        } catch (error) {
          const err = error as { code?: string; responseCode?: number };
          // Retry only an explicit transient SMTP rejection before acceptance. Network loss is uncertain.
          const transient =
            err.responseCode !== undefined && err.responseCode >= 400 && err.responseCode < 500;
          const uncertain = err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET';
          const status = uncertain
            ? 'needs_review'
            : transient && row.attempts + 1 < maxAttempts
              ? 'retry_wait'
              : 'failed';
          await transaction(branch.id, async (db) => {
            await db.query(
              "UPDATE notification_outbox SET status=$2,last_error=$3,next_attempt_at=now()+interval '5 minutes' WHERE id=$1",
              [
                row.id,
                status,
                uncertain
                  ? 'Entrega incierta; revisar antes de reintentar'
                  : 'SMTP rechazó o no pudo procesar el envío',
              ],
            );
          });
          failed++;
        }
      }
    }
  } finally {
    transport.close();
  }
  return { sent, failed };
}
