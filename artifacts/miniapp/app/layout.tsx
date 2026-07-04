import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { appManifest } from "@/manifest";
import { RootProvider } from "./rootProvider";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: appManifest.miniapp.name,
    description: appManifest.miniapp.description,
    other: {
      // Base App registration (base.dev). Replace with your registered app id.
      "base:app_id": "miorail-placeholder",
      // Optional Farcaster distribution embed (static metadata only — no
      // Farcaster runtime SDK is imported anywhere in this app).
      "fc:miniapp": JSON.stringify({
        version: appManifest.miniapp.version,
        imageUrl: appManifest.miniapp.heroImageUrl,
        button: {
          title: `Launch ${appManifest.miniapp.name}`,
          action: {
            name: `Launch ${appManifest.miniapp.name}`,
            type: "launch_miniapp",
          },
        },
      }),
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#070A17",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Fonts aligned with Miorail Ink design tokens (lib/ui/src/tokens.css).
// --font-sans  → Inter (body)
// --font-display → Space Grotesk (headings/brand)
// --font-mono  → JetBrains Mono (data/code)
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
