import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { migrationsList } from '../../../migrations/index.ts';

export function buildOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList,
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
    },
  });
}
