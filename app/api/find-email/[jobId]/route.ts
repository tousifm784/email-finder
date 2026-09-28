import { NextResponse } from "next/server";
import { Job } from "bullmq";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verificationQueue, type FindEmailJob } from "@/lib/queue";
import type { VerificationResult, VerificationProgress } from "@/lib/smtp-verifier";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in to view this search." }, { status: 401 });
  const { jobId } = await params;
  const job = await Job.fromId<FindEmailJob, VerificationResult, VerificationProgress>(verificationQueue, jobId);
  if (!job || job.data.userId !== session.user.id) return NextResponse.json({ error: "Search job not found." }, { status: 404 });

  const state = await job.getState();
  const result = state === "completed" ? job.returnvalue : null;
  const error = state === "failed" ? job.failedReason : null;
  if (state === "completed" && result) {
    await prisma.search.updateMany({
      where: { id: job.data.searchId, userId: session.user.id },
      data: { discoveredEmail: result.email, status: result.status, confidence: result.confidence, pattern: result.pattern },
    });
  }
  return NextResponse.json({ jobId, state, progress: job.progress, result, error });
}