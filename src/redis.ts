// The Redis client (node-redis). It connects only when REDIS_URL is set; otherwise the app runs
// without Redis (app.redis is null). Used from Step 2.3.

import { createClient } from 'redis';
import type { FastifyBaseLogger } from 'fastify';

const newClient = (url: string) => createClient({ url });
export type RedisClient = ReturnType<typeof newClient>;

export async function connectRedis(url: string | undefined, log: FastifyBaseLogger): Promise<RedisClient | null> {
  if (!url) return null;
  const client = newClient(url);
  client.on('error', (err: Error) => log.error({ err }, 'redis client error'));
  await client.connect();
  return client;
}
