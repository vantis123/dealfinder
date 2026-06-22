import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DealFinder — Foreclosure Leads",
  description: "Foreclosure door-knock lead finder",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
