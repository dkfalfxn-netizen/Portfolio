"use client";

import { Card, CardHeader, CardDescription, CardTitle, CardContent } from "@/components/ui/card";
import { safeSetItem } from "@/lib/portfolio-storage";
import { AUTO_SYNC_STORAGE } from "@/lib/portfolio-types";
import { type ChangeEvent, type RefObject, type Dispatch, type SetStateAction } from "react";

export type SyncSectionProps = {
  autoSync: boolean;
  cloudSyncKey: string;
  handleBackupSnapshot: () => Promise<void>;
  handleClearLocalData: () => Promise<void>;
  handleDownloadBackups: () => Promise<void>;
  handlePullCloud: () => Promise<void>;
  handlePushCloud: () => Promise<void>;
  handleRestoreFromBackupFile: (ev: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleRestoreSpecificBackup: (idx: number) => Promise<void>;
  handleSaveSyncKey: () => Promise<void>;
  hasLoadedLatestBackup: boolean;
  lastSellLogSyncedAt: string | null;
  lastSyncedAt: string | null;
  latestBackupAt: string | null;
  pendingBackups: { id?: string; created_at: string; snapshot: Record<string, unknown>; }[] | null;
  pendingClearConfirm: boolean;
  restoreBackupFileInputRef: RefObject<HTMLInputElement | null>;
  sellLogDirty: boolean;
  serverHealth: "loading" | "ok" | "error";
  setAutoSync: Dispatch<SetStateAction<boolean>>;
  setPendingBackups: Dispatch<SetStateAction<{ id?: string; created_at: string; snapshot: Record<string, unknown>; }[] | null>>;
  setPendingClearConfirm: Dispatch<SetStateAction<boolean>>;
  setSyncKeyDraft: Dispatch<SetStateAction<string>>;
  setSyncMessage: Dispatch<SetStateAction<string>>;
  syncBusy: boolean;
  syncKeyDraft: string;
  syncMessage: string;
  syncReady: boolean;
};

export function SyncSection({
  autoSync,
  cloudSyncKey,
  handleBackupSnapshot,
  handleClearLocalData,
  handleDownloadBackups,
  handlePullCloud,
  handlePushCloud,
  handleRestoreFromBackupFile,
  handleRestoreSpecificBackup,
  handleSaveSyncKey,
  hasLoadedLatestBackup,
  lastSellLogSyncedAt,
  lastSyncedAt,
  latestBackupAt,
  pendingBackups,
  pendingClearConfirm,
  restoreBackupFileInputRef,
  sellLogDirty,
  serverHealth,
  setAutoSync,
  setPendingBackups,
  setPendingClearConfirm,
  setSyncKeyDraft,
  setSyncMessage,
  syncBusy,
  syncKeyDraft,
  syncMessage,
  syncReady,
}: SyncSectionProps) {
  return (
    <Card id="section-sync" className="border-dashed">
            <CardHeader className="pb-2">
              <CardDescription>클라우드 동기화 (폰·PC 같은 데이터)</CardDescription>
              <CardTitle className="text-lg">동기화 키</CardTitle>
              <p className="text-xs text-muted-foreground">
                다른 PC·폰에서는 브라우저마다 저장소가 달라서, 집에서 쓰는 동기화 키를 그대로 입력한 뒤
                「키 저장」만 하면 서버에서 자동으로 불러옵니다. 키는 비밀번호처럼 길게 정하세요.
              </p>
              <p className="text-xs text-muted-foreground">
                서버(Supabase) 연결:{" "}
                {serverHealth === "loading" ? (
                  <span>확인 중…</span>
                ) : serverHealth === "ok" ? (
                  <span className="text-emerald-600 dark:text-emerald-400">정상</span>
                ) : (
                  <span className="text-amber-600 dark:text-amber-400">
                    문제 있음 — Vercel 환경 변수{" "}
                    <code className="rounded bg-muted px-1">NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
                    <code className="rounded bg-muted px-1">SUPABASE_SERVICE_ROLE_KEY</code> 확인 후
                    재배포
                  </span>
                )}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <label className="mb-1 block text-xs text-muted-foreground" htmlFor="sync-key">
                    동기화 키 (8자 이상)
                  </label>
                  <input
                    id="sync-key"
                    type="password"
                    autoComplete="off"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="예: 우리가족포트폴리오2026"
                    value={syncKeyDraft}
                    onChange={(e) => setSyncKeyDraft(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95"
                  onClick={handleSaveSyncKey}
                >
                  키 저장
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={handlePullCloud}
                >
                  서버에서 불러오기
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={handlePushCloud}
                >
                  서버로 올리기
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-dashed px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={handleBackupSnapshot}
                >
                  백업
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-dashed px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={handleDownloadBackups}
                >
                  백업 내려받기
                </button>
                <input
                  ref={restoreBackupFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleRestoreFromBackupFile}
                />
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-dashed px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={() => restoreBackupFileInputRef.current?.click()}
                >
                  백업에서 복원
                </button>
                <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
                  <input
                    type="checkbox"
                    className="cursor-pointer accent-primary"
                    checked={autoSync}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setAutoSync(v);
                      safeSetItem(AUTO_SYNC_STORAGE, v ? "1" : "0");
                    }}
                  />
                  변경 시 자동으로 서버에 저장 (2초 후)
                </label>
              </div>
              <div className="border-t pt-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  현재 동기화 키의 데이터(보유 종목·현금·관심 종목·목표 비율 등)를 <strong className="text-foreground">로컬과 서버에서 모두 비웁니다.</strong> 보유자 목록은 유지됩니다. <strong className="text-foreground">다른 동기화 키의 데이터는 키마다 별도로 저장되어 영향받지 않습니다.</strong> 비우기 직전 서버 상태는 <strong className="text-foreground">자동 백업</strong>되어 「백업에서 복원」으로 되살릴 수 있습니다.
                </p>
                {pendingClearConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-destructive font-medium">이 키의 서버 데이터까지 비웁니다. 진행할까요?</span>
                    <button
                      type="button"
                      className="cursor-pointer rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-all duration-100 hover:bg-destructive/90 active:scale-95"
                      onClick={handleClearLocalData}
                    >
                      확인 (초기화)
                    </button>
                    <button
                      type="button"
                      className="cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95"
                      onClick={() => setPendingClearConfirm(false)}
                    >
                      취소
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="cursor-pointer rounded-md border border-destructive/50 px-3 py-1.5 text-sm text-destructive transition-all duration-100 hover:bg-destructive/10 active:scale-95"
                    onClick={() => setPendingClearConfirm(true)}
                  >
                    이 키 데이터 초기화 (로컬+서버)
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                「백업」은 서버에 올라간 잔고를 백업 테이블에 한 줄씩 추가합니다(최대 1년, 500건).
                목표 비중과 리밸 계산기의 종목 분배·모드까지 동일 스키마(sync)로 포함됩니다. 「백업 내려받기」는 먼저 백업을 저장한 뒤 JSON으로 다운로드. 「백업에서 복원」은 JSON을 업로드하면 <strong className="font-medium text-foreground">시점 목록이 표시되며 원하는 시점을 선택해 복원</strong>할 수 있습니다.
              </p>

              {/* 백업 시점 선택 복원 UI */}
              {pendingBackups && pendingBackups.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-amber-200">
                      복원할 시점을 선택하세요 ({pendingBackups.length}건)
                    </p>
                    <button
                      type="button"
                      className="text-[10px] text-zinc-500 hover:text-zinc-300 transition"
                      onClick={() => { setPendingBackups(null); setSyncMessage(""); }}
                    >
                      취소
                    </button>
                  </div>
                  <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                    {pendingBackups.map((b, idx) => {
                      const kstTime = new Date(b.created_at).toLocaleString("ko-KR", {
                        timeZone: "Asia/Seoul",
                        year: "numeric", month: "2-digit", day: "2-digit",
                        hour: "2-digit", minute: "2-digit", second: "2-digit",
                      });
                      const posCount = Array.isArray((b.snapshot as { positions?: unknown }).positions)
                        ? (b.snapshot.positions as unknown[]).length
                        : "?";
                      const srcAt = typeof (b.snapshot as { source_updated_at?: unknown }).source_updated_at === "string"
                        ? new Date((b.snapshot as { source_updated_at: string }).source_updated_at).toLocaleString("ko-KR", {
                            timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
                            hour: "2-digit", minute: "2-digit",
                          })
                        : null;
                      return (
                        <button
                          key={b.id ?? idx}
                          type="button"
                          disabled={syncBusy}
                          onClick={() => void handleRestoreSpecificBackup(idx)}
                          className="w-full flex items-center justify-between gap-3 rounded border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-left text-xs hover:bg-zinc-800 transition disabled:opacity-50"
                        >
                          <span className="font-mono tabular-nums text-zinc-200">{kstTime}</span>
                          <span className="shrink-0 text-zinc-500">
                            {posCount}종목{srcAt ? ` · 데이터 ${srcAt}` : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-amber-400/80">⚠ 선택 시 서버 메인 잔고를 해당 시점으로 덮어씁니다.</p>
                </div>
              )}
              {syncMessage ? (
                <p className="text-xs text-muted-foreground">{syncMessage}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                매도 기록 동기화:{" "}
                {sellLogDirty ? (
                  <span className="text-amber-600">로컬 변경 있음 (서버 반영 대기)</span>
                ) : lastSellLogSyncedAt ? (
                  <span>
                    최신 반영{" "}
                    {new Date(lastSellLogSyncedAt).toLocaleString("ko-KR", {
                      hour12: false,
                    })}
                  </span>
                ) : (
                  <span>아직 반영 이력 없음</span>
                )}
              </p>
              {syncBusy ? <p className="text-xs text-amber-600">동기화 중…</p> : null}
              {lastSyncedAt ? (
                <p className="text-xs text-muted-foreground">
                  마지막 동기 시각: {new Date(lastSyncedAt).toLocaleString()}
                </p>
              ) : null}
              {syncReady && cloudSyncKey.trim().length >= 8 && hasLoadedLatestBackup ? (
                <p className="text-xs text-muted-foreground">
                  서버 최근 백업:{" "}
                  {latestBackupAt ? (
                    <span className="font-medium text-foreground">
                      {new Date(latestBackupAt).toLocaleString()}
                    </span>
                  ) : (
                    <span>아직 없음 (「백업」 또는 「백업 내려받기」로 저장)</span>
                  )}
                </p>
              ) : null}
            </CardContent>
          </Card>
  );
}
