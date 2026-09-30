import { createHash } from "node:crypto";
import { hash } from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const requestSchema = z.object({ token: z.string().min(1).max(128), password: z.string().min(8).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/) });

export async function POST(request: Request) {
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Use a valid reset link and an 8+ character password with uppercase, lowercase, and a number." }, { status: 400 });
  }

  const token = createHash("sha256").update(input.token).digest("hex");
  const now = new Date();
  try {
    const resetRecord = await prisma.verificationToken.findUnique({ where: { token } });
    if (!resetRecord || resetRecord.expires <= now) {
      return NextResponse.json({ error: "This reset link is invalid or expired. Request a new one." }, { status: 400 });
    }

    const passwordHash = await hash(input.password, 12);
    await prisma.$transaction(async (transaction) => {
      const consumed = await transaction.verificationToken.deleteMany({ where: { token, expires: { gt: now } } });
      if (consumed.count !== 1) throw new Error("RESET_TOKEN_ALREADY_USED");
      await transaction.user.update({ where: { email: resetRecord.identifier }, data: { passwordHash } });
      await transaction.verificationToken.deleteMany({ where: { identifier: resetRecord.identifier } });
    });

    return NextResponse.json({ message: "Your password has been updated. You can now sign in." });
  } catch (error) {
    if (error instanceof Error && error.message === "RESET_TOKEN_ALREADY_USED") {
      return NextResponse.json({ error: "This reset link is invalid or expired. Request a new one." }, { status: 400 });
    }
    return NextResponse.json({ error: "Password reset is temporarily unavailable." }, { status: 503 });
  }
}