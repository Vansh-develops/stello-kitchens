import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stello Kitchens · Console",
  description: "Menu & channel management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
