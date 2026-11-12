# ADR-001 — MikroORM com registros de persistência e mappers

Data: 2026-11-12 · Status: aceito

## Contexto
O enunciado exige que o domínio não dependa do ORM nem de decorators do NestJS, que as classes tenham construtor privado e que a reidratação passe pela factory `rehydrate`. MikroORM é o ORM preferencial.

## Opções
1. **Decorators do MikroORM nas classes de domínio.** Menos código; viola a regra de independência do domínio e o ORM hidrata sem passar por `rehydrate`.
2. **`EntitySchema` apontando para as classes de domínio.** Domínio sem decorators, mas o ORM ainda instancia por fora das factories e passa a "enxergar" campos privados.
3. **Registros de persistência (`EntitySchema` de objetos simples) + mappers** que convertem registro ↔ domínio via `rehydrate`. Mais código, fronteira explícita.

## Decisão
Opção 3. O domínio fica em `src/domain` sem importar nada de ORM ou Nest. Os repositórios (adaptadores) usam o `EntityManager` dentro de `em.transactional()` e devolvem objetos de domínio.

## Consequências
- O Unit of Work e o Identity Map trabalham sobre os **registros**, não sobre o domínio: cada `UnitOfWork.run()` cria um `EntityManager` novo (`em.fork()`) e abre `em.transactional()`. A wallet travada com `LockMode.PESSIMISTIC_WRITE` fica no Identity Map e é a mesma instância que o repositório altera ao salvar.
- Cada escrita do repositório faz `flush` imediato. Abrimos mão do agrupamento automático de comandos para ter a ordem do SQL igual à ordem do use case (a transação antes do lançamento que a referencia) e o erro de constraint no ponto que o causou.
- Um mapper por agregado para manter. Custo aceito.
- `Money` é mapeado em duas colunas (`NUMERIC(19,2)` + `CHAR(3)`) e trafega como string (ver ADR-004).

## Riscos
- Esquecer um campo no mapper. Mitigação: testes de ida e volta (salvar, ler, comparar) na Fase 2.
