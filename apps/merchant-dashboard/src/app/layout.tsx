import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@wpay/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "W-Pay Merchant",
  description: "Merchant operations: payments, invoices, refunds and analytics.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
