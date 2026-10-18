"use client";

import { useId, useRef, type ReactNode } from "react";

/** Long evidence stays beside the page instead of stretching its grid row. */
export function DetailSheet({ title, label = title, className = "", id, children }: { title: string; label?: string; className?: string; id?: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  return <div className={`detail-sheet-entry ${className}`} id={id}>
    <button className="detail-sheet-trigger" type="button" ref={trigger} aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>{label}<span aria-hidden="true">↗</span></button>
    <dialog className="detail-sheet" ref={dialog} aria-labelledby={headingId} onClose={() => trigger.current?.focus({ preventScroll: true })}>
      <header className="detail-sheet-heading"><h2 id={headingId}>{title}</h2><button type="button" aria-label="关闭详情" onClick={() => dialog.current?.close()}>关闭 <span aria-hidden="true">×</span></button></header>
      <div className="detail-sheet-content">{children}</div>
    </dialog>
  </div>;
}
