import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { config } from './src/config.ts';

export default defineConfig({
  clientUrl: config.databaseUrl,
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    path: './migrations',
    glob: '!(*.d).ts',
    transactional: true,
    emit: 'ts',
  },
});
