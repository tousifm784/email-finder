"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowUpRight, BadgeCheck, Building2, Check, ChevronDown, CircleAlert, Clock3, Copy, Fingerprint, Globe2, LoaderCircle, Mail, Search, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type { VerificationProgress, VerificationResult } from "@/lib/smtp-verifier";
import { Navbar } from "@/components/navbar";
import { SearchHistory } from "@/components/search-history";

type JobResponse = {
  jobId: string;
  state: "waiting" | "active" | "completed" | "failed" | string;
  progress: VerificationProgress | number | object;
  result: VerificationResult | null;
  error: string | null;
};

const phases: Array<{ id: VerificationProgress; label: string }> = [
  { id: "generating", label: "Generate patterns" },
  { id: "mx", label: "Resolve MX records" },
  { id: "smtp", label: "Probe mail server" },
  { id: "catch_all", label: "Evaluate catch-all" },
];

async function fetchJob(jobId: string): Promise<JobResponse> {
  const response = await fetch(`/api/find-email/${jobId}`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not read search status.");
  return body;
}

function statusLabel(status: VerificationResult["status"]): string {
  return ({ deliverable: "Deliverable", catch_all: "Catch-all", risky: "Risky", undeliverable: "Undeliverable", domain_invalid: "Domain invalid", pattern_prediction: "Pattern prediction" })[status];
}

export function FinderApp() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [conversionOpen, setConversionOpen] = useState(false);
  const account = useQuery({
    queryKey: ["account"],
    queryFn: async () => {
      const response = await fetch("/api/account", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load account");
      return response.json() as Promise<{ credits: number; creditLimit: number; isGuest?: boolean }>;
    },
  });

  const search = useMutation({
    mutationFn: async (input: { name: string; domain: string }) => {
      const response = await fetch("/api/find-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok) {
        const error = new Error(body.error || "Search could not be started.") as Error & { code?: string };
        error.code = body.code;
        throw error;
      }
      return body as { jobId: string };
    },
    onError: (error) => {
      if ((error as Error & { code?: string }).code === "GUEST_LIMIT") setConversionOpen(true);
    },
    onSuccess: ({ jobId: nextId }) => {
      setJobId(nextId);
      void queryClient.invalidateQueries({ queryKey: ["account"] });
      void queryClient.invalidateQueries({ queryKey: ["search-history"] });
    },
  });

  const job = useQuery({
    queryKey: ["email-search", jobId],
    queryFn: () => fetchJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "completed" || state === "failed" ? false : 900;
    },
  });

  const result = job.data?.result;
  const currentStep = phases.findIndex((phase) => phase.id === job.data?.progress);
  const busy = search.isPending || Boolean(jobId && job.data?.state !== "completed" && job.data?.state !== "failed");
  const registeredOutOfCredits = account.data?.credits === 0 && !account.data.isGuest;

  useEffect(() => {
    if (job.data?.state === "completed") {
      void queryClient.invalidateQueries({ queryKey: ["search-history"] });
      void queryClient.invalidateQueries({ queryKey: ["account"] });
    }
  }, [job.data?.state, queryClient]);

  useEffect(() => {
    if (!conversionOpen) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConversionOpen(false);
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [conversionOpen]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJobId(null);
    setCopiedEmail(null);
    search.mutate({ name, domain });
  }

  async function copyEmail(email: string) {
    await navigator.clipboard.writeText(email);
    setCopiedEmail(email);
    window.setTimeout(() => setCopiedEmail(null), 1800);
  }

  return (
    <main className="finder-page">
      <section className="main-column" id="home">
        <header className="topbar">
          <Navbar />
        </header>

        <div className="content-wrap" id="finder">
          <div className="eyebrow"><span className="eyebrow-line" /> B2B CONTACT INTELLIGENCE <span className="eyebrow-count">01 / 03</span></div>
          <div className="heading-row">
            <div><h1>Find the right<br /><em>way in.</em></h1><p className="intro-copy">Discover a professional email and understand the signals behind it.</p></div>
            <div className="heading-aside"><div className="shield-icon"><ShieldCheck size={20} /></div><span>Privacy-minded<br />verification</span></div>
          </div>

          <form className="search-panel" onSubmit={submit}>
            <div className="panel-heading"><div><span className="panel-kicker">NEW SEARCH</span><h2>Who are you looking for?</h2></div><span className="secure-label"><ShieldCheck size={13} /> Secure lookup</span></div>
            <div className="form-grid">
              <label className="field-wrap"><span className="field-label">FULL NAME</span><span className="input-shell"><input autoComplete="name" required minLength={3} maxLength={120} placeholder="e.g. Sarah Connor" value={name} onChange={(event) => setName(event.target.value)} /><Sparkles size={16} /></span><span className="field-hint">First and last name</span></label>
              <label className="field-wrap"><span className="field-label">COMPANY DOMAIN</span><span className="input-shell"><span className="domain-prefix">https://</span><input autoCapitalize="none" autoComplete="url" required type="text" inputMode="url" placeholder="cyberdyne.com" value={domain} onChange={(event) => setDomain(event.target.value)} /><Globe2 size={16} /></span><span className="field-hint">No company name? Use its website</span></label>
              <button className="submit-button" type="submit" disabled={busy || registeredOutOfCredits}><span>{registeredOutOfCredits ? "No credits left" : busy ? "Searching" : "Find email"}</span>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUpRight size={17} />}</button>
            </div>
            <div className="panel-foot"><span><Zap size={13} /> Queued, non-blocking verification</span><span><span className="keycap">Enter</span> to search</span></div>
          </form>

          {account.data?.credits === 0 && !account.data.isGuest && <section className="upgrade-inline"><div><strong>You're out of credits.</strong><span>Upgrade to keep searching.</span></div><button type="button" onClick={() => setUpgradeOpen(true)}>Upgrade plan <ArrowUpRight size={13} /></button></section>}

          {!conversionOpen && (search.error || job.error || job.data?.error) && <div className="error-banner"><CircleAlert size={17} />{search.error?.message || job.error?.message || job.data?.error}</div>}

          {jobId && !result && !job.data?.error && (
            <section className="progress-panel" aria-live="polite">
              <div className="progress-heading"><span className="progress-orbit"><LoaderCircle size={18} className="spin" /></span><div><span className="panel-kicker">LOOKUP IN PROGRESS</span><h2>Following the signal</h2></div><span className="elapsed"><Clock3 size={14} /> Live</span></div>
              <div className="stepper">{phases.map((phase, index) => {
                const done = currentStep > index || job.data?.progress === "complete";
                const active = currentStep === index && !done;
                return <div className={`step ${done ? "done" : ""} ${active ? "current" : ""}`} key={phase.id}><span className="step-mark">{done ? <Check size={13} /> : active ? <LoaderCircle size={13} className="spin" /> : `0${index + 1}`}</span><span>{phase.label}</span></div>;
              })}</div>
            </section>
          )}

          {result && (
            <section className="result-panel">
              <div className="result-topline"><span className="panel-kicker">VERIFICATION RESULT</span><span className={`status-pill ${result.status === "pattern_prediction" ? "risky" : result.status}`}><i />{statusLabel(result.status)}</span></div>
              {(result.badge || result.patternBadge) && <div className="result-badge-line">{result.badge && <span className={`status-pill ${result.badge.startsWith("Pattern Verified") ? "pattern_prediction" : result.badge.startsWith("Deliverable") ? "deliverable" : "risky"}`}>{result.badge}</span>}{result.patternBadge && <span className="status-pill pattern_prediction">{result.patternBadge}</span>}</div>}
              <div className="result-main">
                <div className="result-identity"><span className="result-icon"><Mail size={19} /></span><div><span className="result-label">MOST LIKELY ADDRESS</span><strong className={result.email ? "email-value" : "email-empty"}>{result.email || "No confirmed pattern"}</strong></div></div>
                {result.email && <button className="copy-button" type="button" onClick={() => void copyEmail(result.email!)} aria-label="Copy email address" title="Copy email address">{copiedEmail === result.email ? <Check size={16} /> : <Copy size={16} />}</button>}
              </div>
              {result.pattern && <div className="formula-line"><span>IDENTIFIED FORMULA</span><code>{result.pattern}</code></div>}
              <div className="result-metrics">
                <div className="score-block"><div className="score-heading"><span>CONFIDENCE</span><strong>{result.confidence}%</strong></div><div className="score-track"><span className={`score-fill ${result.status === "pattern_prediction" ? "risky" : result.status}`} style={{ width: `${result.confidence}%` }} /></div></div>
                <p className="result-message">{result.message}</p>
              </div>
              <button className="details-toggle" type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}><span>Verification details <span className="details-count">{result.predictions.length || result.probes.length} patterns</span></span><ChevronDown size={16} className={detailsOpen ? "rotate" : ""} /></button>
              {detailsOpen && <div className="details-content">
                <div className="detail-facts"><div><span>MAIL EXCHANGE</span><strong><Building2 size={14} />{result.mxHost || "Not resolved"}</strong></div><div><span>PROVIDER</span><strong>{result.provider}</strong></div><div><span>CATCH-ALL</span><strong className={result.catchAll ? "catch-value" : ""}>{result.catchAll === null ? "Unknown" : result.catchAll ? "Detected" : "Not detected"}</strong></div></div>
                <div className="dns-signals"><span>DNS POLICY</span><div><strong>SPF</strong><code>{result.spf || "No SPF TXT record found"}</code></div><div><strong>DMARC</strong><code>{result.dmarc || "No DMARC TXT record found"}</code></div></div>
                {result.predictions.length > 0 && <div className="probe-table"><div className="probe-head"><span>RANKED PATTERNS</span><span>NO. {result.predictions.length}</span></div>{result.predictions.map((email, index) => <div className="probe-row" key={email}><span>{String(index + 1).padStart(2, "0")} &nbsp; {email}</span><span className="prediction-status">{result.predictionStatuses?.[index] || "Predicted"}</span><button className="copy-button" type="button" onClick={() => void copyEmail(email)} aria-label={`Copy ${email}`} title={`Copy ${email}`}>{copiedEmail === email ? <Check size={15} /> : <Copy size={15} />}</button></div>)}</div>}
                {result.observedEmails.length > 0 && <div className="observed-evidence"><span>PUBLIC MATCHES</span><div>{result.observedEmails.map((email) => <code key={email}>{email}</code>)}</div></div>}
                {result.probes.length > 0 && <div className="probe-table"><div className="probe-head"><span>EMAIL PATTERN</span><span>SMTP RESPONSE</span></div>{result.probes.map((probe) => <div className="probe-row" key={probe.email}><span>{probe.email}</span><span className={`probe-code ${probe.status === "deliverable" ? "accepted" : probe.status === "invalid" ? "rejected" : "pending"}`}>{probe.code ?? "—"} · {probe.status || "unknown"}</span></div>)}</div>}
                <div className="verification-foot"><BadgeCheck size={14} /> No message was sent during this verification.</div>
              </div>}
            </section>
          )}

          {account.data && !account.data.isGuest && <SearchHistory limit={5} />}

          {!jobId && <div className="empty-state"><div className="empty-illustration"><span className="empty-ring ring-one" /><span className="empty-ring ring-two" /><span className="empty-center"><Mail size={19} /></span><span className="empty-spark spark-one">✳</span><span className="empty-spark spark-two">✳</span></div><h3>Every good introduction starts somewhere.</h3><p>Enter a name and company domain to uncover likely email patterns.</p></div>}

          <footer className="page-footer"><span>Signals, not guarantees. Mail server policies can change.</span><span>Built for thoughtful outreach <span className="footer-star">✳</span></span></footer>
        </div>
      </section>
      {upgradeOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUpgradeOpen(false); }}><section className="upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-title"><span className="panel-kicker">CREDITS EXHAUSTED</span><h2 id="upgrade-title">Upgrade plans are not available yet.</h2><p>Your 50 included searches have been used. Billing and paid credit packs are not configured in this deployment.</p><button className="submit-button" type="button" onClick={() => setUpgradeOpen(false)}>Close</button></section></div>}
      {conversionOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConversionOpen(false); }}><section className="upgrade-modal conversion-modal" role="dialog" aria-modal="true" aria-labelledby="conversion-title"><span className="panel-kicker">FREE TRIAL COMPLETE</span><h2 id="conversion-title">You've used all 10 free searches!</h2><p>Create a free account to unlock 50 additional credits, full deliverability breakdowns, and search history.</p><div className="conversion-actions"><Link autoFocus className="submit-button" href="/signup">Create Free Account (+50 Credits) <ArrowUpRight size={16} /></Link><Link className="conversion-login" href="/login">Log In</Link></div></section></div>}
    </main>
  );
}