"use client";
// 売上サポ（PickupReview）の会話の一番上に常に出す「🔎 お客様の条件」。
//
// 2026-09-30 竹内（朱莉さんの画面のスクショ）「ここにも分かりやすいようにお客さんの条件を入れておく。そうすればスタッフが見れるのと、
//   AIXツールの画面を監視するようになった際も分かりやすいので、ここにお客さんの物件探している条件を入れておく」
//   - 畳んだ時は2〜3行で要点（エリア・通勤／家賃・間取り・広さ・徒歩・築年数／入居時期・初期費用…）。タップで全部（札・要望・照らせない条件）
//   - 今回だけの一時調整（一番新しい回の search_override）は紫で「今回だけ」
//   - 画面の見張り（将来 AIXツールの画面を読む）のための目印: data-section="customer-conditions"・行ごとに data-cond-key／data-cond-value
//   - 整形は app/lib/customer-condition-view.ts（AIXツールのお客様の一覧と同じ関数）・要望の札は WantChips（同じ部品）
// 画面の部品なので、サーバー専用のライブラリは import しない（本番ビルドが落ちる）
import { useMemo, useState } from "react";
import { customerConditionItems, conditionHeadlineLines, type ConditionCustomerLike } from "@/app/lib/customer-condition-view";
import { itemizeWants, type WantsCustomerLike } from "@/app/lib/customer-wants";
import WantChips from "@/app/components/WantChips";

export default function PickupConditionsBar({ conditions, pcid, overrideLabel, summary, onEdit }: {
  /** property_customers の列（詳細 API の customer_conditions）。null＝お客様の条件と紐付いていない */
  conditions: Record<string, unknown> | null | undefined;
  pcid: string | null;
  /** 今回だけの一時調整（一番新しい回）。無ければ null */
  overrideLabel: string | null;
  /** 条件の要約と資料で照らせない条件（詳細 API の condition_summary） */
  summary?: { line: string; uncheckable: string[] } | null;
  /** ✏️ 条件編集（既存の編集を開く）。無ければボタンを出さない */
  onEdit?: (pcid: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => customerConditionItems(conditions as ConditionCustomerLike | null), [conditions]);
  const head = useMemo(() => conditionHeadlineLines(rows), [rows]);
  const wants = useMemo(() => (conditions ? itemizeWants(conditions as unknown as WantsCustomerLike) : []), [conditions]);
  const ngCount = wants.filter((w) => w.kind === "NG").length;
  // 畳んだ時は3行まで: 要点が3行ある時は要望は件数だけ3行目の後ろに・少ない時は要望の名前を1行で
  const wantCount = wants.length ? `要望 ${wants.length}件${ngCount ? `（NG ${ngCount}）` : ""}` : "";
  const wantLine = !wantCount ? "" : head.length >= 3 ? "" : `${wantCount}: ${wants.slice(0, 4).map((w) => w.label).join("・")}${wants.length > 4 ? "…" : ""}`;
  const headShown = wantCount && head.length >= 3 ? [...head.slice(0, 2), `${head[2]}・${wantCount}`] : head;
  const linked = !!conditions;

  return (
    <section data-section="customer-conditions" data-pcid={pcid ?? ""} aria-label="お客様の条件"
      className="shrink-0 border-b border-[#d1d7db] bg-white/95 px-3 py-2 shadow-sm">
      <div className="mx-auto w-full max-w-4xl">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span role="heading" aria-level={2} className="shrink-0 text-[12px] font-bold text-[#1565C0]">🔎 お客様の条件</span>
            {overrideLabel && (
              <span data-cond-override={overrideLabel} className="min-w-0 truncate rounded-full px-2 py-[1px] text-[10px] font-bold" style={{ background: "#ede7f6", color: "#4527a0" }}
                title="メモの検索の指示で、一番新しい回だけこの条件で検索・判定しました（登録の条件は変わっていません）">今回だけ: {overrideLabel}</span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-[#8696a0]">{open ? "▲ 閉じる" : "▼ 全部"}</span>
          </button>
          {onEdit && pcid && (
            <button type="button" onClick={() => onEdit(pcid)}
              className="shrink-0 rounded-full border border-[#1565C0]/30 bg-blue-50 px-2 py-[3px] text-[10px] font-bold text-[#1565C0] active:bg-blue-100">✏️ 条件編集</button>
          )}
        </div>
        {!linked ? (
          <p className="mt-0.5 text-[11px] text-[#90a4ae]">お客様の条件と紐付いていません</p>
        ) : !open ? (
          <button type="button" onClick={() => setOpen(true)} className="mt-0.5 block w-full text-left" data-cond-headline="">
            {head.length === 0 && !wantLine && <span className="block text-[11px] text-[#90a4ae]">条件が登録されていません</span>}
            {headShown.map((l, i) => <span key={i} className="block truncate text-[11px] leading-[1.45] text-[#111b21]">{l}</span>)}
            {wantLine && <span className="block truncate text-[10px] leading-[1.45] text-[#54656f]">{wantLine}</span>}
          </button>
        ) : (
          <div className="mt-1 max-h-[45vh] overflow-y-auto overscroll-contain pb-0.5">
            {rows.length === 0 && <p className="text-[11px] text-[#90a4ae]">条件が登録されていません</p>}
            <dl className="flex flex-wrap gap-1.5">
              {rows.map((r) => (
                <div key={r.key} data-cond-key={r.key} data-cond-value={r.value} className="flex max-w-full items-center gap-1 rounded-xl bg-[#f0f2f5] px-2.5 py-1 text-[11px]">
                  <dt className="shrink-0 font-medium text-[#8696a0]">{r.label}</dt>
                  <dd className="min-w-0 break-words font-semibold text-[#1565C0]">{r.value}</dd>
                </div>
              ))}
            </dl>
            <WantChips c={conditions as Record<string, unknown>} />
            {summary && (summary.line || summary.uncheckable.length > 0) && (
              <div className="mt-1.5 text-[10px] leading-snug" data-cond-summary="">
                {summary.line && <p className="break-words text-[#455a64]">📝 条件の要約: {summary.line}</p>}
                {summary.uncheckable.length > 0 && <p className="mt-0.5 break-words text-[#78909c]">資料で照らせない条件: {summary.uncheckable.join("／")}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
