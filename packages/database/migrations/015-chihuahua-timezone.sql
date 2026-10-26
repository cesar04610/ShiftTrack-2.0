-- Las tiendas están en Cuauhtémoc, Chihuahua: UTC-6 todo el año desde 2022, no la hora de Mazatlán (UTC-7).
UPDATE branches SET timezone='America/Chihuahua' WHERE timezone='America/Mazatlan';
ALTER TABLE branches ALTER COLUMN timezone SET DEFAULT 'America/Chihuahua';
