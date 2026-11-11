import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../../src/storage/db.js';

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const checkRes = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
      if (checkRes.rows.length === 0) {
        console.log(`Applying migration: ${file}...`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        if (sql.includes('ALTER TYPE') && !sql.includes('$$')) {
          const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
          for (const stmt of stmts) {
            await client.query(stmt);
          }
        } else {
          await client.query(sql);
        }
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        console.log(`Successfully applied: ${file}`);
      } else {
        console.log(`Migration already applied: ${file}`);
      }
    }
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith('run-migrations.ts')) {
  runMigrations()
    .then(() => {
      console.log('All migrations executed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
