import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nyayadoot — Gujarati to English legal translation",
  description:
    "Upload a Gujarati legal document and download the English translation as an editable Word file.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                N
              </span>
              <span className="brand-text">
                <span className="brand-name">
                  Nyaya<span>doot</span>
                </span>
                <span className="brand-tag">Gujarati → English legal translation</span>
              </span>
            </Link>
            <nav className="site-nav" aria-label="Primary">
              <Link href="/" className="nav-link">
                Translate
              </Link>
              <Link href="/#library" className="nav-link">
                Library
              </Link>
              <span className="nav-pill">
                <span className="dot" aria-hidden="true" />
                Private · runs on this machine
              </span>
            </nav>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <span>Nyayadoot · working translation and review, not a certified translation.</span>
          <span>Every output is a draft for a qualified professional to check.</span>
        </footer>
      </body>
    </html>
  );
}
