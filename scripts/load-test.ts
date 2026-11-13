/**
 * Teste de carga. Uso:
 *
 *   bun run docker:up     # 3 réplicas em :3000, :3001 e :3002
 *   bun run test:load
 *
 * Variáveis (todas opcionais):
 *   LOAD_BASE_URLS         instâncias-alvo, separadas por vírgula
 *   LOAD_SCENARIO          distributed | hot | both        (padrão: both)
 *   LOAD_DURATION_SECONDS  duração de cada cenário          (padrão: 30)
 *   LOAD_CONCURRENCY       clientes simultâneos             (padrão: 64)
 *   LOAD_WALLETS           wallets do cenário distributed   (padrão: 200)
 *
 * Cada cliente virtual envia uma requisição, espera a resposta e envia a
 * próxima (modelo fechado), alternando entre as instâncias. Ao final o script
 * espera a outbox esvaziar e reconcilia TODAS as wallets usadas: um número de
 * vazão só vale se o resultado estiver correto.
 */
type Json = Record<string, any>;

const baseUrls = (process.env['LOAD_BASE_URLS'] ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const scenarioArg = process.env['LOAD_SCENARIO'] ?? 'both';
const durationSeconds = Number(process.env['LOAD_DURATION_SECONDS'] ?? 30);
const concurrency = Number(process.env['LOAD_CONCURRENCY'] ?? 64);
const walletCount = Number(process.env['LOAD_WALLETS'] ?? 200);

let requestCounter = 0;
const nextUrl = (): string => baseUrls[requestCounter++ % baseUrls.length] as string;
const uuid = (): string => Bun.randomUUIDv7();

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${nextUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function metric(name: string): Promise<number[]> {
  return Promise.all(
    baseUrls.map(async (url) => {
      const text = await (await fetch(`${url}/metrics`)).text();
      return text
        .split('\n')
        .filter((line) => line.startsWith(name))
        .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
    }),
  );
}
const metricSum = async (name: string): Promise<number> =>
  (await metric(name)).reduce((sum, value) => sum + value, 0);
const metricMax = async (name: string): Promise<number> => Math.max(...(await metric(name)));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallets(count: number, balance: string): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (let start = 0; start < count; start += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, count - start) }, async () => {
        const { status, body } = await post('/wallets', {
          playerId: `load-${uuid()}`,
          initialBalance: { amount: balance, currency: 'BRL' },
        });
        if (status !== 201) throw new Error(`could not open wallet: ${status}`);
        return { id: body['id'] as string, playerId: body['playerId'] as string };
      }),
    );
    wallets.push(...batch);
  }
  return wallets;
}

interface ScenarioResult {
  name: string;
  wallets: number;
  requests: number;
  seconds: number;
  statuses: Record<string, number>;
  networkErrors: number;
  latenciesMs: number[];
  lockConflicts: number;
  duplicateKeyRaces: number;
  maxOutboxLagSeconds: number;
  maxOutboxPending: number;
  drainSeconds: number;
  inconsistentWallets: number;
}

async function runScenario(name: string, wallets: Wallet[]): Promise<ScenarioResult> {
  const conflictsBefore = await metricSum('wagering_concurrency_conflicts_total{reason="LOCK_TIMEOUT"}');
  const racesBefore = await metricSum('wagering_concurrency_conflicts_total{reason="DUPLICATE_KEY"}');
  const statuses: Record<string, number> = {};
  const latenciesMs: number[] = [];
  const sent: Json[] = [];
  let networkErrors = 0;
  let maxOutboxLagSeconds = 0;
  let maxOutboxPending = 0;
  let running = true;

  const sampler = (async () => {
    while (running) {
      maxOutboxLagSeconds = Math.max(maxOutboxLagSeconds, await metricMax('wagering_outbox_lag_seconds'));
      maxOutboxPending = Math.max(maxOutboxPending, await metricMax('wagering_outbox_pending_messages'));
      await Bun.sleep(500);
    }
  })();

  const buildRequest = (): Json => {
    // 10% reenvia uma requisição já feita (replay); o resto é novo: 65% BET, 25% WIN
    const dice = Math.random();
    if (dice < 0.1 && sent.length > 0) return sent[Math.floor(Math.random() * sent.length)] as Json;
    const wallet = wallets[Math.floor(Math.random() * wallets.length)] as Wallet;
    const cents = 100 + Math.floor(Math.random() * 900);
    const body = {
      providerId: 'load-provider',
      externalTransactionId: `load-${uuid()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${Math.floor(Math.random() * 1000)}`,
      gameId: 'fortune-chimp',
      kind: dice < 0.75 ? 'BET' : 'WIN',
      money: { amount: (cents / 100).toFixed(2), currency: 'BRL' },
    };
    if (sent.length < 5000) sent.push(body);
    return body;
  };

  const startedAt = performance.now();
  const deadline = startedAt + durationSeconds * 1000;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        const body = buildRequest();
        const t0 = performance.now();
        try {
          const { status } = await post('/wagering/transactions', body, {
            'Idempotency-Key': `${body['providerId']}:${body['externalTransactionId']}`,
          });
          latenciesMs.push(performance.now() - t0);
          statuses[status] = (statuses[status] ?? 0) + 1;
        } catch {
          networkErrors += 1;
        }
      }
    }),
  );
  const seconds = (performance.now() - startedAt) / 1000;

  // quanto tempo a outbox leva para alcançar a carga
  const drainStart = performance.now();
  while ((await metricMax('wagering_outbox_pending_messages')) > 0) {
    if (performance.now() - drainStart > 120_000) break;
    await Bun.sleep(250);
  }
  const drainSeconds = (performance.now() - drainStart) / 1000;
  running = false;
  await sampler;

  // correção: saldo == ledger em todas as wallets
  let inconsistentWallets = 0;
  for (let start = 0; start < wallets.length; start += 20) {
    const results = await Promise.all(
      wallets.slice(start, start + 20).map((wallet) => post(`/wallets/${wallet.id}/reconciliation`, {})),
    );
    inconsistentWallets += results.filter((r) => r.body['consistent'] !== true).length;
  }

  return {
    name,
    wallets: wallets.length,
    requests: latenciesMs.length + networkErrors,
    seconds,
    statuses,
    networkErrors,
    latenciesMs: latenciesMs.sort((a, b) => a - b),
    lockConflicts:
      (await metricSum('wagering_concurrency_conflicts_total{reason="LOCK_TIMEOUT"}')) - conflictsBefore,
    duplicateKeyRaces:
      (await metricSum('wagering_concurrency_conflicts_total{reason="DUPLICATE_KEY"}')) - racesBefore,
    maxOutboxLagSeconds,
    maxOutboxPending,
    drainSeconds,
    inconsistentWallets,
  };
}

