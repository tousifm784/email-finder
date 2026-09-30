import "dotenv/config";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { generatePermutations } from "@/lib/permutations";
import { prisma } from "@/lib/prisma";
import { verifyWithProvider } from "@/lib/provider-adapter";
import { verifyDomainAndCandidates, type VerificationProgress, type VerificationResult } from "@/lib/smtp-verifier";
import type { FindEmailJob } from "@/lib/queue";

const connection = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});

const worker = new Worker<FindEmailJob, VerificationResult, VerificationProgress>(
  "email-verification",
  async (job) => {
    try {
      let result: VerificationResult;
      if (job.data.knownPattern) {
        const known = job.data.knownPattern;
        const candidatePatterns = generatePermutations(job.data.name, job.data.domain);
        const predictions = [...new Set([known.email, ...known.alternates, ...candidatePatterns])];
        const knownCount = 1 + known.alternates.length;
        const executiveRecord = known.source === "executive-record";
        result = {
          status: "pattern_prediction",
          email: known.email,
          confidence: known.confidence,
          domain: job.data.domain,
          mxHost: null,
          provider: "Company intelligence",
          catchAll: null,
          badge: executiveRecord ? "Verified Executive Record" : `Verified Company Formula (${known.confidence}%)`,
          patternBadge: null,
          predictions,
          predictionStatuses: predictions.map((_email, index) => index < knownCount ? (executiveRecord ? "executive record" : "company formula") : "predicted"),
          pattern: known.formula,
          observedEmails: [],
          message: executiveRecord
            ? "Matched a curated executive directory record. This is a documented address, not a live SMTP confirmation."
            : `Matched the curated ${known.formula} company formula. The address is not live SMTP-confirmed.`,
          checkedAt: new Date().toISOString(),
          probes: [],
        };
      } else {
        result = await verifyDomainAndCandidates(job.data.name, job.data.domain, (phase) => job.updateProgress(phase));
        if (result.status === "risky" && result.mxHost) {
          const candidates = generatePermutations(job.data.name, job.data.domain);
          const providerResult = await verifyWithProvider(result, candidates);
          if (providerResult) result = providerResult;
        }
      }
      await job.updateProgress("complete");
      await prisma.search.update({
        where: { id: job.data.searchId },
        data: { discoveredEmail: result.email, status: result.status, confidence: result.confidence, pattern: result.pattern },
      });
      return result;
    } catch (error) {
      await prisma.search.updateMany({ where: { id: job.data.searchId }, data: { status: "failed" } });
      throw error;
    }
  },
  { connection, concurrency: 1, limiter: { max: 10, duration: 60_000 } },
);

worker.on("completed", (job) => console.info(`Verification ${job.id} completed.`));
worker.on("failed", (job, error) => console.error(`Verification ${job?.id ?? "unknown"} failed:`, error.message));

async function shutdown(): Promise<void> {
  await worker.close();
  await connection.quit();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());