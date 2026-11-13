import { createApp } from './bootstrap.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port);
