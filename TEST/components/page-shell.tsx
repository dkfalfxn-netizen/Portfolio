"use client";

import { api } from "@/lib/api";

export function PageShell({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/";
  }
  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <h1>{title}</h1>
          <p className="sub">{sub}</p>
        </div>
        <button onClick={logout}>로그아웃</button>
      </div>
      {children}
    </div>
  );
}

export function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : <div style={{ height: 8 }} />}
      {children}
    </section>
  );
}
