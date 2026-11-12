import type { Clock, IdGenerator } from '../application/ports.ts';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenável por tempo, bom para chave primária em B-tree. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
