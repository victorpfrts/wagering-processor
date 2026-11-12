import { Migration20261112000001_InitialSchema } from './Migration20261112000001_InitialSchema.ts';

/** Lista explícita e ordenada: não depende de varredura de arquivos em runtime. */
export const migrationsList = [
  {
    name: 'Migration20261112000001_InitialSchema',
    class: Migration20261112000001_InitialSchema,
  },
];
