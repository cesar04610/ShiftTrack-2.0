DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shifttrack_app') THEN
  GRANT DELETE ON schedules TO shifttrack_app;
 END IF;
END $$;
