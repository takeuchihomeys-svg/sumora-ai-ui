"use client";
// 2026-09-29 竹内「その他の項目で1つ1つまとめる（ガスコンロ・カウンターキッチン・リビング○帖以上・初期費用○円以内 等）…見て分かりやすいように」
// 2026-09-30 AIXツールのお客様の一覧（conditions/page.tsx）と売上サポの一番上の「🔎 お客様の条件」（PickupConditionsBar）で同じ札を使うため、ここへ移した
import { itemizeWants, type WantsCustomerLike, type WantKind } from "@/app/lib/customer-wants";

/**
 * お客様の要望の項目（設備／NG／その他）を1つ1つの札で見せる（純関数 customer-wants.itemizeWants・欄の文から毎回作る）。
 *   札の色: 設備＝緑・NG＝赤・その他＝灰。「採点外」＝採点の札が無い要望（抜けが見える）・🔍＝画像で確かめる対象・🔎検索＝拡張の検索の入力に入る
 */
export default function WantChips({ c }: { c: Record<string, unknown> }) {
  const items = itemizeWants(c as unknown as WantsCustomerLike);
  if (!items.length) return null;
  const cls = (k: WantKind) => (k === "設備" ? "bg-emerald-50 border-emerald-300 text-emerald-900" : k === "NG" ? "bg-rose-50 border-rose-300 text-rose-900" : "bg-slate-50 border-slate-300 text-slate-700");
  return (
    <div className="flex flex-wrap gap-1 pt-1" aria-label="要望の項目" data-cond-wants={items.length}>
      {items.map((w) => (
        <span key={w.key} data-want-kind={w.kind} data-want-label={w.label}
          title={`${w.kind}｜出所: ${w.source}｜採点: ${w.scoring ?? "効いていない"}${w.image ? "｜画像で確かめる" : ""}${w.search ? "｜検索の入力に入る" : ""}`}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 max-w-full ${cls(w.kind)} ${w.note ? "opacity-60" : ""}`}>
          <span className="text-[9px] opacity-70 shrink-0">{w.kind}</span>
          <span className="truncate">{w.label}{w.strong ? "[必須]" : ""}{w.soft ? "（できれば）" : ""}</span>
          {!w.scoring && !w.note ? <span className="text-[9px] text-amber-700 shrink-0">採点外</span> : null}
          {w.image ? <span className="text-[9px] shrink-0">🔍</span> : null}
          {w.search ? <span className="text-[9px] shrink-0">🔎検索</span> : null}
        </span>
      ))}
    </div>
  );
}
