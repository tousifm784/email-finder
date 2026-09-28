import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { normalizeDomain } from "@/lib/domain";
import { parseName } from "@/lib/permutations";
import { redis, verificationQueue } from "@/lib/queue";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const requestSchema = z.object({
  name: z.string().trim().min(3).max(120),
  domain: z.string().trim().min(3).max(253),
});

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in to use email finder." }, { status: 401 });

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
    const { first, last } = parseName(body.name);
    body.name = `${first} ${last}`;
    body.domain = normalizeDomain(body.domain);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid search request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const rateKey = `find-email:rate:${session.user.id}`;
  try {
    const count = await redis.incr(rateKey);
    if (count === 1) await redis.expire(rateKey, 60);
    if (count > 8) return NextResponse.json({ error: "Search limit reached. Try again in a minute." }, { status: 429 });
    const search = await prisma.$transaction(async (transaction) => {
      const charged = await transaction.user.updateMany({
        where: { id: session.user.id, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });
      if (charged.count === 0) return null;
      const row = await transaction.search.create({
        data: { userId: session.user.id, targetName: body.name, domain: body.domain, status: "queued" },
      });
      await transaction.creditEvent.create({
        data: { userId: session.user.id, delta: -1, reason: "email_search", searchId: row.id },
      });
      return row;
    });
    if (!search) return NextResponse.json({ error: "No search credits remain.", code: "NO_CREDITS" }, { status: 402 });

    let job: Awaited<ReturnType<typeof verificationQueue.add>> | undefined;
    try {
      job = await verificationQueue.add("find-email", { name: body.name, domain: body.domain, userId: session.user.id, searchId: search.id });
      await prisma.search.update({ where: { id: search.id }, data: { jobId: job.id } });
    } catch (error) {
      await job?.remove().catch(() => undefined);
      await prisma.$transaction([
        prisma.search.delete({ where: { id: search.id } }),
        prisma.creditEvent.deleteMany({ where: { searchId: search.id } }),
        prisma.user.update({ where: { id: session.user.id }, data: { credits: { increment: 1 } } }),
      ]);
      throw error;
    }
    return NextResponse.json({ jobId: job.id }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "Search service is temporarily unavailable." }, { status: 503 });
  }
}