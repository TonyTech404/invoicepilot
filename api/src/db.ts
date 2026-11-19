import postgres from 'postgres';
import { env } from './env.js';

let client: postgres.Sql | undefined;

/**
 * One pool per Functions host. Neon's pooled endpoint sits behind PgBouncer,
 * so prepared statements are off.
 */
export function db(): postgres.Sql {
  client ??= postgres(env.databaseUrl, {
    max: 5,
    idle_timeout: 20,
    prepare: false,
    onnotice: () => {},
    types: {
      // numeric(12,2) -> number. Amounts here stay well inside double precision.
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
      // date -> 'YYYY-MM-DD' string, never a Date shifted by time zone.
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
  });
  return client;
}

export type Sql = postgres.Sql | postgres.TransactionSql;
