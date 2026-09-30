import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    const guestSessionId = request.cookies.get("signal_guest_session")?.value;
    const guest = guestSessionId && /^[a-f0-9]{64}$/.test(guestSessionId)
      ? await prisma.guestSession.findUnique({ where: { id: guestSessionId }, select: { searchesUsed: true } })
      : null;
    return NextResponse.json({ credits: Math.max(0, 10 - (guest?.searchesUsed ?? 0)), creditLimit: 10, isGuest: true });
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true, credits: true, createdAt: true },
  });
  if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  return NextResponse.json({ ...user, creditLimit: 50, isGuest: false });
}