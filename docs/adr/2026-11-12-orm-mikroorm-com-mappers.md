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
- Não usamos o dirty checking do Unit of Work sobre o domínio: as escritas são explícitas no repositório. Para saldo isso é desejável, porque a escrita crítica fica visível e auditável.
- Um mapper por agregado para manter. Custo aceito.
- `Money` é mapeado em duas colunas (`NUMERIC(19,2)` + `CHAR(3)`) e trafega como string (ver ADR-004).

## Riscos
- Esquecer um campo no mapper. Mitigação: testes de ida e volta (salvar, ler, comparar) na Fase 2.
