import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PRD Generator",
  description: "Interactive PRD generator berbasis Gemini API dengan Next.js.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
