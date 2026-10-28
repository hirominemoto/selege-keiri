import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "セレッジ管理システム",
  description: "セレッジの請求・支払・収支を管理する",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
