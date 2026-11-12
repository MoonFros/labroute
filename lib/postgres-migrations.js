'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

async function migrate(pool, migrationsDir = path.join(__dirname, '..', 'migrations')) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('labroute:migrations', 0))");
    await client.query(`CREATE TABLE IF NOT EXISTS labroute_schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await fs.readdir(migrationsDir)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const { rows } = await client.query('SELECT checksum FROM labroute_schema_migrations WHERE version = $1', [file]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} changed. Add a new migration instead.`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO labroute_schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
      applied.push(file);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { migrate };
