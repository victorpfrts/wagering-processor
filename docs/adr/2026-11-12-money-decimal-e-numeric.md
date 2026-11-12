# ADR-004 — Money com decimal.js e NUMERIC(19,2)

Data: 2026-11-12 · Status: aceito

## Contexto
É proibido usar `number` para dinheiro. O valor entra e sai como string decimal com 2 casas. O modelo deve ser multi-moeda mesmo operando só em BRL.

## Opções
1. **Centavos em `bigint`.** Exato e rápido; fixa a escala no código e foge do esqueleto dado (`Decimal`).
2. **`decimal.js` no domínio + `NUMERIC(19,2)` no banco**, trafegando como string entre os dois.

## Decisão
Opção 2.
- Entrada aceita `^(0|[1-9]\d*)(\.\d{1,2})?$` e normaliza para 2 casas. Rejeita negativo, notação científica, `NaN`, `Infinity`, vazio e mais de 2 casas.
- Não há arredondamento: soma e subtração de valores com 2 casas são exatas; entrada com mais casas é rejeitada, não arredondada.
- Persistência: `amount NUMERIC(19,2)` + `currency CHAR(3)`. O driver devolve `NUMERIC` como string e assim ele chega ao `Money.from`.
- Valor zero só é aceito em `LOSS`.

## Consequências
- Nenhum ponto do caminho converte para `number`.
- Limite de 17 dígitos inteiros, suficiente para o domínio.

## Riscos
- Alguém configurar o driver para converter `NUMERIC` em `number`. Mitigação: teste de integração com valor acima de 2^53.
