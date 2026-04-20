"use client";

type SimForm = {
  symbol: string;
  name: string;
  quantity: string;
  avgPrice: string;
  currency: "USD" | "EUR" | "KRW";
  owner: string;
};

type SimRow = {
  label: string;
  beforePct: number;
  afterPct: number;
  delta: number;
};

export type SimResult = {
  beforeTotal: number;
  afterTotal: number;
  simValueKrw: number;
  rows: SimRow[];
} | null;

type Props = {
  simForm: SimForm;
  setSimForm: React.Dispatch<React.SetStateAction<SimForm>>;
  simResult: SimResult;
  ownerNames: string[];
};

export function SimulatorSection({ simForm, setSimForm, simResult, ownerNames }: Props) {
  return (
    <section id="section-simulator" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
      <h2 className="mb-1 font-semibold">가상 매수 시뮬레이터</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        종목을 추가로 매수했을 때의 예상 비중 변화를 미리 확인합니다.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
        <input
          className="rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="티커 (예: NVDA)"
          value={simForm.symbol}
          onChange={(e) => setSimForm((p) => ({ ...p, symbol: e.target.value }))}
        />
        <input
          type="number"
          min="0"
          step="any"
          className="rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="수량"
          value={simForm.quantity}
          onChange={(e) => setSimForm((p) => ({ ...p, quantity: e.target.value }))}
        />
        <input
          type="number"
          min="0"
          step="any"
          className="rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="매수 단가"
          value={simForm.avgPrice}
          onChange={(e) => setSimForm((p) => ({ ...p, avgPrice: e.target.value }))}
        />
        <select
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={simForm.currency}
          onChange={(e) =>
            setSimForm((p) => ({ ...p, currency: e.target.value as "USD" | "EUR" | "KRW" }))
          }
        >
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="KRW">KRW</option>
        </select>
        <select
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={simForm.owner}
          onChange={(e) => setSimForm((p) => ({ ...p, owner: e.target.value }))}
        >
          {ownerNames.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <button
          type="button"
          className="cursor-pointer rounded-md border px-3 py-2 text-sm transition-all duration-100 hover:bg-muted active:scale-95"
          onClick={() =>
            setSimForm({
              symbol: "",
              name: "",
              quantity: "",
              avgPrice: "",
              currency: "USD",
              owner: ownerNames[0] ?? "김승주",
            })
          }
        >
          초기화
        </button>
      </div>

      {simResult && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium">
            {simForm.owner} 총 평가: ₩{Math.round(simResult.beforeTotal).toLocaleString()}
            {" → "}
            <span className="text-primary">₩{Math.round(simResult.afterTotal).toLocaleString()}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              (매수 금액 ₩{Math.round(simResult.simValueKrw).toLocaleString()} 추가)
            </span>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="pb-1 text-left font-medium">종목</th>
                  <th className="pb-1 text-right font-medium">현재 비중</th>
                  <th className="pb-1 text-right font-medium">매수 후 비중</th>
                  <th className="pb-1 text-right font-medium">변화</th>
                </tr>
              </thead>
              <tbody>
                {simResult.rows.map((row) => (
                  <tr key={row.label} className="border-b last:border-0">
                    <td className="py-1.5 pr-4">{row.label}</td>
                    <td className="py-1.5 text-right text-muted-foreground">
                      {row.beforePct.toFixed(1)}%
                    </td>
                    <td className="py-1.5 text-right font-medium text-primary">
                      {row.afterPct.toFixed(1)}%
                    </td>
                    <td
                      className={`py-1.5 text-right text-xs font-medium ${
                        row.delta > 0 ? "text-red-500" : row.delta < 0 ? "text-blue-500" : "text-muted-foreground"
                      }`}
                    >
                      {row.delta > 0 ? "+" : ""}{row.delta.toFixed(1)}%p
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!simResult && simForm.symbol && (
        <p className="mt-3 text-xs text-muted-foreground">수량과 매수 단가를 입력하면 결과가 표시됩니다.</p>
      )}
    </section>
  );
}
