import type { Metadata } from "next";
import "./globals.css";
import "./saas.css";
import "./account.css";
import { QueryProvider } from "@/components/query-provider";

export const metadata: Metadata = {
  title: "Signal | Email finder",
  description: "Find and assess business email patterns with transparent verification signals.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}