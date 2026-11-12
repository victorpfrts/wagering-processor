function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

export const config = {
  port: Number(required('PORT', '3000')),
  databaseUrl: required('DATABASE_URL', 'postgres://wagering:wagering@localhost:5433/wagering'),
  sqs: {
    endpoint: required('SQS_ENDPOINT', 'http://localhost:4566'),
    region: required('AWS_REGION', 'us-east-1'),
    transactionsQueue: required('SQS_TRANSACTIONS_QUEUE', 'wager-transactions.fifo'),
    dlqQueue: required('SQS_DLQ_QUEUE', 'wager-transactions-dlq.fifo'),
    eventsQueue: required('SQS_EVENTS_QUEUE', 'wager-events.fifo'),
  },
} as const;
