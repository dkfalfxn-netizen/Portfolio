"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function LoginPage() {
  const [role, setRole] = useState<"student" | "teacher">("student");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 이미 로그인돼 있으면 바로 이동
  useEffect(() => {
    api<{ session: { role: string } | null }>("/api/auth/me")
      .then(({ session }) => {
        if (session) window.location.href = session.role === "teacher" ? "/teacher" : "/student";
      })
      .catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: role === "teacher" ? { role, password } : { role, name: name.trim(), pin },
      });
      window.location.href = role === "teacher" ? "/teacher" : "/student";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <div className="login">
        <h1>기출 오답노트</h1>
        <p className="sub">내 오답 기록은 나와 선생님만 볼 수 있습니다.</p>
        <div className="tabs">
          <button type="button" className={role === "student" ? "on" : ""} onClick={() => setRole("student")}>
            학생
          </button>
          <button type="button" className={role === "teacher" ? "on" : ""} onClick={() => setRole("teacher")}>
            선생님
          </button>
        </div>
        <form className="card" onSubmit={submit}>
          {role === "student" ? (
            <>
              <label className="f">이름</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" />
              <label className="f" style={{ marginTop: 10 }}>
                PIN (선생님께 받은 숫자)
              </label>
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                type="password"
                autoComplete="current-password"
              />
            </>
          ) : (
            <>
              <label className="f">선생님 비밀번호</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" disabled={busy}>
              로그인
            </button>
            {error && <span className="err">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
