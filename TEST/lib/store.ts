import { promises as fs } from "fs";
import path from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SAMPLE_EXAM } from "./seed";
import type { Exam, ExamRecord, StudentWithPin } from "./types";

export interface RecordFilter {
  studentId?: string;
  examId?: string;
}

/** 저장소 인터페이스. Supabase 환경변수가 있으면 Supabase, 없으면 data/db.json 파일. */
export interface Store {
  listExams(): Promise<Exam[]>;
  getExam(id: string): Promise<Exam | null>;
  saveExam(exam: Exam): Promise<void>;
  deleteExam(id: string): Promise<void>;

  listStudents(): Promise<StudentWithPin[]>;
  getStudent(id: string): Promise<StudentWithPin | null>;
  getStudentByName(name: string): Promise<StudentWithPin | null>;
  saveStudent(s: StudentWithPin): Promise<void>;
  deleteStudent(id: string): Promise<void>;

  listRecords(f: RecordFilter): Promise<ExamRecord[]>;
  getRecord(id: string): Promise<ExamRecord | null>;
  saveRecord(r: ExamRecord): Promise<void>;
  deleteRecord(id: string): Promise<void>;
}

// ───────────────────────── 파일(로컬) 저장소 ─────────────────────────

interface DbShape {
  exams: Exam[];
  students: StudentWithPin[];
  records: ExamRecord[];
}

const DB_PATH = path.join(process.cwd(), "data", "db.json");
let writeChain: Promise<unknown> = Promise.resolve();

async function readDb(): Promise<DbShape> {
  try {
    return JSON.parse(await fs.readFile(DB_PATH, "utf8")) as DbShape;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // 깨진 파일은 덮어쓰지 않고 오류
    return { exams: [SAMPLE_EXAM], students: [], records: [] };
  }
}

/** 읽기-수정-쓰기를 직렬화해서 동시 저장 시 기록이 사라지지 않게 한다. */
function mutate(fn: (db: DbShape) => void): Promise<void> {
  const run = writeChain.then(async () => {
    const db = await readDb();
    fn(db);
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    const tmp = DB_PATH + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(tmp, DB_PATH);
  });
  writeChain = run.catch(() => undefined);
  return run;
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

const fileStore: Store = {
  async listExams() {
    return (await readDb()).exams;
  },
  async getExam(id) {
    return (await readDb()).exams.find((e) => e.id === id) ?? null;
  },
  saveExam: (exam) => mutate((db) => upsert(db.exams, exam)),
  deleteExam: (id) =>
    mutate((db) => {
      db.exams = db.exams.filter((e) => e.id !== id);
      db.records = db.records.filter((r) => r.examId !== id);
    }),

  async listStudents() {
    return (await readDb()).students;
  },
  async getStudent(id) {
    return (await readDb()).students.find((s) => s.id === id) ?? null;
  },
  async getStudentByName(name) {
    return (await readDb()).students.find((s) => s.name === name) ?? null;
  },
  saveStudent: (s) => mutate((db) => upsert(db.students, s)),
  deleteStudent: (id) =>
    mutate((db) => {
      db.students = db.students.filter((s) => s.id !== id);
      db.records = db.records.filter((r) => r.studentId !== id);
    }),

  async listRecords(f) {
    return (await readDb()).records.filter(
      (r) => (!f.studentId || r.studentId === f.studentId) && (!f.examId || r.examId === f.examId),
    );
  },
  async getRecord(id) {
    return (await readDb()).records.find((r) => r.id === id) ?? null;
  },
  saveRecord: (r) => mutate((db) => upsert(db.records, r)),
  deleteRecord: (id) =>
    mutate((db) => {
      db.records = db.records.filter((r) => r.id !== id);
    }),
};

// ───────────────────────── Supabase 저장소 ─────────────────────────
// 테이블은 supabase/schema.sql. RLS를 켜고 정책을 두지 않으므로 서버(service role)만 접근 가능.

/* eslint-disable @typescript-eslint/no-explicit-any */
const examFromRow = (r: any): Exam => ({
  id: r.id,
  title: r.title,
  description: r.description ?? "",
  mc: r.mc ?? [],
  sa: r.sa ?? [],
  links: r.links ?? [],
  createdAt: r.created_at,
});
const examToRow = (e: Exam) => ({
  id: e.id,
  title: e.title,
  description: e.description,
  mc: e.mc,
  sa: e.sa,
  links: e.links,
  created_at: e.createdAt,
});
const studentFromRow = (r: any): StudentWithPin => ({
  id: r.id,
  name: r.name,
  pinHash: r.pin_hash,
  createdAt: r.created_at,
});
const recordFromRow = (r: any): ExamRecord => ({
  id: r.id,
  studentId: r.student_id,
  examId: r.exam_id,
  date: r.date,
  items: r.items ?? [],
  score: Number(r.score),
  total: Number(r.total),
  memo: r.memo ?? "",
  createdAt: r.created_at,
});
const recordToRow = (r: ExamRecord) => ({
  id: r.id,
  student_id: r.studentId,
  exam_id: r.examId,
  date: r.date,
  items: r.items,
  score: r.score,
  total: r.total,
  memo: r.memo,
  created_at: r.createdAt,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error("Supabase 오류: " + res.error.message);
  return res.data;
}

function supabaseStore(sb: SupabaseClient): Store {
  return {
    async listExams() {
      return (check(await sb.from("exams").select("*").order("created_at")) ?? []).map(examFromRow);
    },
    async getExam(id) {
      const d = check(await sb.from("exams").select("*").eq("id", id).maybeSingle());
      return d ? examFromRow(d) : null;
    },
    async saveExam(e) {
      check(await sb.from("exams").upsert(examToRow(e)));
    },
    async deleteExam(id) {
      check(await sb.from("exams").delete().eq("id", id));
    },

    async listStudents() {
      return (check(await sb.from("students").select("*").order("name")) ?? []).map(studentFromRow);
    },
    async getStudent(id) {
      const d = check(await sb.from("students").select("*").eq("id", id).maybeSingle());
      return d ? studentFromRow(d) : null;
    },
    async getStudentByName(name) {
      const d = check(await sb.from("students").select("*").eq("name", name).maybeSingle());
      return d ? studentFromRow(d) : null;
    },
    async saveStudent(s) {
      check(
        await sb
          .from("students")
          .upsert({ id: s.id, name: s.name, pin_hash: s.pinHash, created_at: s.createdAt }),
      );
    },
    async deleteStudent(id) {
      check(await sb.from("students").delete().eq("id", id));
    },

    async listRecords(f) {
      let q = sb.from("records").select("*");
      if (f.studentId) q = q.eq("student_id", f.studentId);
      if (f.examId) q = q.eq("exam_id", f.examId);
      return (check(await q.order("date")) ?? []).map(recordFromRow);
    },
    async getRecord(id) {
      const d = check(await sb.from("records").select("*").eq("id", id).maybeSingle());
      return d ? recordFromRow(d) : null;
    },
    async saveRecord(r) {
      check(await sb.from("records").upsert(recordToRow(r)));
    },
    async deleteRecord(id) {
      check(await sb.from("records").delete().eq("id", id));
    },
  };
}

let cached: Store | null = null;

export function getStore(): Store {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    cached = supabaseStore(createClient(url, key, { auth: { persistSession: false } }));
  } else if (process.env.VERCEL) {
    throw new Error("배포 환경에서는 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.");
  } else {
    cached = fileStore;
  }
  return cached;
}
