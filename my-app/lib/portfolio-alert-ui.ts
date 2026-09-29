import { cn } from "@/lib/utils";
import { type AlertRule } from "@/lib/alert-thresholds";

export const ALERT_RETURN_PCT_PRESETS = [5, 10, 15, 20] as const;

export const ALERT_PCT_PRESET_BTN =
  "min-h-[1.35rem] min-w-0 flex-1 rounded-md border border-slate-500/90 bg-slate-800 px-0.5 py-0.5 text-[10px] font-semibold leading-tight tabular-nums text-slate-100 shadow-sm transition-colors hover:border-sky-400/80 hover:bg-sky-500/25 active:scale-[0.98]";

export function alertPctPresetBtnClass(active: boolean): string {
  return cn(
    ALERT_PCT_PRESET_BTN,
    active && "border-sky-400 bg-sky-500/40 text-white ring-1 ring-sky-400/40",
  );
}

export function hasAlertThresholdRule(rule: AlertRule | undefined): boolean {
  if (!rule) return false;
  return (
    rule.takeProfitPrice !== undefined ||
    rule.stopLossPrice !== undefined ||
    rule.takeProfitReturnPct !== undefined ||
    rule.stopLossReturnPct !== undefined
  );
}
