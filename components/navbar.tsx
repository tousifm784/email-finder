"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, Clock3, LogOut, Search, Settings2, UserRound } from "lucide-react";
import { useState } from "react";

type Account = { name: string | null; email: string | null; credits: number; creditLimit: number };

export function Navbar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const account = useQuery({
    queryKey: ["account"],
    queryFn: async (): Promise<Account> => {
      const response = await fetch("/api/account", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load account");
      return response.json();
    },
    enabled: Boolean(session?.user),
  });

  return (
    <header className="product-navbar">
      <Link className="brand" href="/dashboard"><span className="brand-mark"><UserRound size={19} /></span><span>signal<span className="brand-dot">.</span></span></Link>
      <nav className="product-links" aria-label="Product navigation">
        <Link className={pathname === "/" ? "selected" : ""} href="/"><Search size={15} />Email Finder</Link>
        <Link className={pathname === "/dashboard" || pathname === "/history" ? "selected" : ""} href="/history"><Clock3 size={15} />History</Link>
        <Link className={pathname === "/api-docs" ? "selected" : ""} href="/api-docs"><BookOpen size={15} />API Docs</Link>
      </nav>
      <div className="navbar-actions">
        <div className="credit-badge"><span className="credit-dot" />Credits Remaining <strong>{account.data?.credits ?? "-"}/{account.data?.creditLimit ?? 25}</strong></div>
        <div className="profile-wrap">
          <button className="profile-button" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><span className="profile-avatar">{(session?.user?.name || session?.user?.email || "U").slice(0, 1).toUpperCase()}</span><span className="profile-name">{session?.user?.name || session?.user?.email || "Account"}</span><ChevronDown size={14} /></button>
          {menuOpen && <div className="profile-menu"><Link href="/dashboard" onClick={() => setMenuOpen(false)}><Settings2 size={15} />Settings</Link><button type="button" onClick={() => void signOut({ callbackUrl: "/login" })}><LogOut size={15} />Log out</button></div>}
        </div>
      </div>
    </header>
  );
}