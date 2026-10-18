"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- Keep the existing native navigation used by the local Owner build. */
import { useEffect, useRef } from "react";
import type { OwnerPage } from "./page";

const mainLinks = [
  ["home", "/", "总览", "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z"],
  ["forecast", "/forecast", "市场", "M4 4v16h16 M7 14l4-4 4 3 5-7"],
  ["options", "/options", "持仓", "M4 7h16v13H4z M8 7V4h8v3 M4 12h16 M10 12v3h4v-3"],
  ["settlements", "/settlements", "研究与复盘", "M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h5"],
] as const;

export function WorkspaceNav({ page }: { page: OwnerPage }) {
  const fontSizeRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const value = window.localStorage.getItem("trading-os-owner-font:v1");
    if (["small", "standard", "large"].includes(value ?? "")) {
      document.documentElement.dataset.ownerFont = value!;
      if (fontSizeRef.current) fontSizeRef.current.value = value!;
    }
  }, []);
  const active = page === "company" ? "forecast" : page;
  return <>
    <header className="workspace-nav">
      <a className="workspace-brand" href="/" aria-label="Trading OS 首页"><span aria-hidden="true">T</span><b>TRADING OS</b></a>
      <nav className="workspace-primary" aria-label="主导航">{mainLinks.map(([id, href, label, path]) => <a key={id} href={href} aria-current={active === id ? "page" : undefined}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg><span>{label}</span></a>)}</nav>
      <div className="workspace-utilities">
        <a href="/health" aria-current={page === "health" ? "page" : undefined}>系统状态</a>
        <details className="workspace-settings"><summary aria-label="更多与显示设置">更多</summary><div>
          <a href="/issues" aria-current={page === "issues" ? "page" : undefined}>反馈与待办</a>
          <a href="/company#timeline">运行记录</a>
          <label htmlFor="owner-font-size">显示大小</label>
          <select id="owner-font-size" ref={fontSizeRef} defaultValue="standard" onChange={(event) => {
            const value = event.target.value;
            if (!["small", "standard", "large"].includes(value)) return;
            document.documentElement.dataset.ownerFont = value;
            window.localStorage.setItem("trading-os-owner-font:v1", value);
          }}><option value="small">小</option><option value="standard">标准</option><option value="large">大</option></select>
          <form method="post" action="/logout"><button type="submit">退出登录</button></form>
        </div></details>
      </div>
    </header>
    {(page === "forecast" || page === "company") && <nav className="workspace-market-nav" aria-label="市场分区"><a href="/forecast" aria-current={page === "forecast" ? "page" : undefined}>指数看盘</a><a href="/company#opportunities" aria-current={page === "company" ? "page" : undefined}>个股观察</a><a href="/company#market-events">事件日历</a></nav>}
  </>;
}
