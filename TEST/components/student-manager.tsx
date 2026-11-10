"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { Student } from "@/lib/types";

const randomPin = () => String(Math.floor(100000 + Math.random() * 900000));

export function StudentManager({ students, onChanged }: { students: Student[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState(randomPin());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function add() {
    setMsg(null);
    try {
      await api("/api/students", { method: "POST", body: { name: name.trim(), pin } });
      setMsg({ ok: true, text: `${name.trim()} 추가됨 — PIN ${pin} (지금 학생에게 알려 주세요. 다시 볼 수 없습니다)` });
      setName("");
      setPin(randomPin());
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function resetPin(s: Student) {
    const p = prompt(`${s.name}의 새 PIN (숫자 4~8자리)`, randomPin());
    if (!p) return;
    try {
      await api(`/api/students/${s.id}`, { method: "PUT", body: { pin: p } });
      setMsg({ ok: true, text: `${s.name}의 PIN을 ${p}(으)로 바꿨습니다.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function rename(s: Student) {
    const n = prompt("새 이름", s.name);
    if (!n || n === s.name) return;
    try {
      await api(`/api/students/${s.id}`, { method: "PUT", body: { name: n } });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function remove(s: Student) {
    if (!confirm(`${s.name} 학생과 모든 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await api(`/api/students/${s.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div>
      <div className="row">
        <input style={{ maxWidth: 180 }} placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          style={{ maxWidth: 120 }}
          placeholder="PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        />
        <button className="primary" onClick={add} disabled={!name.trim()}>
          학생 추가
        </button>
      </div>
      {msg && <p className={msg.ok ? "okmsg" : "err"}>{msg.text}</p>}
      <table style={{ marginTop: 10 }}>
        <tbody>
          {students.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <button className="link" onClick={() => rename(s)}>
                  이름 변경
                </button>
                <button className="link" onClick={() => resetPin(s)}>
                  PIN 재설정
                </button>
                <button className="link" onClick={() => remove(s)}>
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {students.length === 0 && <p className="muted">등록된 학생이 없습니다.</p>}
    </div>
  );
}
