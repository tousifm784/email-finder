"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Check, Copy, History, LoaderCircle } from "lucide-react";
import { useState } from "react";

export type SearchRow = {
  id: string;
  targetName: string;
  domain: string;
  discoveredEmail: string | null;
  status: string;
  confidence: number;
  pattern: string | null;
  createdAt: string;
};

export function SearchHistory({ limit = 5 }: { limit?: number }) {
  const [copied, setCopied] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["search-history", limit],
    queryFn: async (): Promise<SearchRow[]> => {
      const response = await fetch(`/api/searches?limit=${limit}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load search history.");
      return (await response.json()).searches;
    },
  });

  async function copy(email: string) {
    await navigator.clipboard.writeText(email);
    setCopied(email);
    window.setTimeout(() => setCopied(null), 1600);
  }

  return (
    <section className="history-panel">
      <div className="history-heading"><div><span className="panel-kicker">YOUR RESEARCH</span><h2><History size={17} />Recent searches</h2></div><Link href="/history">View all <span>→</span></Link></div>
      {query.isLoading ? <div className="history-loading"><LoaderCircle size={16} className="spin" />Loading searches</div> : query.data?.length ? <div className="history-table-wrap"><table className="history-table"><thead><tr><th>CONTACT</th><th>DOMAIN</th><th>EMAIL</th><th>STATUS</th><th>SCORE</th><th>DATE</th><th /></tr></thead><tbody>{query.data.map((row) => <tr key={row.id}><td>{row.targetName}</td><td>{row.domain}</td><td>{row.discoveredEmail || "—"}</td><td><span className={`history-status ${row.status}`}>{row.status.replaceAll("_", " ")}</span></td><td>{row.confidence ? `${row.confidence}%` : "—"}</td><td>{new Date(row.createdAt).toLocaleDateString()}</td><td>{row.discoveredEmail && <button className="table-copy" type="button" onClick={() => void copy(row.discoveredEmail!)} aria-label="Copy email" title="Copy email">{copied === row.discoveredEmail ? <Check size={14} /> : <Copy size={14} />}</button>}</td></tr>)}</tbody></table></div> : <p className="history-empty">Your completed lookups will appear here.</p>}
    </section>
  );
}