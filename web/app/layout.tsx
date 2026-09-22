import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ForgeAI — Autonomous WCAG Remediation",
  description:
    "AI-powered accessibility remediation pipeline that scans, classifies, fixes, reviews, and deploys WCAG improvements automatically.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <nav className="site-nav">
          <div className="site-nav__inner">
            <Link href="/" className="site-nav__logo">
              ForgeAI
            </Link>
            <div className="site-nav__links">
              <Link href="/" className="site-nav__link">
                Dashboard
              </Link>
              <Link href="/settings" className="site-nav__link">
                Settings
              </Link>
              <Link href="/about" className="site-nav__link">
                About
              </Link>
            </div>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
