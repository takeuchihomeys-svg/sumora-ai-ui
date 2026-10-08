"use client";
// app/components/OutcomeConfirmBar.tsx — トークの上の小さい帯（2026-10-08 竹内さんの決定②④）
//   ② 申込から30日たった案件: 「結果を選んでください」→ 成約した／審査落ち・切り替え／キャンセル／まだ手続き中（14日後にまた聞く）
//      選んだ結果は deal_outcomes に確定で残る（毎日の作り直しで上書きされない・自動の成約より優先）
//   ④ 審査に出した形跡があるのに段階が申込でない: 「申込にする」（押すと状態を申込・審査中に変える＝今のステータスのメニューと同じ処理）
//   値は GET/POST /api/deal-outcomes/confirm（LLM なし）。失敗しても画面は落とさない（出さないだけ）。
//   ⚠ 画面の部品なので lib からは型・定数だけの outcome-confirm.ts だけ import する（サーバー専用の物は import しない）
import { useCallback, useEffect, useRef, useState } from "react";
import { CONFIRM_CHOICES, CONFIRM_CHOICE_LABEL, confirmHeadline, type ConfirmCandidate, type ConfirmChoice } from "../lib/outcome-confirm";

type Nudge = { kind: string; at: string; by: string; text: string };
type Props = {
  conversationId: string;
  /** 状態（conversations.status）。変わったら取り直す */
  status: string;
  authHeader: Record<string, string>;
  /** 「申込にする」を押した時（page の updateConversationStatus("applying")） */
  onSetApplying: () => void;
};

const DISMISS_KEY = "outcomeNudgeDismissed";
function readDismissed(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
}

export default function OutcomeConfirmBar({ conversationId, status, authHeader, onSetApplying }: Props) {
  const [confirm, setConfirm] = useState<ConfirmCandidate | null>(null);
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const [forId, setForId] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const authRef = useRef(authHeader);
  authRef.current = authHeader;

  const load = useCallback(async (cid: string, signal: AbortSignal) => {
    try {
      const r = await fetch(`/api/deal-outcomes/confirm?conversation_id=${encodeURIComponent(cid)}`, { headers: authRef.current, signal, cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { ok?: boolean; confirm?: ConfirmCandidate | null; nudge?: Nudge | null };
      if (signal.aborted) return;
      const dismissed = readDismissed();
      setConfirm(j.ok ? j.confirm ?? null : null);
      setNudge(j.ok && j.nudge && dismissed[cid] !== j.nudge.at ? j.nudge : null);
      setForId(cid);
    } catch {
      if (signal.aborted) return;
      setConfirm(null); setNudge(null); setForId(cid);
    }
  }, []);

  useEffect(() => {
    setDone(null);
    if (!conversationId) { setConfirm(null); setNudge(null); setForId(""); return; }
    const ac = new AbortController();
    void load(conversationId, ac.signal);
    return () => ac.abort();
  }, [conversationId, status, load]);

  const choose = async (choice: ConfirmChoice) => {
    if (!confirm || saving) return;
    setSaving(true);
    try {
      const r = await fetch("/api/deal-outcomes/confirm", {
        method: "POST",
        headers: { ...authRef.current, "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: confirm.conversationId, episode_no: confirm.episodeNo, choice }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setConfirm(null);
      setDone(choice === "screening_failed"
        ? "記録しました。別の物件を探す時は段階を「物件提案中」に戻してください"
        : choice === "pending" ? "記録しました（14日後にまた確認します）" : "記録しました");
      setTimeout(() => setDone(null), 6000);
    } catch {
      setDone("記録できませんでした。もう一度お試しください");
      setTimeout(() => setDone(null), 4000);
    } finally {
      setSaving(false);
    }
  };

  const dismissNudge = () => {
    if (!nudge) return;
    try { const d = readDismissed(); d[conversationId] = nudge.at; localStorage.setItem(DISMISS_KEY, JSON.stringify(d)); } catch { /* 保存できなくても今は閉じる */ }
    setNudge(null);
  };

  if (!conversationId || forId !== conversationId) return null;
  if (!confirm && !nudge && !done) return null;
  return (
    <div className="border-b border-[#d1d7db] bg-white/95 px-3 py-1.5 text-[11px] leading-snug">
      {done && <div className="text-[#54656f]">{done}</div>}
      {confirm && (
        <div className="rounded-lg bg-amber-50 px-2 py-1.5 text-amber-900">
          <div className="font-semibold">🔔 {confirmHeadline(confirm)}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {CONFIRM_CHOICES.map((c) => (
              <button
                key={c}
                disabled={saving}
                onClick={() => void choose(c)}
                className={`rounded-full border px-2 py-[3px] text-[11px] font-bold ${c === "won" ? "border-transparent bg-[#06C755] text-white" : "border-amber-300 bg-white text-amber-900"} disabled:opacity-50`}
              >
                {CONFIRM_CHOICE_LABEL[c]}
              </button>
            ))}
          </div>
        </div>
      )}
      {nudge && (
        <div className={`${confirm ? "mt-1 " : ""}flex items-center gap-1.5 rounded-lg bg-rose-50 px-2 py-1.5 text-rose-800`}>
          <span className="min-w-0 flex-1">📝 {nudge.text}</span>
          <button onClick={() => { onSetApplying(); setNudge(null); }} className="shrink-0 rounded-full bg-rose-600 px-2 py-[3px] text-[11px] font-bold text-white">申込にする</button>
          <button onClick={dismissNudge} className="shrink-0 rounded-full border border-rose-200 bg-white px-1.5 py-[3px] text-[11px] text-rose-700" title="審査に出していない時は閉じる（この形跡では出さない）">閉じる</button>
        </div>
      )}
    </div>
  );
}
