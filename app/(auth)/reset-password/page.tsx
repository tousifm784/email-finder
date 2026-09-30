import { PasswordRecoveryForm } from "@/components/password-recovery-form";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <PasswordRecoveryForm mode="reset" token={token} />;
}