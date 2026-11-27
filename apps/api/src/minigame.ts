import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { context, transaction } from './db.js';
import { identity } from './security.js';

export const minigame = Router();

const modeSchema = z.enum(['shift', 'endless']);

const scoreBodySchema = z.object({
  branch_id: z.uuid().optional(),
  id: z.uuid().optional(),
  mode: modeSchema,
  score: z.number().int().min(0).max(500_000),
  customers_served: z.number().int().min(0).max(10_000),
  sales_cents: z.number().int().min(0).max(500_000_000),
  grade: z.enum(['', 'S', 'A', 'B', 'C', 'D']).default(''),
  duration_seconds: z.number().int().min(0).max(86_400),
  max_combo: z.number().int().min(1).max(100).default(1),
  suppliers_received: z.number().int().min(0).max(1_000).default(0),
});

export type LeaderboardEntry = {
  rank: number;
  id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  user_active: boolean;
  mode: 'shift' | 'endless';
  score: number;
  customers_served: number;
  sales_cents: string;
  grade: string;
  duration_seconds: number;
  max_combo: number;
  suppliers_received: number;
  played_at: string;
  games_played: number;
};

async function readBoard(db: pg.PoolClient, mode: 'shift' | 'endless', userId: string) {
  const boardSql = `
    WITH ranked_runs AS (
      SELECT
        s.id,
        s.user_id,
        u.name AS user_name,
        u.role AS user_role,
        (u.active AND u.deleted_at IS NULL) AS user_active,
        s.mode,
        s.score,
        s.customers_served,
        s.sales_cents::text AS sales_cents,
        s.grade,
        s.duration_seconds,
        s.max_combo,
        s.suppliers_received,
        s.played_at,
        ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.score DESC, s.played_at ASC, s.id ASC) AS rn,
        COUNT(*) OVER (PARTITION BY s.user_id)::int AS games_played
      FROM minigame_scores s
      JOIN users u ON u.id = s.user_id
      WHERE s.mode = $1
    ),
    best_per_user AS (
      SELECT
        id,
        user_id,
        user_name,
        user_role,
        user_active,
        mode,
        score,
        customers_served,
        sales_cents,
        grade,
        duration_seconds,
        max_combo,
        suppliers_received,
        played_at,
        games_played,
        ROW_NUMBER() OVER (ORDER BY score DESC, played_at ASC, id ASC)::int AS rank
      FROM ranked_runs
      WHERE rn = 1
    )
    SELECT * FROM best_per_user
  `;

  const topRes = await db.query<LeaderboardEntry>(`${boardSql} ORDER BY rank ASC LIMIT 30`, [mode]);
  const personalRes = await db.query<LeaderboardEntry>(`${boardSql} WHERE user_id = $2`, [
    mode,
    userId,
  ]);
  const recentRes = await db.query(
    `SELECT
       s.id,
       s.user_id,
       u.name AS user_name,
       u.role AS user_role,
       s.mode,
       s.score,
       s.customers_served,
       s.sales_cents::text AS sales_cents,
       s.grade,
       s.duration_seconds,
       s.max_combo,
       s.suppliers_received,
       s.played_at
     FROM minigame_scores s
     JOIN users u ON u.id = s.user_id
     WHERE s.mode = $1
     ORDER BY s.played_at DESC, s.id DESC
     LIMIT 8`,
    [mode],
  );
  const modesRes = await db.query<{
    mode: 'shift' | 'endless';
    best_score: number;
    games_played: number;
  }>(
    `SELECT mode, MAX(score)::int AS best_score, COUNT(*)::int AS games_played
     FROM minigame_scores
     WHERE user_id = $1
     GROUP BY mode`,
    [userId],
  );

  const best_by_mode: Record<'shift' | 'endless', { best_score: number; games_played: number }> = {
    shift: { best_score: 0, games_played: 0 },
    endless: { best_score: 0, games_played: 0 },
  };
  for (const row of modesRes.rows) {
    best_by_mode[row.mode] = { best_score: row.best_score, games_played: row.games_played };
  }

  return {
    mode,
    leaderboard: topRes.rows,
    personal: personalRes.rows[0] ?? null,
    recent: recentRes.rows,
    best_by_mode,
  };
}

minigame.get('/minigame/leaderboard', async (req, res) => {
  const u = await identity(req.headers.authorization);
  const q = z
    .object({
      branch_id: z.string().optional(),
      mode: modeSchema.default('shift'),
    })
    .parse(req.query);
  const b = await context(u, q.branch_id, true);
  const data = await transaction(b.id, (db) => readBoard(db, q.mode, u.id));
  res.json({ branch_id: b.id, branch_name: b.name, ...data });
});

minigame.post('/minigame/scores', async (req, res) => {
  const u = await identity(req.headers.authorization);
  const body = scoreBodySchema.parse(req.body);
  const b = await context(u, body.branch_id);
  const id = body.id ?? randomUUID();

  const result = await transaction(b.id, async (db) => {
    const prevUser = await db.query<{ best: number | null }>(
      'SELECT MAX(score)::int AS best FROM minigame_scores WHERE mode=$1 AND user_id=$2',
      [body.mode, u.id],
    );
    const prevBranch = await db.query<{ best: number | null }>(
      'SELECT MAX(score)::int AS best FROM minigame_scores WHERE mode=$1',
      [body.mode],
    );

    const prevPersonalBest = prevUser.rows[0]?.best ?? null;
    const prevBranchBest = prevBranch.rows[0]?.best ?? null;

    const inserted = await db.query(
      `INSERT INTO minigame_scores(
         branch_id, id, user_id, mode, score, customers_served, sales_cents,
         grade, duration_seconds, max_combo, suppliers_received
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(branch_id, id) DO NOTHING
       RETURNING id`,
      [
        b.id,
        id,
        u.id,
        body.mode,
        body.score,
        body.customers_served,
        String(body.sales_cents),
        body.grade,
        body.duration_seconds,
        body.max_combo,
        body.suppliers_received,
      ],
    );

    const duplicate = inserted.rowCount === 0;
    const is_personal_best =
      !duplicate && body.score > 0 && (prevPersonalBest === null || body.score > prevPersonalBest);
    const is_branch_record =
      !duplicate && body.score > 0 && (prevBranchBest === null || body.score > prevBranchBest);

    const board = await readBoard(db, body.mode, u.id);
    return {
      saved_id: id,
      duplicate,
      is_personal_best,
      is_branch_record,
      branch_id: b.id,
      branch_name: b.name,
      ...board,
    };
  });

  res.json(result);
});
