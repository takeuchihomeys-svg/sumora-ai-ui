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
  page_image_url: string | null; agent_image_url?: string | null; trim_image_url?: string | null; image_lines: string[] | null; image_facts: Record<string, boolean | null> | null;
};
type Batch = { batch_id: string; created_at: string; site: string | null; conversation_id: string | null; items: Item[] };
type Note = { id: number; created_at: string; batch_id: string | null; text: string; author: string | null };
type LineLite = { profile_image_url: string | null; updated_at: string | null; account: string | null; status: string | null; last_sender: string | null };
type Customer = { key: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; batches: Batch[]; notes: Note[]; pending: number; last_at: string; line?: LineLite | null; last_pickup_at?: string; order_at?: string };

/** LINE の一覧と同じアカウントの札（app/page.tsx の ACCOUNT_LIST と同じ表示名） */
const ACCOUNT_LABEL: Record<string, string> = { sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ賃貸", hasu: "ハス" };
function accountLabel(account: string | null | undefined): string { return ACCOUNT_LABEL[account ?? ""] ?? "スモラ"; }
function getInitial(name: string | null | undefined): string { const s = (name ?? "").trim(); return s ? Array.from(s)[0] : "？"; }
/** 日時（届いた日時をいつでも分かるように。今日は HH:MM・それ以外は M/D HH:MM） */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

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
  | { kind: "trim"; at: string; batch: Batch; items: Item[] }
  | { kind: "staff"; at: string; text: string; sub?: string };

/** 画像を手元に保存（別ドメインの画像は download 属性が効かないので、取ってきて Blob の URL で落とす。取れなければ新しいタブで開く） */
async function saveImage(url: string, name: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

function buildBubbles(c: Customer): Bubble[] {
  const out: Bubble[] = [];
  for (const b of c.batches) {
    out.push({ kind: "brain", at: b.created_at, batch: b });
    // 2026-09-24 竹内「トリミングした画像はピックアップの画面内に送られて、そのままスタッフが保存して使えるように」
    const trimmed = b.items.filter((it) => it.trim_image_url);
    if (trimmed.length) out.push({ kind: "trim", at: b.created_at + "~", batch: b, items: trimmed });
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

/** focusKey: 一覧の「🧠 物件 N件」から来た時に、そのお客様（property_customer_id）の会話風画面を最初から開く。onChange: 送った・見送りの後に親の件数を更新 */
export default function PickupReview({ focusKey = null, onChange }: { focusKey?: string | null; onChange?: () => void } = {}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(focusKey);
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
  // 一覧から来た時: 読み込めたらそのお客様を開き、未確認の物件に既定のチェックを入れる
  useEffect(() => {
    if (!focusKey) return;
    const c = customers.find((x) => x.key === focusKey);
    if (!c) return;
    setOpenKey(focusKey);
    const next: Record<number, boolean> = {};
    for (const b of c.batches) for (const it of b.items) next[it.id] = it.status === "pending" && it.verdict !== "drop";
    setChecked(next);
  }, [focusKey, customers]);

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
      onChange?.();
    } catch (e) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // 2026-09-24 竹内「画像トリミングボタンを付ける。押すと選択している物件の PDF 1枚目（弊社帯替え分）がトリミングされて画像となって送られる」
  //   ここでは切るだけ（切った画像が吹き出しに出る）。送るのは「確認してお客様に送る」（送信は必ずスタッフが確認してから）
  const trim = async (b: Batch) => {
    const targets = b.items.filter((it) => checked[it.id] && it.status === "pending");
    const ids = targets.map((it) => it.id);
    if (ids.length === 0) { setMsg("トリミングする物件にチェックを入れてください"); return; }
    setBusy(`trim:${b.batch_id}`);
    setMsg("✂️ トリミング中…（1件 数秒）");
    try {
      // 2026-09-24 竹内「元の物件資料をトリミングすれば良いだけ」: 元の資料をこのパソコンで描いて切る（いつも見ている資料と同じ見た目）。
      //   画面側で描けなかった物件だけ、サーバー側で描く予備に回す
      const { trimPdfPageInBrowser, blobToBase64 } = await import("@/app/lib/pdf-trim-browser");
      const images: Array<{ id: number; jpeg_base64: string }> = [];
      const fallbackIds: number[] = [];
      for (const it of targets) {
        if (!it.pdf_blob_url) { fallbackIds.push(it.id); continue; }
        try {
          const jpeg = await trimPdfPageInBrowser(it.pdf_blob_url);
          images.push({ id: it.id, jpeg_base64: await blobToBase64(jpeg) });
        } catch (e) {
          console.warn("[pickup] 画面で描けない → サーバーに回す:", it.id, e);
          fallbackIds.push(it.id);
        }
      }
      const post = (payload: object) => fetch("/api/property-pickups/trim", {
        method: "POST", headers: { "Content-Type": "application/json", ...INTERNAL_AUTH_HEADER },
        body: JSON.stringify(payload),
      });
      if (images.length > 0 && fallbackIds.length > 0) await post({ item_ids: fallbackIds, force: true });
      const res = images.length > 0
        ? await post({ images })
        : await post({ item_ids: fallbackIds, force: true });   // 押すたびに作り直す
      const json = await res.json() as { ok: boolean; trimmed?: number; items?: Array<{ id: number; error?: string }>; error?: string };
      if (!json.ok) throw new Error(json.error || json.items?.find((x) => x.error)?.error || "失敗");
      setMsg(`✂️ ${json.trimmed}件をお客様に送る形にトリミングしました。下の画像は「💾 保存」で手元に落とせます。「確認してお客様に送る」で送れます`);
      await load();
      onChange?.();
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
                {/* 2026-09-24 竹内「ブレインモードで売上サポに送った日時も出るようにする」 */}
                <div className="text-xs font-bold mb-0.5">ピックアップ {bb.batch.items.length}件（{bb.batch.site === "realpro" ? "リアプロ" : bb.batch.site ?? "-"}）を確認しました</div>
                <div className="text-[10px] text-[#78909c] mb-1">🧠 ブレインモードで {fmtDateTime(bb.batch.created_at)} に届きました</div>
                <div className="flex flex-col gap-2">
                  {bb.batch.items.map((it) => {
                    const v = it.verdict ? VERDICT_JA[it.verdict] : null;
                    const body = it.summary_text.replace(/^【\d+[^】]*】\s*/u, "").split("\n").filter(Boolean);
                    const pending = it.status === "pending";
                    return (
                      <label key={it.id} className="flex gap-2 items-start rounded-xl px-2 py-2" style={{ background: it.recommended > 0 ? "#fff8e1" : "#f7f9fb", opacity: pending ? 1 : 0.6 }}>
                        <input type="checkbox" className="mt-1" disabled={!pending} checked={!!checked[it.id]} onChange={(e) => setChecked((p) => ({ ...p, [it.id]: e.target.checked }))} />
                        {(it.trim_image_url || it.page_image_url) && (
                          <a href={it.trim_image_url ?? it.page_image_url ?? undefined} target="_blank" rel="noreferrer" className="shrink-0 relative" onClick={(e) => e.stopPropagation()}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={it.trim_image_url ?? it.page_image_url ?? undefined} alt="" className="rounded-md object-cover" style={{ width: 88, height: it.trim_image_url ? 62 : 64, border: "1px solid #e0e0e0", background: "#fff" }} />
                            {it.trim_image_url && <span className="absolute -top-1 -left-1 text-[9px] font-bold px-1 rounded" style={{ background: "#6a1b9a", color: "#fff" }}>✂️ 送る形</span>}
                          </a>
                        )}
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
                          {it.image_lines && it.image_lines.length > 0 && (
                            <div className="text-[10px] mt-0.5" style={{ color: "#37474f" }}>📷 {it.image_lines.slice(0, 5).join("／")}</div>
                          )}
                          <div className="flex gap-2 flex-wrap">
                            {it.pdf_blob_url && <a href={it.pdf_blob_url} target="_blank" rel="noreferrer" className="text-[11px] font-bold" style={{ color: "#1565C0" }}>📄 資料を見る{!it.pdf_has_text ? "（文字層なし）" : ""}</a>}
                            {/* 偶数ページ＝元付業者の資料（AD の記載・ブレインが読んだ側）。お客様には送らない */}
                            {it.agent_image_url && <a href={it.agent_image_url} target="_blank" rel="noreferrer" className="text-[11px] font-bold" style={{ color: "#6a1b9a" }}>🏢 元付の資料</a>}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
                {bb.batch.items.some((it) => it.status === "pending") && (
                  <div className="flex gap-2 mt-2">
                    <button disabled={busy === `trim:${bb.batch.batch_id}`} onClick={() => void trim(bb.batch)}
                      title="選んだ物件の PDF 1ページ目（弊社帯替え）を、お客様に送っている形（会社の帯なし）に切る"
                      className="px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#f3e5f5", color: "#6a1b9a", opacity: busy === `trim:${bb.batch.batch_id}` ? 0.6 : 1 }}>
                      {busy === `trim:${bb.batch.batch_id}` ? "✂️ …" : "✂️ 画像トリミング"}
                    </button>
                    <button disabled={busy === bb.batch.batch_id} onClick={() => void act(open, bb.batch, "send")}
                      className="flex-1 py-2 rounded-lg text-xs font-bold text-white" style={{ background: "#1565C0", opacity: busy === bb.batch.batch_id ? 0.6 : 1 }}>
                      確認してお客様に送る
                    </button>
                    <button disabled={busy === bb.batch.batch_id} onClick={() => void act(open, bb.batch, "skip")}
                      className="px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#eceff1", color: "#546e7a" }}>見送り</button>
                  </div>
                )}
                <div className="text-[10px] text-[#b0bec5] mt-1 text-right">{fmtDateTime(bb.at)}</div>
              </div>
            </div>
          ) : bb.kind === "trim" ? (
            <div key={`t${i}`} className="flex items-end gap-2">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0" style={{ background: "#6a1b9a", color: "#fff" }}>✂️</div>
              <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-white px-3 py-2.5" style={{ boxShadow: "0 1px 2px rgba(0,0,0,.08)" }}>
                <div className="text-xs font-bold mb-1">✂️ お客様に送る形にした画像 {bb.items.length}枚（会社の帯なし）</div>
                <div className="flex flex-col gap-2">
                  {bb.items.map((it) => (
                    <div key={`ti${it.id}`} className="rounded-xl overflow-hidden" style={{ border: "1px solid #e0e0e0" }}>
                      <a href={it.trim_image_url ?? undefined} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={it.trim_image_url ?? undefined} alt={it.property_name} className="w-full block" style={{ maxWidth: 560, background: "#fff" }} />
                      </a>
                      <div className="flex items-center justify-between px-2 py-1.5" style={{ background: "#f7f9fb" }}>
                        <span className="text-[11px] font-bold truncate">【{it.rank}】{it.property_name}{it.room_no ? ` ${it.room_no}号室` : ""}</span>
                        <button onClick={() => void saveImage(it.trim_image_url as string, `${it.property_name}${it.room_no ? `_${it.room_no}` : ""}.jpg`)}
                          className="text-[11px] font-bold px-2 py-1 rounded-lg shrink-0" style={{ background: "#6a1b9a", color: "#fff" }}>💾 保存</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-[#b0bec5] mt-1 text-right">「確認してお客様に送る」はこの画像を送ります</div>
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
      {/* 2026-09-24 竹内「ピックアップの一覧は LINE と同じ UI にする（アイコンも付ける）。順番も LINE と同じに連動」:
          行の形は app/page.tsx の LINE 一覧（アイコン・名前＋アカウント札・1行目のプレビュー・右に時刻と緑の件数）と同じ。並びは API が LINE の updated_at 順で返す */}
      {filtered.map((c) => {
        const last = c.batches.slice(-1)[0];
        const rec = last?.items.find((it) => it.recommended === 2) ?? last?.items.find((it) => it.recommended === 1);
        const preview = last ? `🧠 ${last.items.length}件${rec ? `・🌟${rec.property_name}` : ""}` : "";
        const pickupAt = c.last_pickup_at ?? last?.created_at ?? c.last_at;
        const img = c.line?.profile_image_url ?? null;
        return (
          <button key={c.key} onClick={() => openCustomer(c)}
            className={`flex w-full items-center gap-3 px-4 py-[18px] text-left transition border-l-[3px] ${c.pending > 0 ? "border-orange-400 bg-orange-50 hover:bg-orange-100" : "border-transparent bg-white hover:bg-[#f5f6f6]"}`}
            style={{ borderBottom: "1px solid #f0f2f5" }}>
            <div className="relative shrink-0">
              {img ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img} alt="" className="h-12 w-12 rounded-full object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#d9fdd3] text-base font-bold text-[#0f8f44]">{getInitial(c.customer_name)}</div>
              )}
              <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white text-[11px]" style={{ background: "#1565C0" }}>🧠</span>
            </div>
            <div className="relative min-w-0 flex-1 pr-12">
              <div className="absolute right-0 top-0 flex flex-col items-end gap-1">
                <span className="text-[11px] text-[#667781]" title={`売上サポに届いた日時 ${fmtDateTime(pickupAt)}`}>{fmtWhen(pickupAt)}</span>
                {c.pending > 0 && (
                  <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#06C755] px-1 text-[11px] font-bold text-white leading-none">{c.pending}</span>
                )}
              </div>
              <div className="mb-0.5 flex h-5 min-w-0 items-center gap-1.5 overflow-hidden">
                <span className="truncate text-[14px] font-medium text-[#111b21]">{c.customer_name ?? "（名前なし）"}</span>
                <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-bold text-gray-400">{accountLabel(c.line?.account)}</span>
                {c.pending > 0 && <span className="shrink-0 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-600">未確認</span>}
                {!c.conversation_id && <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "#ffebee", color: "#b71c1c" }}>LINE未紐付け</span>}
              </div>
              <div className="truncate text-[13px] text-[#667781]">{preview}<span className="ml-1 text-[11px] text-[#b0bec5]">（{fmtDateTime(pickupAt)} ブレインモード）</span></div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
