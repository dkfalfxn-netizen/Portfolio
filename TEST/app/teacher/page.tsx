"use client";

import { useCallback, useEffect, useState } from "react";
import { ExamLinks } from "@/components/exam-links";
import { ExamManager } from "@/components/exam-manager";
import { ExportPanel } from "@/components/export-panel";
import { Card, PageShell } from "@/components/page-shell";
import { RecordForm } from "@/components/record-form";
import { RecordList } from "@/components/record-list";
import { StudentManager } from "@/components/student-manager";
import { WrongStats } from "@/components/wrong-stats";
import { api } from "@/lib/api";
import type { Exam, ExamRecord, Student } from "@/lib/types";

const TABS = ["기록", "오답 추출", "시험지 관리", "학생 관리"] as const;

export default function TeacherPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("기록");
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [records, setRecords] = useState<ExamRecord[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const me = await api<{ session: { role: string } | null }>("/api/auth/me");
      if (me.session?.role !== "teacher") {
        window.location.href = "/";
        return;
      }
      const [e, s, r] = await Promise.all([
        api<{ exams: Exam[] }>("/api/exams"),
        api<{ students: Student[] }>("/api/students"),
        api<{ records: ExamRecord[] }>("/api/records"),
      ]);
      setExams(e.exams);
      setStudents(s.students);
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
    <PageShell title="기출 오답노트 · 선생님" sub="학생별 오답 기록, 문항 통계, 오답 추출(Claude 분석용)">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {error && <p className="err">{error}</p>}

      {tab === "기록" && (
        <>
          <Card title="자료 내려받기" hint="버튼을 누르면 새 탭에서 자료가 열립니다.">
            <ExamLinks exams={exams} />
          </Card>
          <Card title="오답 기록하기" hint="틀린 문항을 누르면 배점대로 점수가 계산됩니다.">
            {students.length === 0 ? (
              <p className="muted">먼저 &lsquo;학생 관리&rsquo; 탭에서 학생을 추가하세요.</p>
            ) : (
              <RecordForm exams={exams} students={students} onSaved={load} />
            )}
          </Card>
          <Card title="학생별 기록">
            <RecordList records={records} exams={exams} students={students} onChanged={load} />
          </Card>
          <Card title="문항별 오답 수">
            <WrongStats records={records} exams={exams} />
          </Card>
        </>
      )}
      {tab === "오답 추출" && (
        <Card
          title="오답만 추출"
          hint="결과를 복사해 Claude에 붙여넣고, 시험지·정답 PDF를 함께 첨부하면 오답 분석과 유사 문제를 만들 수 있습니다."
        >
          <ExportPanel exams={exams} students={students} />
        </Card>
      )}
      {tab === "시험지 관리" && (
        <Card title="시험지 관리" hint="배점과 단원을 등록하면 점수 계산·단원별 오답 분석에 쓰입니다.">
          <ExamManager exams={exams} onChanged={load} />
        </Card>
      )}
      {tab === "학생 관리" && (
        <Card title="학생 관리" hint="학생은 이름 + PIN으로 로그인하며 자기 기록만 볼 수 있습니다.">
          <StudentManager students={students} onChanged={load} />
        </Card>
      )}
    </PageShell>
  );
}
