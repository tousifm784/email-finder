"use client";

import { useEffect, useState } from "react";
import { getProviders, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Github, LoaderCircle, Mail, ShieldCheck } from "lucide-react";

type Provider = { id: string; name: string };

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [providers, setProviders] = useState<Record<string, Provider> | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void getProviders().then((value) => setProviders(value as Record<string, Provider> | null)); }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") {
        const response = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, email, password }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not create your account.");
      }
      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) throw new Error(mode === "signup" ? "Account created, but sign-in failed. Please log in." : "Email or password is incorrect.");
      router.push("/dashboard");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function socialSignIn(provider: string) {
    setBusy(true);
    await signIn(provider, { callbackUrl: "/dashboard" });
  }

  const socialProviders = Object.values(providers ?? {}).filter((provider) => ["google", "github"].includes(provider.id));

  return (
    <main className="auth-page">
      <Link className="auth-back" href="/"><ArrowLeft size={15} /> Signal</Link>
      <section className="auth-frame">
        <div className="auth-aside"><div className="auth-mark"><ShieldCheck size={24} /></div><span className="auth-overline">SIGNAL / CONTACT INTELLIGENCE</span><h1>Find the signal<br /><em>in every inbox.</em></h1><p>Turn company email patterns into a more confident first introduction.</p><div className="auth-aside-foot">Pattern evidence is not a delivery guarantee.</div></div>
        <div className="auth-form-side">
          <div className="auth-mobile-brand"><span className="brand-mark"><ShieldCheck size={18} /></span> signal.</div>
          <span className="panel-kicker">{mode === "signup" ? "START YOUR WORKSPACE" : "WELCOME BACK"}</span>
          <h2>{mode === "signup" ? "Create your account" : "Sign in to Signal"}</h2>
          <p className="auth-description">{mode === "signup" ? "Get 50 email lookups on us." : "Pick up where your research left off."}</p>
          {socialProviders.length > 0 && <>
            <div className="social-buttons">{socialProviders.map((provider) => <button className="social-button" key={provider.id} type="button" disabled={busy} onClick={() => void socialSignIn(provider.id)}>{provider.id === "github" ? <Github size={16} /> : <span className="google-g">G</span>} Continue with {provider.name}</button>)}</div>
            <div className="auth-divider"><span />or continue with email<span /></div>
          </>}
          <form className="auth-fields" onSubmit={submit}>
            {mode === "signup" && <label className="field-wrap"><span className="field-label">YOUR NAME</span><span className="input-shell"><input autoComplete="name" required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex Morgan" /></span></label>}
            <label className="field-wrap"><span className="field-label">EMAIL ADDRESS</span><span className="input-shell"><input autoComplete="email" type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></span></label>
            <label className="field-wrap"><span className="field-label">PASSWORD</span><span className="input-shell"><input autoComplete={mode === "signup" ? "new-password" : "current-password"} type="password" required minLength={mode === "signup" ? 8 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "signup" ? "8+ characters" : "Your password"} /></span>{mode === "signup" && <span className="field-hint">8+ characters, including uppercase, lowercase and a number</span>}</label>
            {error && <div className="error-banner">{error}</div>}
            <button className="submit-button auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : mode === "signup" ? <><span>Create account</span><ArrowRight size={16} /></> : <><span>Sign in</span><ArrowRight size={16} /></>}</button>
          </form>
          {mode === "login" && <p className="auth-switch"><Link href="/forgot-password">Forgot your password?</Link></p>}
          <p className="auth-switch">{mode === "signup" ? "Already have an account?" : "New to Signal?"} <Link href={mode === "signup" ? "/login" : "/signup"}>{mode === "signup" ? "Log in" : "Create an account"}</Link></p>
          <div className="auth-terms"><ShieldCheck size={13} /> Passwords are hashed. Use HTTPS for account sessions.</div>
        </div>
      </section>
      <div className="auth-bottom"><span>Signal Email Finder</span><span><Mail size={12} /> Contact intelligence, thoughtfully.</span></div>
    </main>
  );
}