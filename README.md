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
bun run dev           # API em http://localhost:3000
bun run typecheck
bun test
bun run infra:down
```
