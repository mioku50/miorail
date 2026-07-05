import type { Metadata, Viewport } from "next";
import { appManifest } from "@/manifest";
import { RootProvider } from "./rootProvider";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: appManifest.miniapp.name,
    description: appManifest.miniapp.description,
    other: {
      // Base App registration (base.dev). Replace with your registered app id.
      "base:app_id": "6a4a235b2fba975b6bdf8012",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Fonts loaded at runtime (not build-time) so next build works offline.
            Families and weights match artifacts/interface/index.html and
            lib/ui/src/tokens.css. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
