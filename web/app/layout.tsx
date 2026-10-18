import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./approved-broker-chart.css";
import "./workspace.css";

export const metadata: Metadata = {
  title: "Trading OS | 老板交易驾驶舱",
  description: "基于 V2 合同、测试和文档的本地只读交易驾驶舱。",
};

export const viewport: Viewport = { colorScheme: "dark", themeColor: "#090c0f" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" data-owner-font="standard"><body>{children}</body></html>;
}
