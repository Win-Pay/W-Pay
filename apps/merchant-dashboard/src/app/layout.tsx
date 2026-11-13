import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "@wpay/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "W-Pay Merchant",
  description: "Merchant operations: payments, invoices, refunds and analytics.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers keeps the route dynamic so Next can stamp the
  // per-request CSP nonce onto its own script tags.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
