"use client";
// app/components/ConditionHistoryBand.tsx — 会話画面の「条件の更新」（ブレイン自動反映・画面で直した・条件フォーム・元に戻した）の履歴
//   2026-10-13 竹内さん（未桜）「ブレイン自動反映のところも大きくて枠を取りすぎている。ちゃんと折りたたんで、更新があった時に日時を入れて記憶していけば見やすい」:
//   ・TopBandsFold の中に置く＝既定は札1行「条件の更新 10/12 22:41」（data-fold-label）。未確認の更新がある時だけ数を付ける
//   ・押すと履歴を日時付きで新しい順（何が何から何に変わったか・誰が）。元に戻す・確認済みは行ごと
//   ・履歴は property_condition_history（GET /api/property-customers/condition-history）。元に戻すは /undo-condition-change に group を付ける
//   ・additional_conditions の自動反映の知らせ（[M/D HH:MM|auto] …）は履歴の上に「お知らせ」として出す（確認済みで消える＝今までと同じ）
// ⚠ サーバー専用ライブラリを import しない（condition-restore.ts は純関数・型だけ使う）
import { useEffect, useState } from "react";
import type { ConditionHistoryGroup } from "../lib/condition-restore";

type Props = {
  pcId: string;
  /** property_customers.additional_conditions（auto/format の行＝自動反映の知らせ） */
  autoNotices: Array<{ timestamp: string; content: string }>;
  /** 取り直しの合図（会話の最後の通の id 等） */
  refreshKey: string;
  onCustomerPatched: (customer: Record<string, unknown>) => void;
  onNoticeCleared: () => void;
};

const SHOW_DAYS = 30;
const jst = (iso: string) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const short = (v: string | null) => {
  const s = String(v ?? "").trim();
  if (!s) return "（空）";
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

export default function ConditionHistoryBand({ pcId, autoNotices, refreshKey, onCustomerPatched, onNoticeCleared }: Props) {
  const [groups, setGroups] = useState<ConditionHistoryGroup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  // 確認済みの列（property_condition_history.confirmed_at）が本番にあるか。無い間は未確認の数を知らせ（additional_conditions）で数える
  const [persisted, setPersisted] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await fetch(`/api/property-customers/condition-history?id=${encodeURIComponent(pcId)}`, { cache: "no-store", signal: ac.signal });
        const d = (await r.json()) as { groups?: ConditionHistoryGroup[]; persisted?: boolean };
        setGroups(Array.isArray(d.groups) ? d.groups : []);
        setPersisted(!!d.persisted);
      } catch { /* 出さない */ }
    })();
    return () => ac.abort();
  }, [pcId, refreshKey, tick]);

  const recent = groups.filter((g) => Date.now() - Date.parse(g.at) <= SHOW_DAYS * 86_400_000);
  if (!recent.length && !autoNotices.length) return null;
  const unconfirmed = persisted ? recent.filter((g) => !g.confirmed).length : autoNotices.length;
  // 札の日時: 一番新しい更新（履歴か知らせの新しい方。知らせは「M/D HH:MM」の文字のまま）
  const latestLabel = recent[0] ? jst(recent[0].at) : autoNotices[autoNotices.length - 1]?.timestamp ?? "";

  const undo = async (g: ConditionHistoryGroup) => {
    if (!window.confirm(`${jst(g.at)} の変更（${g.changes.map((c) => c.label).join("・")}）を元に戻しますか？`)) return;
    setBusy(g.key); setMsg("");
    try {
      const r = await fetch("/api/property-customers/undo-condition-change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: pcId, group: g.key }) });
      const j = (await r.json()) as { changed?: Record<string, unknown>; skipped?: string[]; customer?: Record<string, unknown> | null; error?: string };
      if (!r.ok) throw new Error(j.error ?? String(r.status));
      if (j.customer) onCustomerPatched(j.customer);
      if (!j.changed || !Object.keys(j.changed).length) setMsg(`戻す変更がありませんでした${j.skipped?.length ? `（${j.skipped.join("・")}）` : ""}`);
      setTick((n) => n + 1);
    } catch { setMsg("⚠️ 条件を元に戻せませんでした"); }
    finally { setBusy(null); }
  };
  const confirm = async (g: ConditionHistoryGroup) => {
    setBusy(g.key); setMsg("");
    try {
      const r = await fetch("/api/property-customers/condition-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: pcId, group: g.key }) });
      const j = (await r.json()) as { clearedNotice?: boolean; persisted?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? String(r.status));
      if (j.clearedNotice) onNoticeCleared();
      if (j.persisted) setTick((n) => n + 1);
      else setGroups((prev) => prev.map((x) => (Date.parse(x.at) <= Date.parse(g.at) ? { ...x, confirmed: true } : x)));
    } catch { setMsg("⚠️ 確認済みにできませんでした"); }
    finally { setBusy(null); }
  };
  const clearNotices = async () => {
    setBusy("notice");
    try {
      await fetch("/api/property-customers", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: pcId, additional_conditions: null }) });
      onNoticeCleared();
    } catch { setMsg("⚠️ 確認済みにできませんでした"); }
    finally { setBusy(null); }
  };

  return (
    <div className="border-b border-[#c5cae9] bg-[#f5f6ff] px-3 py-1.5 md:px-4"
      data-fold-label={`条件の更新${latestLabel ? ` ${latestLabel}` : ""}`}
      data-fold-count={unconfirmed > 0 ? unconfirmed : undefined} data-fold-tone="blue">
      <p className="mb-1 text-[11px] font-bold text-[#283593]">条件の更新（新しい順）</p>
      {autoNotices.length > 0 && (
        <div className="mb-1.5 rounded-lg border border-[#c5cae9] bg-white px-2 py-1">
          {autoNotices.slice(-3).reverse().map((n, i) => (
            <p key={i} className="text-[11px] leading-snug text-[#283593]"><span className="mr-1 text-[10px] text-[#7986cb]">{n.timestamp}</span>{n.content}</p>
          ))}
          <div className="mt-0.5 flex items-center justify-between">
            <span className="text-[10px] text-[#7986cb]">ブレインが自動で DB に反映済みのお知らせ</span>
            <button type="button" disabled={busy === "notice"} onClick={() => void clearNotices()} className="text-[10px] font-bold text-[#5c6bc0] active:opacity-60 disabled:opacity-50">確認済み</button>
          </div>
        </div>
      )}
      {recent.map((g) => (
        <div key={g.key} className="flex items-start gap-2 border-t border-[#e8eaf6] py-1 first:border-t-0">
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] text-[#7986cb]">{jst(g.at)}・{g.writerJa}{g.confirmed ? "・確認済み" : ""}</span>
            {g.changes.map((c) => (
              <span key={c.field} className="block text-[11px] leading-snug text-[#1a237e]">{c.label}: {short(c.old)} → {short(c.new)}</span>
            ))}
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            {g.undoable && (
              <button type="button" disabled={busy === g.key} onClick={() => void undo(g)} className="rounded-full border border-[#9fa8da] bg-white px-2 py-0.5 text-[10px] font-bold text-[#3949ab] active:opacity-60 disabled:opacity-50">元に戻す</button>
            )}
            {!g.confirmed && (
              <button type="button" disabled={busy === g.key} onClick={() => void confirm(g)} className="text-[10px] font-bold text-[#5c6bc0] active:opacity-60 disabled:opacity-50">確認済み</button>
            )}
          </span>
        </div>
      ))}
      {msg && <p className="mt-1 text-[10px] font-bold text-red-600">{msg}</p>}
    </div>
  );
}
