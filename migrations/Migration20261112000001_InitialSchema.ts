import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade
 * ficam aqui, no banco: o código de aplicação é a primeira linha de defesa,
 * não a única.
 */
export class Migration20261112000001_InitialSchema extends Migration {
  override up(): void {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   text not null,
        currency    char(3) not null,
        balance     numeric(19,2) not null,
        version     integer not null,
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_player_not_blank check (length(btrim(player_id)) > 0)
      )
    `);

    // ----------------------------------------------------- wager_transactions
    // wallet_id não é FK de propósito: uma transação para wallet inexistente é
    // persistida como REJECTED (WALLET_NOT_FOUND) para ser auditável e idempotente.
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text not null,
        external_transaction_id            text not null,
        idempotency_key                    text not null,
        payload_hash                       text not null,
        wallet_id                          uuid not null,
        player_id                          text not null,
        round_id                           text not null,
        game_id                            text not null,
        kind                               text not null,
        amount                             numeric(19,2) not null,
        currency                           char(3) not null,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid references wager_transactions (id),
        status                             text not null,
        failure_code                       text,
        resulting_balance                  numeric(19,2),
        resulting_balance_currency         char(3),
        reference_attempts                 integer not null default 0,
        next_attempt_at                    timestamptz,
        created_at                         timestamptz not null,
        processed_at                       timestamptz,

        constraint wager_tx_idempotency_key_unique unique (idempotency_key),
        constraint wager_tx_provider_external_unique unique (provider_id, external_transaction_id),

        constraint wager_tx_kind_valid check
          (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_tx_status_valid check
          (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_tx_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_tx_amount_valid check
          (amount > 0 or (amount = 0 and kind = 'LOSS')),
        constraint wager_tx_reference_required check
          (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_reference_forbidden check
          (kind not in ('BET', 'OPENING') or reference_external_transaction_id is null),
        constraint wager_tx_failure_code_iff_failed check
          ((failure_code is not null) = (status in ('REJECTED', 'FAILED'))),
        constraint wager_tx_processed_at_iff_terminal check
          ((processed_at is not null) = (status in ('PROCESSED', 'REJECTED', 'FAILED'))),
        constraint wager_tx_next_attempt_iff_pending_reference check
          ((next_attempt_at is not null) = (status = 'PENDING_REFERENCE')),
        constraint wager_tx_processed_has_balance check
          (status <> 'PROCESSED' or resulting_balance is not null),
        constraint wager_tx_resulting_balance_pair check
          ((resulting_balance is null) = (resulting_balance_currency is null)),
        constraint wager_tx_resulting_balance_non_negative check (resulting_balance >= 0),
        constraint wager_tx_reference_attempts_non_negative check (reference_attempts >= 0)
      )
    `);

    // Uma transação tem no máximo UMA reversão efetiva (REFUND ou ROLLBACK).
    this.addSql(`
      create unique index wager_tx_single_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `);
    // Fila do worker de referências fora de ordem.
    this.addSql(`
      create index wager_tx_pending_reference_due
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);

    // Estados terminais não mudam mais e transações nunca são apagadas.
    this.addSql(`
      create function wager_tx_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted'
            using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is in terminal state %', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger wager_tx_guard before update or delete on wager_transactions
        for each row execute function wager_tx_guard()
    `);

    // -------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        wallet_id       uuid not null references wallets (id),
        transaction_id  uuid not null references wager_transactions (id),
        direction       text not null,
        amount          numeric(19,2) not null,
        currency        char(3) not null,
        balance_before  numeric(19,2) not null,
        balance_after   numeric(19,2) not null,
        wallet_version  integer not null,
        created_at      timestamptz not null,

        -- no máximo um lançamento por transação por wallet
        constraint ledger_one_entry_per_transaction unique (transaction_id, wallet_id),
        -- a cadeia do ledger não tem versão repetida; também serve à paginação por cursor
        constraint ledger_wallet_version_unique unique (wallet_id, wallet_version),
        constraint ledger_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_wallet_version_positive check (wallet_version >= 1),
        constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      )
    `);

    // Imutabilidade estrutural: nada de UPDATE, DELETE ou TRUNCATE.
    this.addSql(`
      create function ledger_immutable() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% not allowed)', tg_op
          using errcode = 'restrict_violation';
      end
      $$
    `);
    this.addSql(`
      create trigger ledger_no_update_delete before update or delete on wallet_ledger_entries
        for each row execute function ledger_immutable()
    `);
    this.addSql(`
      create trigger ledger_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function ledger_immutable()
    `);

    // Cada lançamento continua exatamente de onde o anterior parou.
    this.addSql(`
      create function ledger_chain_guard() returns trigger language plpgsql as $$
      declare
        previous record;
        wallet_currency char(3);
      begin
        select currency into wallet_currency from wallets where id = new.wallet_id;
        if new.currency <> wallet_currency then
          raise exception 'ledger entry currency % differs from wallet currency %',
            new.currency, wallet_currency using errcode = 'check_violation';
        end if;

        select wallet_version, balance_after into previous
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by wallet_version desc
         limit 1;

        if not found then
          -- primeiro lançamento: abertura (v1) ou primeira movimentação de wallet zerada (v2)
          if new.balance_before <> 0 or new.wallet_version not in (1, 2) then
            raise exception 'first ledger entry of wallet % must start from zero', new.wallet_id
              using errcode = 'check_violation';
          end if;
        elsif new.wallet_version <> previous.wallet_version + 1
           or new.balance_before <> previous.balance_after then
          raise exception 'ledger entry does not continue the chain of wallet %', new.wallet_id
            using errcode = 'check_violation';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger ledger_chain_guard before insert on wallet_ledger_entries
        for each row execute function ledger_chain_guard()
    `);

    // Saldo materializado == último lançamento, conferido no COMMIT.
    // Garante "toda alteração de saldo tem lançamento, e vice-versa" mesmo
    // contra um UPDATE manual ou um bug na aplicação.
    this.addSql(`
      create function wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target uuid;
        wallet record;
        last_entry record;
      begin
        if tg_table_name = 'wallets' then
          target := new.id;
        else
          target := new.wallet_id;
        end if;

        select balance, version into wallet from wallets where id = target;
        select balance_after, wallet_version into last_entry
          from wallet_ledger_entries
         where wallet_id = target
         order by wallet_version desc
         limit 1;

        if not found then
          if wallet.balance <> 0 or wallet.version <> 1 then
            raise exception 'wallet % has balance % (v%) without ledger entries',
              target, wallet.balance, wallet.version using errcode = 'check_violation';
          end if;
        elsif wallet.balance <> last_entry.balance_after
           or wallet.version <> last_entry.wallet_version then
          raise exception 'wallet % (balance %, v%) diverges from ledger (balance %, v%)',
            target, wallet.balance, wallet.version,
            last_entry.balance_after, last_entry.wallet_version
            using errcode = 'check_violation';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_matches_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallet_matches_ledger()
    `);
    this.addSql(`
      create constraint trigger ledger_matches_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_matches_ledger()
    `);

    // ------------------------------------------------------------------ inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name  text not null,
        message_id     text not null,
        payload_hash   text not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      )
    `);

    // ----------------------------------------------------------------- outbox
    this.addSql(`
      create table outbox_messages (
        seq              bigint generated always as identity,
        id               uuid primary key,
        aggregate_id     text not null,
        partition_key    text not null,
        event_type       text not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        constraint outbox_seq_unique unique (seq),
        constraint outbox_attempts_non_negative check (attempts >= 0)
      )
    `);
    // O publisher só enxerga o que ainda não saiu.
    this.addSql(`
      create index outbox_pending on outbox_messages (seq) where published_at is null
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
    this.addSql(`drop function if exists wallet_matches_ledger()`);
    this.addSql(`drop function if exists ledger_chain_guard()`);
    this.addSql(`drop function if exists ledger_immutable()`);
    this.addSql(`drop function if exists wager_tx_guard()`);
  }
}
