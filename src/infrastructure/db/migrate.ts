import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config.ts';
import { buildOrmConfig } from './orm-config.ts';

/** Uso: bun src/infrastructure/db/migrate.ts up | down */
const direction = process.argv[2] ?? 'up';
if (direction !== 'up' && direction !== 'down') {
  console.error(`Unknown direction "${direction}". Use "up" or "down".`);
  process.exit(1);
}

const orm = await MikroORM.init(buildOrmConfig(loadConfig().databaseUrl));
try {
  const applied = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  console.log(
    JSON.stringify({ msg: `migration ${direction}`, migrations: applied.map((m) => m.name) }),
  );
} finally {
  await orm.close(true);
}
