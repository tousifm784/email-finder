import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { allowRateLimitedAction } from "@/lib/rate-limit";

export const runtime = "nodejs";

const requestSchema = z.object({ email: z.string().trim().email().max(254) });
const responseMessage = "If an account exists for that email, password reset instructions will be sent.";

export async function POST(request: Request) {
  let email: string;
  try {
    email = requestSchema.parse(await request.json()).email.toLowerCase();
  } catch {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (process.env.NODE_ENV === "production" && !apiKey) {
    return NextResponse.json({ error: "Password recovery is temporarily unavailable." }, { status: 503 });
  }

  try {
    const ip = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!await allowRateLimitedAction(`auth:forgot-password:${ip}`, 5, 900)) {
      return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    }

    try {
      const user = await prisma.user.findUnique({ where: { email }, select: { email: true } });
      if (user?.email) {
        const rawToken = randomBytes(32).toString("hex");
        const token = createHash("sha256").update(rawToken).digest("hex");
        const expires = new Date(Date.now() + 60 * 60 * 1000);
        await prisma.$transaction([
          prisma.verificationToken.deleteMany({ where: { identifier: email } }),
          prisma.verificationToken.create({ data: { identifier: email, token, expires } }),
        ]);

        const baseUrl = process.env.NEXTAUTH_URL || new URL(request.url).origin;
        const resetUrl = `${baseUrl.replace(/\/$/, "")}/reset-password?token=${rawToken}`;
        if (apiKey) {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              from: process.env.RESEND_FROM_EMAIL || "Signal <onboarding@resend.dev>",
              to: [email],
              subject: "Reset your Signal password",
              text: `Use this link within one hour to reset your Signal password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
            }),
          });
          if (!response.ok) throw new Error("Password reset email delivery failed.");
        } else {
          console.info(`Password reset link for ${email}: ${resetUrl}`);
        }
      }
    } catch (error) {
      console.error("Password recovery request failed.", error);
    }

    return NextResponse.json({ message: responseMessage });
  } catch {
    return NextResponse.json({ error: "Password recovery is temporarily unavailable." }, { status: 503 });
  }
}