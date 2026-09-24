"use client";
// 売上サポ「ピックアップ」: LINE の一覧と同じ形でお客様を並べ、タップすると会話風に開く。
//   左＝ブレイン（拡張が送った1回分の物件と判断・🌟オススメ）／右＝スタッフ（送った・見送り・メモ）
// 2026-09-24 竹内「紐づいているお客さんで LINE のチャット一覧のような UI。判断したのが LINE の会話風に送られる形。
//   DeepSeek 側は左・スタッフの会話は右。スタッフは確認してお客さんに送るだけ」
import { useCallback, useEffect, useMemo, useState } from "react";

const INTERNAL_AUTH_HEADER = { Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` };

type Item = {
  id: number; rank: number; property_name: string; room_no: string | null; summary_text: string;
  pdf_blob_url: string | null; pdf_has_text: boolean; verdict: string | null; score: number | null;
  reasons_ja: string[] | null; ad_yen: number | null; profit_yen: number | null; recommended: number; status: string; sent_at: string | null;
};
type Batch = { batch_id: string; created_at: string; site: string | null; conversation_id: string | null; items: Item[] };
type Note = { id: number; created_at: string; batch_id: string | null; text: string; author: string | null };
type Customer = { key: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; batches: Batch[]; notes: Note[]; pending: number; last_at: string };

const VERDICT_JA: Record<string, { label: string; color: string; bg: string }> = {
  pass: { label: "通す", color: "#1b5e20", bg: "#e8f5e9" },
  hold: { label: "保留", color: "#e65100", bg: "#fff3e0" },
  drop: { label: "外す候補", color: "#b71c1c", bg: "#ffebee" },
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 会話の1つ（左＝ブレイン／右＝スタッフ） */
type Bubble =
  | { kind: "brain"; at: string; batch: Batch }
  | { kind: "staff"; at: string; text: string; sub?: string };

function buildBubbles(c: Customer): Bubble[] {
  const out: Bubble[] = [];
  for (const b of c.batches) {
    out.push({ kind: "brain", at: b.created_at, batch: b });
    const sent = b.items.filter((it) => it.status === "sent");
    const skipped = b.items.filter((it) => it.status === "skipped");
    if (sent.length) {
      const at = sent.map((it) => it.sent_at ?? b.created_at).sort().slice(-1)[0];
      out.push({ kind: "staff", at, text: `${sent.length}件をお客様に送りました`, sub: sent.map((it) => `【${it.rank}】${it.property_name}`).join("・") });
    }
    if (skipped.length) out.push({ kind: "staff", at: b.created_at, text: `${skipped.length}件を見送り`, sub: skipped.map((it) => `【${it.rank}】${it.property_name}`).join("・") });
  }
  for (const n of c.notes) out.push({ kind: "staff", at: n.created_at, text: n.text });
  return out.sort((a, z) => a.at.localeCompare(z.at));
}

export default function PickupReview() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/property-pickups?days=30`, { cache: "no-store" });
      const json = await res.json() as { ok: boolean; customers?: Customer[]; error?: string };
      if (!json.ok) throw new Error(json.error || "取得に失敗");
      setCustomers(json.customers ?? []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = useMemo(() => customers.find((c) => c.key === openKey) ?? null, [customers, openKey]);
  const filtered = useMemo(() => customers.filter((c) => !q || (c.customer_name ?? "").includes(q)), [customers, q]);

  const openCustomer = (c: Customer) => {
    setOpenKey(c.key);
    // 既定のチェック: 未確認のうち「外す候補」以外
    const next: Record<number, boolean> = {};
    for (const b of c.batches) for (const it of b.items) next[it.id] = it.status === "pending" && it.verdict !== "drop";
    setChecked(next);
    setMsg("");
  };

  const act = async (c: Customer, b: Batch, action: "send" | "skip") => {
    const ids = b.items.filter((it) => checked[it.id] && it.status === "pending").map((it) => it.id);
    if (ids.length === 0) { setMsg("送る物件にチェックを入れてください"); return; }
    if (action === "send" && !c.conversation_id) { setMsg("このお客様は LINE の会話に紐付いていません（お客さん画面で紐付けてから）"); return; }
    if (action === "send" && !confirm(`${c.customer_name ?? "お客様"}さんに ${ids.length}件 送ります。よろしいですか？`)) return;
    setBusy(b.batch_id);
    try {
      const res = await fetch("/api/property-pickups/send", {
        method: "POST", headers: { "Content-Type": "application/json", ...INTERNAL_AUTH_HEADER },
        body: JSON.stringify({ batch_id: b.batch_id, item_ids: ids, action }),
      });
      const json = await res.json() as { ok: boolean; error?: string; sent?: number; skipped?: number };
      if (!json.ok) throw new Error(json.error || "失敗");
      setMsg(action === "send" ? `✅ ${json.sent}件 送りました` : `${json.skipped}件 見送りにしました`);
      await load();
    } catch (e) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const addNote = async (c: Customer) => {
    const text = note.trim();
    if (!text || !c.property_customer_id) return;
    setBusy("note");
    try {
      const res = await fetch("/api/property-pickups/notes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_customer_id: c.property_customer_id, batch_id: c.batches.slice(-1)[0]?.batch_id ?? null, text }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error || "失敗");
      setNote("");
      await load();
    } catch (e) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ── 会話画面 ──
  if (open) {
    const bubbles = buildBubbles(open);
    return (
      <div className="flex flex-col" style={{ minHeight: "60vh", background: "#eef3f7" }}>
        <div className="flex items-center gap-2 px-3 py-2 bg-white" style={{ borderBottom: "1px solid #e0e0e0" }}>
          <button onClick={() => setOpenKey(null)} className="text-[#1565C0] font-bold text-sm">‹ 戻る</button>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm truncate">{open.customer_name ?? "（名前なし）"}さん</div>
            <div className="text-[10px] text-[#78909c]">{open.conversation_id ? "LINE 紐付け済み" : "LINE 未紐付け（送れません）"}</div>
          </div>
          <button onClick={() => void load()} className="text-xs text-[#1565C0] font-bold">{loading ? "…" : "更新"}</button>
        </div>
        {msg && <div className="mx-3 mt-2 text-xs px-3 py-2 rounded-lg" style={{ background: "#e3f2fd", color: "#0d47a1" }}>{msg}</div>}
        <div className="flex-1 px-3 py-3 flex flex-col gap-3">
          {bubbles.map((bb, i) => bb.kind === "brain" ? (
            <div key={`b${i}`} className="flex items-end gap-2">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0" style={{ background: "#1565C0", color: "#fff" }}>🧠</div>
              <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-white px-3 py-2.5" style={{ boxShadow: "0 1px 2px rgba(0,0,0,.08)" }}>
                <div className="text-xs font-bold mb-1">ピックアップ {bb.batch.items.length}件（{bb.batch.site ?? "-"}）を確認しました</div>
                <div className="flex flex-col gap-2">
                  {bb.batch.items.map((it) => {
                    const v = it.verdict ? VERDICT_JA[it.verdict] : null;
                    const body = it.summary_text.replace(/^【\d+[^】]*】\s*/u, "").split("\n").filter(Boolean);
                    const pending = it.status === "pending";
                    return (
                      <label key={it.id} className="flex gap-2 items-start rounded-xl px-2 py-2" style={{ background: it.recommended > 0 ? "#fff8e1" : "#f7f9fb", opacity: pending ? 1 : 0.6 }}>
                        <input type="checkbox" className="mt-1" disabled={!pending} checked={!!checked[it.id]} onChange={(e) => setChecked((p) => ({ ...p, [it.id]: e.target.checked }))} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs font-bold">【{it.rank}】{it.property_name}{it.room_no ? ` ${it.room_no}号室` : ""}</span>
                            {it.recommended === 2 && <span className="text-[10px] font-bold" style={{ color: "#f57f17" }}>🌟★ 一番オススメ</span>}
                            {it.recommended === 1 && <span className="text-[10px] font-bold" style={{ color: "#f57f17" }}>🌟 オススメ</span>}
                            {v && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold" style={{ background: v.bg, color: v.color }}>{v.label}{it.score != null ? ` ${it.score}` : ""}</span>}
                            {!pending && <span className="text-[10px] text-[#90a4ae]">{it.status === "sent" ? "送信済" : "見送り"}</span>}
                          </div>
                          <div className="text-[11px] text-[#455a64] mt-0.5">{body.slice(0, 4).join(" / ")}</div>
                          {it.reasons_ja && it.reasons_ja.length > 0 && (
                            <div className="text-[10px] text-[#78909c] mt-0.5">{it.reasons_ja.slice(0, 3).join("・")}{it.profit_yen != null ? `・利益目安 ${it.profit_yen.toLocaleString()}円` : ""}</div>
                          )}
                          {it.pdf_blob_url && <a href={it.pdf_blob_url} target="_blank" rel="noreferrer" className="text-[11px] font-bold" style={{ color: "#1565C0" }}>📄 資料を見る{!it.pdf_has_text ? "（文字層なし）" : ""}</a>}
                        </div>
                      </label>
                    );
                  })}
                </div>
                {bb.batch.items.some((it) => it.status === "pending") && (
                  <div className="flex gap-2 mt-2">
                    <button disabled={busy === bb.batch.batch_id} onClick={() => void act(open, bb.batch, "send")}
                      className="flex-1 py-2 rounded-lg text-xs font-bold text-white" style={{ background: "#1565C0", opacity: busy === bb.batch.batch_id ? 0.6 : 1 }}>
                      確認してお客様に送る
                    </button>
                    <button disabled={busy === bb.batch.batch_id} onClick={() => void act(open, bb.batch, "skip")}
                      className="px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#eceff1", color: "#546e7a" }}>見送り</button>
                  </div>
                )}
                <div className="text-[10px] text-[#b0bec5] mt-1 text-right">{fmtWhen(bb.at)}</div>
              </div>
            </div>
          ) : (
            <div key={`s${i}`} className="flex items-end justify-end gap-2">
              <div className="max-w-[80%] rounded-2xl rounded-br-sm px-3 py-2" style={{ background: "#c8e6c9" }}>
                <div className="text-xs font-bold">{bb.text}</div>
                {bb.sub && <div className="text-[10px] text-[#455a64] mt-0.5">{bb.sub}</div>}
                <div className="text-[10px] text-[#78909c] mt-1 text-right">{fmtWhen(bb.at)}</div>
              </div>
            </div>
          ))}
          {bubbles.length === 0 && <div className="text-sm text-[#90a4ae] text-center py-10">まだ何もありません</div>}
        </div>
        <div className="flex gap-2 px-3 py-2 bg-white sticky bottom-0" style={{ borderTop: "1px solid #e0e0e0" }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="メモ（右側に残ります）" className="flex-1 text-sm px-3 py-2 rounded-full" style={{ border: "1px solid #cfd8dc" }}
            onKeyDown={(e) => { if (e.key === "Enter") void addNote(open); }} />
          <button disabled={busy === "note" || !note.trim()} onClick={() => void addNote(open)} className="px-4 py-2 rounded-full text-sm font-bold text-white" style={{ background: "#1565C0", opacity: note.trim() ? 1 : 0.5 }}>送信</button>
        </div>
      </div>
    );
  }

  // ── 一覧（LINE の一覧と同じ形） ──
  return (
    <div>
      <div className="px-4 pt-3 pb-2 bg-white flex items-center gap-2" style={{ borderBottom: "1px solid #e9edef" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="名前で検索..." className="flex-1 text-sm px-3 py-2 rounded-lg" style={{ background: "#f0f2f5", border: "none" }} />
        <button onClick={() => void load()} className="text-xs text-[#1565C0] font-bold">{loading ? "…" : "更新"}</button>
      </div>
      {msg && <div className="mx-4 mt-2 text-xs px-3 py-2 rounded-lg" style={{ background: "#e3f2fd", color: "#0d47a1" }}>{msg}</div>}
      {filtered.length === 0 && !loading && (
        <div className="text-sm text-[#90a4ae] py-10 text-center">ピックアップはまだありません（拡張ツールで「売上番長に送る」をすると、ここに並びます）</div>
      )}
      {filtered.map((c) => {
        const last = c.batches.slice(-1)[0];
        const rec = last?.items.find((it) => it.recommended === 2) ?? last?.items.find((it) => it.recommended === 1);
        const preview = last ? `🧠 ${last.items.length}件${rec ? `・🌟${rec.property_name}` : ""}` : "";
        return (
          <button key={c.key} onClick={() => openCustomer(c)} className="w-full text-left flex items-center gap-3 px-4 py-3 bg-white" style={{ borderBottom: "1px solid #f0f2f5" }}>
            <div className="w-11 h-11 rounded-full flex items-center justify-center text-lg shrink-0" style={{ background: "#e3f2fd" }}>🏠</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm truncate">{c.customer_name ?? "（名前なし）"}</span>
                {!c.conversation_id && <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "#ffebee", color: "#b71c1c" }}>LINE未紐付け</span>}
              </div>
              <div className="text-xs text-[#607d8b] truncate mt-0.5">{preview}</div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <span className="text-[11px] text-[#90a4ae]">{fmtWhen(c.last_at)}</span>
              {c.pending > 0 && <span className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded-full" style={{ background: "#1565C0" }}>{c.pending}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
