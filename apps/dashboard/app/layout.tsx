import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/components/SessionProvider";
import { I18nProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Stello Kitchens · Console",
  description: "Menu & channel management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <I18nProvider>{children}</I18nProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
