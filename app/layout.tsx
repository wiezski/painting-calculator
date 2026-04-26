import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Painting Calculator",
  description:
    "Residential painting takeoff assistant. Upload plans, get a paint and material estimate.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
