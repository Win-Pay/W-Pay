import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@wpay/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "W-Pay Admin",
  description: "Platform administration, merchant onboarding and incident controls.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
