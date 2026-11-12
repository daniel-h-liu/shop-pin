import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Fonts are self-hosted from app/fonts (Latin subset, SIL Open Font License)
// so builds never depend on reaching Google Fonts. To change a font, drop its
// .woff2 into app/fonts, load it here, and point the role variables in
// globals.css (--font-display, --font-heading, --font-body, --font-label) at it.

// Display: the wordmark and big titles.
const leagueScript = localFont({
  src: "./fonts/LeagueScript-Regular-latin.woff2",
  weight: "400",
  variable: "--font-league-script",
  display: "swap",
});

// Headings: product names, prices, step titles.
const lato = localFont({
  src: [
    { path: "./fonts/Lato-Thin-latin.woff2", weight: "100", style: "normal" },
    { path: "./fonts/Lato-ThinItalic-latin.woff2", weight: "100", style: "italic" },
    { path: "./fonts/Lato-Light-latin.woff2", weight: "300", style: "normal" },
    { path: "./fonts/Lato-LightItalic-latin.woff2", weight: "300", style: "italic" },
    { path: "./fonts/Lato-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Lato-Italic-latin.woff2", weight: "400", style: "italic" },
    { path: "./fonts/Lato-Bold-latin.woff2", weight: "700", style: "normal" },
    { path: "./fonts/Lato-BoldItalic-latin.woff2", weight: "700", style: "italic" },
    { path: "./fonts/Lato-Black-latin.woff2", weight: "900", style: "normal" },
    { path: "./fonts/Lato-BlackItalic-latin.woff2", weight: "900", style: "italic" },
  ],
  variable: "--font-lato",
  display: "swap",
  preload: false, // ten files; browsers fetch only the weights a page uses
});

// Body text. Variable font (weight 200–900, optical size 7–72).
const literata = localFont({
  src: [
    { path: "./fonts/Literata-Variable-latin.woff2", weight: "200 900", style: "normal" },
    { path: "./fonts/Literata-Variable-Italic-latin.woff2", weight: "200 900", style: "italic" },
  ],
  variable: "--font-literata",
  display: "swap",
});

// Search bar, buttons and small labels.
const dmMono = localFont({
  src: [
    { path: "./fonts/DMMono-Light-latin.woff2", weight: "300", style: "normal" },
    { path: "./fonts/DMMono-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/DMMono-Medium-latin.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "shop-pin!",
  description: "Paste a Pinterest board. We find each piece in every pin and where to buy it.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const fonts = [leagueScript, lato, literata, dmMono].map((f) => f.variable).join(" ");
  return (
    <html lang="en" className={`${fonts} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
