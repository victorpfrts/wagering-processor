import { Migration } from '@mikro-orm/migrations';

/**
 * A idempotency key passa a ser única POR PROVEDOR.
 *
 * Antes era única no sistema inteiro: dois provedores que usassem a mesma
 * chave colidiam, e um podia (por acaso ou de propósito) bloquear a chave de
 * outro. Toda chave fornecida pelo cliente deve ser escopada por quem a
 * forneceu.
 *
 * O índice novo é criado antes de o antigo ser removido: em nenhum instante a
 * tabela fica sem a garantia de unicidade.
 */
export class Migration20261113000001_ScopeIdempotencyKeyByProvider extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_provider_idempotency_key_unique
        unique (provider_id, idempotency_key)
    `);
    this.addSql(`
      alter table wager_transactions drop constraint wager_tx_idempotency_key_unique
    `);
  }

  /**
   * Volta à chave global. Falha, sem alterar nada, se já existirem dois
   * provedores com a mesma chave — nesse caso reverter perderia a garantia.
   */
  override down(): void {
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_idempotency_key_unique unique (idempotency_key)
    `);
    this.addSql(`
      alter table wager_transactions drop constraint wager_tx_provider_idempotency_key_unique
    `);
  }
}
