import { hash } from "bcryptjs";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { allowRateLimitedAction } from "@/lib/rate-limit";

export const runtime = "nodejs";

const signupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
});

export async function POST(request: Request) {
  let input: z.infer<typeof signupSchema>;
  try {
    input = signupSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Use a valid name and email, and an 8+ character password with uppercase, lowercase, and a number." }, { status: 400 });
  }

  const email = input.email.toLowerCase();
  try {
    const ip = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!await allowRateLimitedAction(`auth:signup:${ip}`, 5, 900)) {
      return NextResponse.json({ error: "Too many sign-up attempts. Try again later." }, { status: 429 });
    }
    const exists = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (exists) return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });

    const passwordHash = await hash(input.password, 12);
    const user = await prisma.$transaction(async (transaction) => {
      const created = await transaction.user.create({ data: { name: input.name, email, passwordHash, credits: 50 } });
      await transaction.creditEvent.create({ data: { userId: created.id, delta: 50, reason: "signup_grant" } });
      return created;
    });
    return NextResponse.json({ userId: user.id }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    return NextResponse.json({ error: "Account registration is temporarily unavailable." }, { status: 503 });
  }
}