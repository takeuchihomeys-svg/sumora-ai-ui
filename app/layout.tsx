import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIXLINX",
  description: "AIXLINX — スモラAI LINE管理",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AIXLINX",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
  openGraph: {
    title: "AIXLINX",
    description: "AIXLINX — スモラAI LINE管理",
    url: "https://sumora-ai-ui.vercel.app",
    siteName: "AIXLINX",
    images: [
      {
        url: "https://sumora-ai-ui.vercel.app/icon-512.png",
        width: 512,
        height: 512,
        alt: "AIXLINX",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "AIXLINX",
    description: "AIXLINX — スモラAI LINE管理",
    images: ["https://sumora-ai-ui.vercel.app/icon-512.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="ja" style={{ backgroundColor: "white", height: "100%" }}>
      <body style={{ backgroundColor: "white", margin: 0, padding: 0, overflowY: "hidden", height: "100%" }}>
        {children}
      </body>
    </html>
  );
}