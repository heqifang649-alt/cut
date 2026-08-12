import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001"),
  icons: { icon: "/favicon.svg" },
  title: "GC Cutflow · 统一剪辑工作台",
  description: "先识别样片，再按统一脚本批量完成服装广告剪辑。",
  openGraph: {
    title: "GC Cutflow · 统一剪辑工作台",
    description: "样片识别 · 统一脚本 · 批量剪辑",
    images: [{ url: "/og.png", width: 1680, height: 945, alt: "GC Cutflow 批量剪辑流程" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
