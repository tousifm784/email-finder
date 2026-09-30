import "dotenv/config";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { discoverDomainPattern } from "@/lib/pattern-discovery";
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
      if (["risky", "pattern_prediction", "catch_all"].includes(result.status) && result.mxHost) {
        const candidates = generatePermutations(job.data.name, job.data.domain);
        const fallbackResult = await verifyWithProvider(result, candidates);
        if (fallbackResult && ["deliverable", "undeliverable"].includes(fallbackResult.status)) result = fallbackResult;
        else {
          const discoveryBase = fallbackResult?.status === "catch_all" ? fallbackResult : result;
          const discovery = await discoverDomainPattern(job.data.name, job.data.domain, discoveryBase.provider);
          const predictions = [discovery.email, ...candidates.filter((email) => email !== discovery.email)];
          const onlineMatch = discovery.confidenceLabel === "high";
          result = {
            ...discoveryBase,
            email: discovery.email,
            confidence: discovery.confidence,
            badge: onlineMatch && discoveryBase.status !== "catch_all" ? "Pattern Verified (Online Match)" : discoveryBase.status === "catch_all" ? discoveryBase.badge : `Pattern Estimated (${discovery.confidence}%)`,
            patternBadge: onlineMatch && discoveryBase.status === "catch_all" ? "Pattern Verified (Online Match)" : null,
            predictions,
            predictionStatuses: predictions.map(() => "predicted"),
            pattern: discovery.formula,
            observedEmails: discovery.observedEmails,
            message: onlineMatch
              ? `Found ${discovery.observedEmails.length} public ${discovery.pattern} addresses at this domain. This is pattern evidence, not mailbox verification.`
              : `No matching public email pattern was found. ${discovery.pattern} is an MX-provider estimate, not a verified mailbox.`,
          };
        }
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