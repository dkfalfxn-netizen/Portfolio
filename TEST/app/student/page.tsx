"use client";

import { useCallback, useEffect, useState } from "react";
import { ExamLinks } from "@/components/exam-links";
import { ExportPanel } from "@/components/export-panel";
import { Card, PageShell } from "@/components/page-shell";
import { RecordForm } from "@/components/record-form";
import { RecordList } from "@/components/record-list";
import { WrongStats } from "@/components/wrong-stats";
import { api } from "@/lib/api";
import type { Exam, ExamRecord } from "@/lib/types";

export default function StudentPage() {
  const [name, setName] = useState("");
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [records, setRecords] = useState<ExamRecord[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const me = await api<{ session: { role: string; name?: string } | null }>("/api/auth/me");
      if (me.session?.role !== "student") {
        window.location.href = "/";
        return;
      }
      setName(me.session.name ?? "");
      const [e, r] = await Promise.all([
        api<{ exams: Exam[] }>("/api/exams"),
        api<{ records: ExamRecord[] }>("/api/records"),
      ]);
      setExams(e.exams);
      setRecords(r.records);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (!exams) return <div className="wrap">{error ? <p className="err">{error}</p> : "불러오는 중…"}</div>;

  return (
    <PageShell title={`${name}의 오답노트`} sub="틀린 문항을 누르면 배점대로 점수가 계산됩니다. 내 기록은 나와 선생님만 볼 수 있어요.">
      {error && <p className="err">{error}</p>}
      <Card title="자료 내려받기" hint="버튼을 누르면 새 탭에서 자료가 열립니다.">
        <ExamLinks exams={exams} />
      </Card>
      <Card title="오답 기록하기">
        <RecordForm exams={exams} onSaved={load} />
      </Card>
      <Card title="내 기록">
        <RecordList records={records} exams={exams} onChanged={load} />
      </Card>
      <Card title="내 문항별 오답">
        <WrongStats records={records} exams={exams} />
      </Card>
      <Card title="내 오답 추출" hint="복사해서 Claude에 붙여넣으면 오답 분석과 유사 문제를 받을 수 있어요.">
        <ExportPanel exams={exams} fileLabel={name} />
      </Card>
    </PageShell>
  );
}
