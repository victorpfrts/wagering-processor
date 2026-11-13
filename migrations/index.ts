import { Migration20261112000001_InitialSchema } from './Migration20261112000001_InitialSchema.ts';
import { Migration20261113000001_ScopeIdempotencyKeyByProvider } from './Migration20261113000001_ScopeIdempotencyKeyByProvider.ts';

/** Lista explícita e ordenada: não depende de varredura de arquivos em runtime. */
export const migrationsList = [
  {
    name: 'Migration20261112000001_InitialSchema',
    class: Migration20261112000001_InitialSchema,
  },
  {
    name: 'Migration20261113000001_ScopeIdempotencyKeyByProvider',
    class: Migration20261113000001_ScopeIdempotencyKeyByProvider,
  },
];
