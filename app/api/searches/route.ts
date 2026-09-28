import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limitParam = Number(new URL(request.url).searchParams.get("limit") || 5);
  const take = Math.min(Math.max(Number.isInteger(limitParam) ? limitParam : 5, 1), 50);
  const searches = await prisma.search.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, targetName: true, domain: true, discoveredEmail: true, status: true, confidence: true, pattern: true, createdAt: true },
  });
  return NextResponse.json({ searches });
}