function report(result: ScenarioResult): void {
  const { latenciesMs: l, statuses } = result;
  const ok = (statuses['200'] ?? 0) + (statuses['202'] ?? 0);
  const rejected = statuses['422'] ?? 0;
  const transient = statuses['503'] ?? 0;
  const others = Object.entries(statuses)
    .filter(([status]) => !['200', '202', '422', '503'].includes(status))
    .reduce((sum, [, count]) => sum + count, 0);
  const errors = transient + others + result.networkErrors;
  const row = (label: string, value: string | number) => console.log(`| ${label} | ${value} |`);

  console.log(`\n### ${result.name}\n`);
  console.log('| Medida | Valor |\n|---|---|');
  row('Wallets', result.wallets);
  row('Clientes simultâneos', concurrency);
  row('Duração', `${result.seconds.toFixed(1)} s`);
  row('Requisições', result.requests);
  row('Vazão', `${(result.requests / result.seconds).toFixed(0)} req/s`);
  row('Latência p50', `${percentile(l, 50).toFixed(1)} ms`);
  row('Latência p95', `${percentile(l, 95).toFixed(1)} ms`);
  row('Latência p99', `${percentile(l, 99).toFixed(1)} ms`);
  row('Latência máxima', `${(l.at(-1) ?? 0).toFixed(1)} ms`);
  row('Sucesso (200/202)', ok);
  row('Rejeição de negócio (422)', rejected);
  row('Falha transitória (503)', transient);
  row('Outros status / erro de rede', `${others} / ${result.networkErrors}`);
  row('Taxa de erro', `${((errors / Math.max(1, result.requests)) * 100).toFixed(3)} %`);
  row('Conflitos de lock (timeout)', result.lockConflicts);
  row('Corridas por índice único', result.duplicateKeyRaces);
  row('Outbox lag máximo', `${result.maxOutboxLagSeconds.toFixed(2)} s`);
  row('Outbox pendente máximo', result.maxOutboxPending);
  row('Tempo para a outbox esvaziar após a carga', `${result.drainSeconds.toFixed(1)} s`);
  row('Wallets inconsistentes na reconciliação', result.inconsistentWallets);
}

// ---------------------------------------------------------------------------

for (const url of baseUrls) {
  try {
    const response = await fetch(`${url}/health/ready`);
    if (!response.ok) throw new Error(String(response.status));
  } catch {
    console.error(`Instância ${url} não está pronta. Suba a pilha com: bun run docker:up`);
    process.exit(1);
  }
}

console.log(`Alvos: ${baseUrls.join(', ')}`);
const results: ScenarioResult[] = [];
if (scenarioArg === 'distributed' || scenarioArg === 'both') {
  // saldo alto: o cenário mede o caminho feliz, sem rejeição por saldo
  results.push(await runScenario('Carga distribuída', await openWallets(walletCount, '1000000.00')));
}
if (scenarioArg === 'hot' || scenarioArg === 'both') {
  // pior caso de disputa: todos os clientes na mesma wallet
  results.push(await runScenario('Wallet quente (1 wallet)', await openWallets(1, '1000000.00')));
}
for (const result of results) report(result);

if (results.some((result) => result.inconsistentWallets > 0)) {
  console.error('\nFALHA: há wallets com saldo diferente do ledger.');
  process.exit(1);
}
