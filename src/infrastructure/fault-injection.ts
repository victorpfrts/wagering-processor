/**
 * Injeção de falha para os testes de crash (seção 13 do desafio).
 *
 * "O worker morre depois do commit e antes do ack" só é reproduzível de forma
 * determinística se o processo morrer exatamente nesse ponto. Com a variável
 * FAULT_INJECTION definida, o processo se mata com SIGKILL ali — sem
 * handlers, sem flush, sem desligamento limpo: é um kill -9 de verdade.
 *
 * Desligado por padrão; nenhum ambiente de produção deve definir a variável.
 */
export type FaultPoint = 'consumer.before-ack';

export function crashIfInjected(point: FaultPoint): void {
  if (process.env['FAULT_INJECTION'] === point) {
    process.kill(process.pid, 'SIGKILL');
  }
}
