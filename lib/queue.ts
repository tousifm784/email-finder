import { Queue } from "bullmq";
import Redis from "ioredis";

export type FindEmailJob = { name: string; domain: string; userId: string; searchId: string };

export const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  enableOfflineQueue: false,
  enableReadyCheck: true,
});
redis.on("error", () => undefined);

export const verificationQueue = new Queue<FindEmailJob>("email-verification", {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 250 },
    removeOnFail: { count: 250 },
  },
});