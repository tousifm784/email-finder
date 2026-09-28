import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { Navbar } from "@/components/navbar";
import { SearchHistory } from "@/components/search-history";
import { authOptions } from "@/lib/auth";

export default async function HistoryPage() {
  if (!await getServerSession(authOptions)) redirect("/login");
  return <main className="saas-page"><Navbar /><div className="saas-content"><div className="simple-page-heading"><span className="eyebrow"><span className="eyebrow-line" />YOUR WORKSPACE</span><h1>Search <em>history.</em></h1><p>Recent lookups and their verification signals.</p></div><SearchHistory limit={50} /></div></main>;
}