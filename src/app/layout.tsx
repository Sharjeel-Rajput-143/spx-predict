import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { AntdProvider } from "@/components/antd/AntdProvider";
import { GameProvider } from "@/components/GameProvider";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Call the next candle. Compete on accuracy.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#131722" },
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
  ],
};

// Light is the default. Applies a saved "dark" choice before first paint to avoid a light/dark flash.
const themeScript = `try{if(localStorage.getItem("spx-predict:theme")==="dark"){document.documentElement.classList.add("dark");document.documentElement.style.colorScheme="dark"}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" style={{ colorScheme: "light" }} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased">
        <AntdProvider>
          <GameProvider>
            <AppShell>{children}</AppShell>
          </GameProvider>
        </AntdProvider>
      </body>
    </html>
  );
}
