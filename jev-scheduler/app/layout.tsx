import type { ReactNode } from "react";

export const metadata = { title: "Jev meeting scheduler", description: "Email thread + computer history -> Jev -> scheduled meeting" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif", background: "#f6f7f9", color: "#1a1d21" }}>{children}</body>
    </html>
  );
}
