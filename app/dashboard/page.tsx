import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { SearchHistory } from "@/components/search-history";
import { Navbar } from "@/components/navbar";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true, credits: true, createdAt: true } });
  if (!user) redirect("/login");

  return <main className="saas-page"><Navbar /><div className="saas-content"><div className="dashboard-heading"><div><span className="eyebrow"><span className="eyebrow-line" />ACCOUNT OVERVIEW</span><h1>Good to have you,<br /><em>{user.name?.split(" ")[0] || "researcher"}.</em></h1></div><a className="submit-button dashboard-cta" href="/">Find an email <span>↗</span></a></div><section className="account-stats"><article><span>SEARCH CREDITS</span><strong>{user.credits}<small> / 25</small></strong><p>Available for email lookups</p></article><article><span>MEMBER SINCE</span><strong>{user.createdAt.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</strong><p>{user.email}</p></article><article><span>ACCOUNT SETTINGS</span><strong>{user.name || "Your account"}</strong><p>Signed in with {user.email}</p></article></section><SearchHistory limit={5} /><section className="upgrade-banner"><div><span className="panel-kicker">NEED MORE CAPACITY?</span><h2>Keep your research moving.</h2><p>Plan upgrades are not enabled yet. Your included 25 lookups remain available.</p></div><span className="upgrade-count">{user.credits}<small>credits left</small></span></section></div></main>;
}