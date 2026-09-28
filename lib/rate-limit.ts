import { redis } from "@/lib/queue";

export async function allowRateLimitedAction(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count <= limit;
}

export async function clearRateLimit(key: string): Promise<void> {
  await redis.del(key);
}