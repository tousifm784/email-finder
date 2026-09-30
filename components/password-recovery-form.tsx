"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";

type RecoveryMode = "forgot" | "reset";

export function PasswordRecoveryForm({ mode, token = "" }: { mode: RecoveryMode; token?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (mode === "reset" && password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode === "forgot" ? "forgot-password" : "reset-password"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "forgot" ? { email } : { token, password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not complete your request.");
      setMessage(body.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const isForgot = mode === "forgot";
  const invalidToken = !isForgot && token.length === 0;

  return (
    <main className="auth-page">
      <Link className="auth-back" href="/"><ArrowLeft size={15} /> Signal</Link>
      <section className="auth-frame">
        <div className="auth-aside"><div className="auth-mark"><ShieldCheck size={24} /></div><span className="auth-overline">SIGNAL / CONTACT INTELLIGENCE</span><h1>Find the signal<br /><em>in every inbox.</em></h1><p>Turn company email patterns into a more confident first introduction.</p><div className="auth-aside-foot">Pattern evidence is not a delivery guarantee.</div></div>
        <div className="auth-form-side">
          <div className="auth-mobile-brand"><span className="brand-mark"><ShieldCheck size={18} /></span> signal.</div>
          <span className="panel-kicker">ACCOUNT RECOVERY</span>
          <h2>{isForgot ? "Reset your password" : "Choose a new password"}</h2>
          <p className="auth-description">{isForgot ? "Enter your account email and we’ll send a secure reset link." : "Your reset link is valid for one hour."}</p>
          {invalidToken ? <div className="error-banner">This reset link is missing or invalid. Request a new one to continue.</div> : (
            <form className="auth-fields" onSubmit={submit}>
              {isForgot ? (
                <label className="field-wrap"><span className="field-label">EMAIL ADDRESS</span><span className="input-shell"><input autoComplete="email" type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></span></label>
              ) : <>
                <label className="field-wrap"><span className="field-label">NEW PASSWORD</span><span className="input-shell"><input autoComplete="new-password" type="password" required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="8+ characters" /></span><span className="field-hint">8+ characters, including uppercase, lowercase and a number</span></label>
                <label className="field-wrap"><span className="field-label">CONFIRM PASSWORD</span><span className="input-shell"><input autoComplete="new-password" type="password" required minLength={8} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Enter it again" /></span></label>
              </>}
              {error && <div className="error-banner">{error}</div>}
              {message && <div className="auth-description" role="status">{message}</div>}
              <button className="submit-button auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <><span>{isForgot ? "Send reset link" : "Update password"}</span><ArrowRight size={16} /></>}</button>
            </form>
          )}
          {!invalidToken && message && !isForgot ? <p className="auth-switch"><Link href="/login">Continue to sign in</Link></p> : <p className="auth-switch"><Link href="/login">Back to sign in</Link></p>}
        </div>
      </section>
      <div className="auth-bottom"><span>Signal Email Finder</span><span>Secure account recovery</span></div>
    </main>
  );
}