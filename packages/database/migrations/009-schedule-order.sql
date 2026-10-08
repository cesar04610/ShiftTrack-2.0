ALTER TABLE schedules ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
UPDATE schedules s SET position = o.n
 FROM (SELECT branch_id, id,
        row_number() OVER (PARTITION BY branch_id, business_date, (start_time < time '15:00')
                           ORDER BY start_time, id) - 1 AS n
       FROM schedules) o
 WHERE s.branch_id = o.branch_id AND s.id = o.id;
