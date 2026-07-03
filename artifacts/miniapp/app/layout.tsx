import type { Metadata } from "next";
import { Inter, Source_Code_Pro } from "next/font/google";
import { appManifest } from "@/manifest";
import { RootProvider } from "./rootProvider";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: appManifest.miniapp.name,
    description: appManifest.miniapp.description,
    other: {
      // Base App registration (base.dev). Replace with your registered app id.
      "base:app_id": "mioagent-placeholder",
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

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const sourceCodePro = Source_Code_Pro({
  variable: "--font-source-code-pro",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${sourceCodePro.variable}`}>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
