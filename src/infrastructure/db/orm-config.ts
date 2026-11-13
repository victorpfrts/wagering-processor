import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { migrationsList } from '../../../migrations/index.ts';
import { entitySchemas } from './records.ts';

export interface OrmConfigOptions {
  poolMax?: number;
}

export function buildOrmConfig(clientUrl: string, options: OrmConfigOptions = {}) {
  return defineConfig({
    clientUrl,
    entities: entitySchemas,
    pool: { min: 0, max: options.poolMax ?? 10 },
    extensions: [Migrator],
    migrations: {
      migrationsList,
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      // As migrations são SQL escrito à mão; não há schema gerado para comparar.
      snapshot: false,
    },
  });
}
