import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Wayne's Pizza", template: "%s | Wayne's Pizza" },
  description: "Wayne's Pizza operating system"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
