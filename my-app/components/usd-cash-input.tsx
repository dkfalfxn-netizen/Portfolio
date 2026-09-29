"use client";

import { useState } from "react";
import { fmtUsdCashDisplay, parseUsdCashDigits } from "@/lib/format-money";

/** USD 현금 입력 필드 — 포커스 중엔 편집하기 쉽게 원문 그대로, 벗어나면 콤마 포맷으로 보여줌 */
export function UsdCashInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(() => (value === 0 ? "" : String(value)));
  const [syncedValue, setSyncedValue] = useState(value);

  if (!focused && value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value === 0 ? "" : String(value));
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className="w-28 rounded-md border bg-background px-2 py-1.5 text-right tabular-nums"
      placeholder="0"
      value={focused ? draft : fmtUsdCashDisplay(value)}
      onFocus={() => {
        setFocused(true);
        setDraft(value === 0 ? "" : String(value));
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        onChange(Math.round(parseUsdCashDigits(raw) * 100) / 100);
      }}
    />
  );
}
