import { NextRequest, NextResponse } from "next/server";
import { Job } from "bullmq";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verificationQueue, type FindEmailJob } from "@/lib/queue";
import type { VerificationResult, VerificationProgress } from "@/lib/smtp-verifier";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await getServerSession(authOptions);
  const { jobId } = await params;
  const job = await Job.fromId<FindEmailJob, VerificationResult, VerificationProgress>(verificationQueue, jobId);
  const userId = session?.user?.id;
  const guestSessionId = request.cookies.get("signal_guest_session")?.value;
  const ownsJob = job && (userId ? job.data.userId === userId : Boolean(guestSessionId && job.data.guestSessionId === guestSessionId));
  if (!job || !ownsJob) return NextResponse.json({ error: "Search job not found." }, { status: 404 });

  const state = await job.getState();
  const result = state === "completed" ? job.returnvalue : null;
  const error = state === "failed" ? job.failedReason : null;
  if (state === "completed" && result) {
    await prisma.search.updateMany({
      where: { id: job.data.searchId, ...(userId ? { userId } : { guestSessionId }) },
      data: { discoveredEmail: result.email, status: result.status, confidence: result.confidence, pattern: result.pattern },
    });
  }
  return NextResponse.json({ jobId, state, progress: job.progress, result, error });
}