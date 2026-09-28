import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { AuthForm } from "@/components/auth-form";
import { authOptions } from "@/lib/auth";

export default async function LoginPage() {
  if (await getServerSession(authOptions)) redirect("/dashboard");
  return <AuthForm mode="login" />;
}