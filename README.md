# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (desafio técnico Jungle Gaming).

> Em construção. Decisões em `docs/adr/`, regras adotadas em `docs/regras.md`.

## Requisitos
- Bun 1.x
- Docker + Docker Compose

## Comandos
```sh
bun install
bun run infra:up      # PostgreSQL (5433) e LocalStack/SQS (4566)
bun run migration:up  # aplica o schema (migration:down reverte)
bun run dev           # API em http://localhost:3000
bun run typecheck
bun run test:unit         # domínio puro, sem infraestrutura
bun run test:integration  # PostgreSQL real (exige infra:up)
bun run test:concurrency  # corridas reais contra o PostgreSQL
bun run infra:down
```
