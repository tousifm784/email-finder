import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { normalizeDomain } from "@/lib/domain";
import { parseName } from "@/lib/permutations";
import { discoverKnownPattern } from "@/lib/pattern-discovery";
import { redis, verificationQueue } from "@/lib/queue";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const requestSchema = z.object({
  name: z.string().trim().min(3).max(120),
  domain: z.string().trim().min(3).max(253),
});

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  let guestSessionId = request.cookies.get("signal_guest_session")?.value;
  if (!guestSessionId || !/^[a-f0-9]{64}$/.test(guestSessionId)) guestSessionId = randomBytes(32).toString("hex");

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

  const ownerId = session?.user?.id;
  const rateKey = `find-email:rate:${ownerId ?? guestSessionId}`;
  try {
    const count = await redis.incr(rateKey);
    if (count === 1) await redis.expire(rateKey, 60);
    if (count > (ownerId ? 8 : 12)) return NextResponse.json({ error: "Search limit reached. Try again in a minute." }, { status: 429 });
    const search = await prisma.$transaction(async (transaction) => {
      if (ownerId) {
        const charged = await transaction.user.updateMany({
          where: { id: ownerId, credits: { gt: 0 } },
          data: { credits: { decrement: 1 } },
        });
        if (charged.count === 0) return null;
      } else {
        await transaction.guestSession.upsert({ where: { id: guestSessionId }, create: { id: guestSessionId }, update: {} });
        const charged = await transaction.guestSession.updateMany({
          where: { id: guestSessionId, searchesUsed: { lt: 10 } },
          data: { searchesUsed: { increment: 1 } },
        });
        if (charged.count === 0) return null;
      }
      const row = await transaction.search.create({
        data: { userId: ownerId, guestSessionId: ownerId ? null : guestSessionId, targetName: body.name, domain: body.domain, status: "queued" },
      });
      if (ownerId) await transaction.creditEvent.create({ data: { userId: ownerId, delta: -1, reason: "email_search", searchId: row.id } });
      return row;
    });
    if (!search) {
      const response = NextResponse.json({ error: ownerId ? "No search credits remain." : "You've used all 10 free searches!", code: ownerId ? "NO_CREDITS" : "GUEST_LIMIT" }, { status: 402 });
      if (!ownerId) response.cookies.set("signal_guest_session", guestSessionId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
      return response;
    }

    let job: Awaited<ReturnType<typeof verificationQueue.add>> | undefined;
    try {
      job = await verificationQueue.add("find-email", {
        name: body.name,
        domain: body.domain,
        userId: ownerId,
        guestSessionId: ownerId ? undefined : guestSessionId,
        searchId: search.id,
        knownPattern: discoverKnownPattern(body.name, body.domain) ?? undefined,
      });
      await prisma.search.update({ where: { id: search.id }, data: { jobId: job.id } });
    } catch (error) {
      await job?.remove().catch(() => undefined);
      await prisma.$transaction(async (transaction) => {
        await transaction.search.delete({ where: { id: search.id } });
        await transaction.creditEvent.deleteMany({ where: { searchId: search.id } });
        if (ownerId) {
          await transaction.user.update({ where: { id: ownerId }, data: { credits: { increment: 1 } } });
        } else {
          await transaction.guestSession.update({ where: { id: guestSessionId }, data: { searchesUsed: { decrement: 1 } } });
        }
      });
      throw error;
    }
    const response = NextResponse.json({ jobId: job.id }, { status: 202 });
    if (!ownerId) response.cookies.set("signal_guest_session", guestSessionId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
    return response;
  } catch {
    return NextResponse.json({ error: "Search service is temporarily unavailable." }, { status: 503 });
  }
}