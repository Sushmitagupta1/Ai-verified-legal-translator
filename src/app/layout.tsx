import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nyayadoot — Gujarati to English legal translation",
  description:
    "Upload a Gujarati legal document and get an English translation with a non-certified fidelity report.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <div className="topbar">
            <div className="brand">
              Nyaya<span>doot</span>
            </div>
            <div className="tagline">
              Gujarati → English legal documents with a non-certified fidelity report
            </div>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
