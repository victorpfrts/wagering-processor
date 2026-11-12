import { loadConfig } from './src/config.ts';
import { buildOrmConfig } from './src/infrastructure/db/orm-config.ts';

export default buildOrmConfig(loadConfig().databaseUrl);
