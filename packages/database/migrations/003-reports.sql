ALTER TABLE suppliers ADD COLUMN representative text NOT NULL DEFAULT '', ADD COLUMN phone text NOT NULL DEFAULT '', ADD COLUMN product_type text NOT NULL DEFAULT '';
ALTER TABLE cuts ADD COLUMN schedule_id uuid;
ALTER TABLE cuts ADD FOREIGN KEY(branch_id,schedule_id) REFERENCES schedules(branch_id,id);
