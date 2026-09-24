"use client";
// 売上サポ「ピックアップ」: LINE の一覧と同じ形でお客様を並べ、タップすると会話風に開く。
//   左＝ブレイン（拡張が送った1回分の物件と判断・🌟オススメ）／右＝スタッフ（送った・見送り・メモ）
// 2026-09-24 竹内「紐づいているお客さんで LINE のチャット一覧のような UI。判断したのが LINE の会話風に送られる形。
//   DeepSeek 側は左・スタッフの会話は右。スタッフは確認してお客さんに送るだけ」
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const INTERNAL_AUTH_HEADER = { Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` };

type Item = {
  id: number; rank: number; property_name: string; room_no: string | null; summary_text: string;
  pdf_blob_url: string | null; pdf_has_text: boolean; verdict: string | null; score: number | null;
  reasons_ja: string[] | null; ad_yen: number | null; profit_yen: number | null; recommended: number; status: string; sent_at: string | null;
  page_image_url: string | null; agent_image_url?: string | null; trim_image_url?: string | null; image_lines: string[] | null; image_facts: Record<string, boolean | null> | null;
  image_analysis?: { match?: number | null; [k: string]: unknown } | null;
};
type Batch = { batch_id: string; created_at: string; site: string | null; conversation_id: string | null; items: Item[] };
type Note = { id: number; created_at: string; batch_id: string | null; text: string; author: string | null };
type LineLite = { profile_image_url: string | null; updated_at: string | null; account: string | null; status: string | null; last_sender: string | null };
type SentHist = { id: string; property_name: string; room_no: string | null; channel: string | null; delivery: string | null; source: string | null; sent_at: string; image_url: string | null; pickup_id: number | null };
type Customer = { key: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; batches: Batch[]; notes: Note[]; pending: number; last_at: string; line?: LineLite | null; last_pickup_at?: string; order_at?: string; sent_history?: SentHist[]; has_more_batches?: boolean };
/** 一覧の行（軽い要約だけ。画像・本文は開いた時に読む） */
type ListCustomer = {
  key: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null;
  pending: number; last_pickup_at: string | null; batch_count: number; last_batch: { batch_id: string; count: number; rec_name: string | null } | null;
  sent: { pickup: number; recommendation: number; other: number; last_at: string | null }; line: LineLite | null; last_at: string; order_at: string;
};
/** 送った経路の表示（sent_properties.channel・無ければ source から） */
function channelLabel(h: { channel: string | null; delivery: string | null; source: string | null }): { label: string; color: string; bg: string } {
  const shared = h.delivery === "shared" || (h.delivery == null && h.source === "line_group");
  if (shared) return { label: "⚪ グループ共有のみ", color: "#607d8b", bg: "#eceff1" };
  const ch = h.channel ?? (h.source === "aix:property_send" ? "pickup" : h.source === "aix:property_recommendation" ? "recommendation" : h.source === "aix:property_check_result" ? "check" : h.source === "aix:estimate_sheet" ? "estimate" : h.source === "staff_image" ? "staff_image" : null);
  if (ch === "pickup") return { label: "🟢 ピックアップで送信", color: "#1b5e20", bg: "#e8f5e9" };
  if (ch === "recommendation") return { label: "🔵 オススメで送信", color: "#0d47a1", bg: "#e3f2fd" };
  if (ch === "check") return { label: "物件確認で送信", color: "#4a148c", bg: "#f3e5f5" };
  if (ch === "estimate") return { label: "見積書で送信", color: "#e65100", bg: "#fff3e0" };
  if (ch === "staff_image") return { label: "手で送信", color: "#37474f", bg: "#eceff1" };
  return { label: "送信（経路不明）", color: "#546e7a", bg: "#f5f5f5" };
}

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
  | { kind: "analysis"; at: string; batch: Batch; items: Item[]; bestId: number | null }
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
    // 🔍 画像で分析の結果（一番合う物件＝点が最大・同点は順位が上）
    const analyzed = b.items.filter((it) => it.image_analysis);
    if (analyzed.length) {
      const scored = analyzed.filter((it) => typeof (it.image_analysis as { match?: unknown })?.match === "number");
      const m = (x: Item) => (x.image_analysis as { match: number }).match;
      const raw = (x: Item) => Number((x.image_analysis as { match_raw?: number | null }).match_raw ?? 0);
      // 同点（全件が必須 NG で 20 点など）は上限前の点で並べる（pickup-image-analysis.pickBest と同じ）
      const best = scored.slice().sort((a, z) => (m(z) - m(a)) || (raw(z) - raw(a)) || (a.rank - z.rank))[0];
      out.push({ kind: "analysis", at: b.created_at + "~~", batch: b, items: analyzed, bestId: best?.id ?? null });
    }
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
  // 2026-09-24 竹内「開くとき重いのは画像を全部読み取っているから。お客さんの詳細を開いた時に読み込まれるように。
  //   全て読み込むと重いから限定して読み込む。並びは LINE の一覧と連動して変わる。UI の幅も LINE の一覧と同じ」:
  //   一覧は要約だけ（view=list・30秒ごと＋画面に戻った時に取り直す＝LINE の並びに追従）。
  //   開いたお客様だけ詳細（view=detail・直近3回分＋送った履歴）。画像は loading=lazy・小さく出し、押すと原寸
  const [list, setList] = useState<ListCustomer[]>([]);
  const [detail, setDetail] = useState<Customer | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(focusKey);
  const [nBatches, setNBatches] = useState(3);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [q, setQ] = useState("");
  const openRef = useRef<{ key: string; pcid: string | null; conv: string | null } | null>(null);
  const nBatchesRef = useRef(3);

  const loadList = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`/api/property-pickups?view=list&days=30`, { cache: "no-store" });
      const json = await res.json() as { ok: boolean; customers?: ListCustomer[]; error?: string };
      if (!json.ok) throw new Error(json.error || "取得に失敗");
      setList(json.customers ?? []);
    } catch (e) {
      if (!quiet) setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (target: { key: string; pcid: string | null; conv: string | null }, n: number, resetChecks: boolean) => {
    setDetailLoading(true);
    try {
      const qs = target.pcid ? `pcid=${encodeURIComponent(target.pcid)}` : `conv=${encodeURIComponent(target.conv ?? "")}`;
      const res = await fetch(`/api/property-pickups?view=detail&${qs}&batches=${n}`, { cache: "no-store" });
      const json = await res.json() as { ok: boolean; customer?: Customer; error?: string };
      if (!json.ok || !json.customer) throw new Error(json.error || "取得に失敗");
      if (openRef.current?.key !== target.key) return;   // 読み込み中に別のお客様を開いた
      setDetail({ ...json.customer, key: target.key });
      if (resetChecks) {
        // 既定のチェック: 未確認のうち「外す候補」以外
        const next: Record<number, boolean> = {};
        for (const b of json.customer.batches) for (const it of b.items) next[it.id] = it.status === "pending" && it.verdict !== "drop";
        setChecked(next);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /** 操作の後に一覧と開いている詳細を取り直す（旧 load と同じ呼び方） */
  const load = useCallback(async () => {
    await Promise.all([
      loadList(true),
      openRef.current ? loadDetail(openRef.current, nBatchesRef.current, false) : Promise.resolve(),
    ]);
  }, [loadList, loadDetail]);

  useEffect(() => { void loadList(); }, [loadList]);
  // LINE の一覧の並びに追従（30秒ごと・画面に戻った時）
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void loadList(true); };
    const id = window.setInterval(tick, 30_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, [loadList]);

  const openCustomer = (c: { key: string; property_customer_id: string | null; conversation_id: string | null }) => {
    const target = { key: c.key, pcid: c.property_customer_id, conv: c.conversation_id };
    openRef.current = target;
    nBatchesRef.current = 3;
    setNBatches(3);
    setOpenKey(c.key);
    setDetail(null);
    setChecked({});
    setMsg("");
    void loadDetail(target, 3, true);
  };
  const closeDetail = () => { openRef.current = null; setOpenKey(null); setDetail(null); };
  const loadMoreBatches = () => {
    if (!openRef.current) return;
    const n = nBatchesRef.current + 5;
    nBatchesRef.current = n;
    setNBatches(n);
    void loadDetail(openRef.current, n, false);
  };

  // 一覧から来た時（アナウンス／一覧の「🧠 物件 N件」）: 一覧が読めたらそのお客様を開く
  const focusDone = useRef(false);
  useEffect(() => {
    if (!focusKey || focusDone.current) return;
    const c = list.find((x) => x.key === focusKey || x.property_customer_id === focusKey);
    if (!c) return;
    focusDone.current = true;
    openCustomer(c);
  }, [focusKey, list]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = detail;
  const filtered = useMemo(() => list.filter((c) => !q || (c.customer_name ?? "").includes(q)), [list, q]);

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
  const trim = async (b: Batch, only?: Item[]): Promise<boolean> => {
    const targets = only ?? b.items.filter((it) => checked[it.id] && it.status === "pending");
    const ids = targets.map((it) => it.id);
    if (ids.length === 0) { setMsg("トリミングする物件にチェックを入れてください"); return false; }
    setBusy(`trim:${b.batch_id}`);
    setMsg("✂️ 物件資料を画像にしています…（1件 数秒）");
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
      setMsg(`✂️ ${json.trimmed}件の物件資料を画像にしました。下の画像は「💾 保存」で手元に落とせます。「📤 AIXで送る」で送れます`);
      await load();
      onChange?.();
      return true;
    } catch (e) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setBusy(null);
    }
  };

  // 2026-09-24 竹内「画像で分析ボタンを付ける。お客さんの要望【水回り・キッチン・リビングと洋室の位置関係・収納（WIC 等）】を判断できる。
  //   トリミングした画像の中で一番条件に合った物件がわかる」→ 画像が無い物件は先に画像にしてから DeepSeek が読む
  const analyze = async (b: Batch) => {
    let targets = b.items.filter((it) => checked[it.id] && it.status === "pending");
    if (targets.length === 0) { setMsg("分析する物件にチェックを入れてください"); return; }
    const noImage = targets.filter((it) => !it.trim_image_url && !it.page_image_url);
    if (noImage.length > 0 && !(await trim(b, noImage))) return;
    targets = targets.map((it) => it);
    setBusy(`analyze:${b.batch_id}`);
    setMsg(`🔍 ${targets.length}件の資料を画像で分析しています…（1件 30〜40秒・並列）`);
    try {
      const res = await fetch("/api/property-pickups/analyze", {
        method: "POST", headers: { "Content-Type": "application/json", ...INTERNAL_AUTH_HEADER },
        body: JSON.stringify({ item_ids: targets.map((it) => it.id) }),
      });
      const json = await res.json() as { ok: boolean; best_id?: number | null; items?: Array<{ id: number; property_name: string; error?: string }>; error?: string };
      if (!json.ok) throw new Error(json.error || json.items?.find((x) => x.error)?.error || "分析できなかった");
      const best = json.items?.find((x) => x.id === json.best_id);
      setMsg(`🔍 分析しました${best ? `。一番条件に合うのは「${best.property_name}」` : ""}`);
      await load();
    } catch (e) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // 2026-09-24 竹内「確認してお客様に送るの部分を AIX で送るにして。押したら AIX の物件ピックアップに選択した画像がセットされた状態にする
  //   （トリミングされた画像＝PDF 1枚目の弊社帯替え用が送られる形）。元付業者の資料は送られないようにする」
  //   → 画像が無い物件は先に画像にし、LINE の会話画面を AIX【物件ピックアップした】に画像をセットして開く（/?conv=…&aix=property_send&pickup=ids）
  const sendViaAix = async (c: Customer, b: Batch) => {
    const targets = b.items.filter((it) => checked[it.id] && it.status === "pending");
    if (targets.length === 0) { setMsg("送る物件にチェックを入れてください"); return; }
    const convId = c.conversation_id ?? b.conversation_id;
    if (!convId) { setMsg("このお客様は LINE の会話に紐付いていません（お客さん画面で紐付けてから）"); return; }
    const noImage = targets.filter((it) => !it.trim_image_url);
    if (noImage.length > 0 && !(await trim(b, noImage))) return;
    const ids = targets.map((it) => it.id).join(",");
    window.location.href = `/?conv=${encodeURIComponent(convId)}&aix=property_send&pickup=${encodeURIComponent(ids)}&batch=${encodeURIComponent(b.batch_id)}`;
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

  // ── 会話画面（右の列。開いたお客様1人分だけ） ──
  const detailView = open ? (() => {
    const bubbles = buildBubbles(open);
    const hist = open.sent_history ?? [];
    const histCustomer = hist.filter((h) => !(h.delivery === "shared" || (h.delivery == null && h.source === "line_group")));
    const histShared = hist.length - histCustomer.length;
    return (
      <div className="flex flex-col h-full" style={{ background: "#eef3f7" }}>
        <div className="flex items-center gap-2 px-3 py-2 bg-white shrink-0" style={{ borderBottom: "1px solid #e0e0e0" }}>
          <button onClick={closeDetail} className="text-[#1565C0] font-bold text-sm md:hidden">‹ 戻る</button>
          {open.line?.profile_image_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={open.line.profile_image_url} alt="" loading="lazy" className="h-9 w-9 rounded-full object-cover shrink-0" />
            : <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#d9fdd3] text-sm font-bold text-[#0f8f44] shrink-0">{getInitial(open.customer_name)}</div>}
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm truncate">{open.customer_name ?? "（名前なし）"}さん</div>
            <div className="text-[10px] text-[#78909c]">{open.conversation_id ? "LINE 紐付け済み" : "LINE 未紐付け（送れません）"}</div>
          </div>
          {open.conversation_id && <a href={`/?conv=${encodeURIComponent(open.conversation_id)}`} className="text-xs text-[#06C755] font-bold">LINE を開く</a>}
          <button onClick={() => void load()} className="text-xs text-[#1565C0] font-bold">{detailLoading ? "…" : "更新"}</button>
        </div>
        {msg && <div className="mx-3 mt-2 text-xs px-3 py-2 rounded-lg shrink-0" style={{ background: "#e3f2fd", color: "#0d47a1" }}>{msg}</div>}
        <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
          {/* 2026-09-24 竹内「開くと履歴が見れる」: このお客様に送った物件（物件送った表・経路つき） */}
          {hist.length > 0 && (
            <details className="rounded-2xl bg-white px-3 py-2" style={{ boxShadow: "0 1px 2px rgba(0,0,0,.08)" }}>
              <summary className="text-xs font-bold cursor-pointer">📦 送った物件の履歴　お客様に送付 {histCustomer.length}件{histShared ? `・グループ共有のみ ${histShared}件` : ""}（直近40件）</summary>
              <div className="mt-2 flex flex-col gap-1">
                {hist.map((h) => {
                  const ch = channelLabel(h);
                  return (
                    <div key={h.id} className="flex items-center gap-2 text-[11px]">
                      <span className="text-[#90a4ae] shrink-0 tabular-nums">{fmtDateTime(h.sent_at)}</span>
                      <span className="truncate flex-1">{h.property_name}{h.room_no ? ` ${h.room_no}` : ""}</span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold" style={{ background: ch.bg, color: ch.color }}>{ch.label}</span>
                    </div>
                  );
                })}
              </div>
            </details>
          )}
          {open.has_more_batches && (
            <button onClick={loadMoreBatches} disabled={detailLoading} className="self-center text-[11px] font-bold px-3 py-1 rounded-full bg-white" style={{ color: "#1565C0", border: "1px solid #cfd8dc" }}>
              {detailLoading ? "読み込み中…" : "▲ もっと前のピックアップを見る"}
            </button>
          )}
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
                            <img src={it.trim_image_url ?? it.page_image_url ?? undefined} alt="" loading="lazy" decoding="async" className="rounded-md object-cover" style={{ width: 88, height: 62, border: "1px solid #e0e0e0", background: "#fff" }} />
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
                  <div className="flex flex-col gap-2 mt-2">
                    <div className="flex gap-2">
                      <button disabled={!!busy} onClick={() => void trim(bb.batch)}
                        title="選んだ物件の PDF 1ページ目（弊社帯替え）を画像にする（元付業者の資料は使わない）"
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#f3e5f5", color: "#6a1b9a", opacity: busy ? 0.6 : 1 }}>
                        {busy === `trim:${bb.batch.batch_id}` ? "✂️ …" : "✂️ 画像トリミング"}
                      </button>
                      <button disabled={!!busy} onClick={() => void analyze(bb.batch)}
                        title="選んだ物件の資料画像を DeepSeek が読み、水回り・キッチン・リビングと洋室の位置関係・収納をお客様の希望に照らして判断"
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#e0f2f1", color: "#00695c", opacity: busy ? 0.6 : 1 }}>
                        {busy === `analyze:${bb.batch.batch_id}` ? "🔍 分析中…" : "🔍 画像で分析"}
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <button disabled={!!busy} onClick={() => void sendViaAix(open, bb.batch)}
                        title="LINE の会話画面で AIX【物件ピックアップした】を開き、選んだ物件の資料画像（1ページ目）をセットする"
                        className="flex-1 py-2 rounded-lg text-xs font-bold text-white" style={{ background: "#7C3AED", opacity: busy ? 0.6 : 1 }}>
                        📤 AIXで送る（物件ピックアップした）
                      </button>
                      <button disabled={!!busy} onClick={() => void act(open, bb.batch, "skip")}
                        className="px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#eceff1", color: "#546e7a" }}>見送り</button>
                    </div>
                  </div>
                )}
                <div className="text-[10px] text-[#b0bec5] mt-1 text-right">{fmtDateTime(bb.at)}</div>
              </div>
            </div>
          ) : bb.kind === "trim" ? (
            <div key={`t${i}`} className="flex items-end gap-2">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0" style={{ background: "#6a1b9a", color: "#fff" }}>✂️</div>
              <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-white px-3 py-2.5" style={{ boxShadow: "0 1px 2px rgba(0,0,0,.08)" }}>
                <div className="text-xs font-bold mb-1">✂️ お客様に送る物件資料の画像 {bb.items.length}枚（PDF 1ページ目・弊社帯替え）</div>
                {/* 重くならないよう小さく並べ、押すと原寸（新しいタブ）。画像は見えた時だけ読む（lazy） */}
                <div className="grid grid-cols-2 gap-2" style={{ maxWidth: 520 }}>
                  {bb.items.map((it) => (
                    <div key={`ti${it.id}`} className="rounded-xl overflow-hidden" style={{ border: "1px solid #e0e0e0" }}>
                      <a href={it.trim_image_url ?? undefined} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={it.trim_image_url ?? undefined} alt={it.property_name} loading="lazy" decoding="async" className="w-full block" style={{ aspectRatio: "1.41", objectFit: "cover", objectPosition: "top", background: "#fff" }} />
                      </a>
                      <div className="flex items-center justify-between px-2 py-1.5" style={{ background: "#f7f9fb" }}>
                        <span className="text-[11px] font-bold truncate">【{it.rank}】{it.property_name}{it.room_no ? ` ${it.room_no}号室` : ""}</span>
                        <button onClick={() => void saveImage(it.trim_image_url as string, `${it.property_name}${it.room_no ? `_${it.room_no}` : ""}.jpg`)}
                          className="text-[11px] font-bold px-2 py-1 rounded-lg shrink-0" style={{ background: "#6a1b9a", color: "#fff" }}>💾 保存</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-[#b0bec5] mt-1 text-right">「📤 AIXで送る」はこの画像をセットします</div>
              </div>
            </div>
          ) : bb.kind === "analysis" ? (
            <div key={`a${i}`} className="flex items-end gap-2">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0" style={{ background: "#00695c", color: "#fff" }}>🔍</div>
              <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-white px-3 py-2.5" style={{ boxShadow: "0 1px 2px rgba(0,0,0,.08)" }}>
                <div className="text-xs font-bold mb-1">🔍 画像で分析しました（水回り・キッチン・リビングと洋室・収納）</div>
                {bb.bestId != null && (() => {
                  const best = bb.items.find((it) => it.id === bb.bestId);
                  return best ? <div className="text-xs font-bold mb-1.5 px-2 py-1 rounded-lg" style={{ background: "#e0f2f1", color: "#00695c" }}>👑 一番条件に合う: 【{best.rank}】{best.property_name}（{best.image_analysis?.match}点）</div> : null;
                })()}
                <div className="flex flex-col gap-2">
                  {bb.items.map((it) => {
                    const a = it.image_analysis as unknown as { water?: string; kitchen?: string; layout?: string; storage?: string; match?: number | null; good?: string[]; concern?: string[];
                      checks?: Array<{ id: string; result: string; why: string }>; wants?: Array<{ id: string; source: string; text: string; ng: boolean; must: boolean }> | string } | null;
                    if (!a) return null;
                    const wantList = Array.isArray(a.wants) ? a.wants : [];
                    const MARK: Record<string, string> = { ok: "◎", ng: "×", unknown: "？" };
                    return (
                      <div key={`ai${it.id}`} className="rounded-xl px-2 py-1.5" style={{ background: it.id === bb.bestId ? "#f1f8e9" : "#f7f9fb" }}>
                        <div className="text-[11px] font-bold">【{it.rank}】{it.property_name}{a.match != null ? `　${a.match}点` : ""}</div>
                        <div className="text-[10px] text-[#37474f] mt-0.5 leading-relaxed">
                          {a.water && <div>🚿 水回り: {a.water}</div>}
                          {a.kitchen && <div>🍳 キッチン: {a.kitchen}</div>}
                          {a.layout && <div>🛋️ リビングと洋室: {a.layout}</div>}
                          {a.storage && <div>🧥 収納: {a.storage}</div>}
                          {a.good && a.good.length > 0 && <div style={{ color: "#2e7d32" }}>◎ {a.good.join("／")}</div>}
                          {a.concern && a.concern.length > 0 && <div style={{ color: "#c62828" }}>△ {a.concern.join("／")}</div>}
                        </div>
                        {/* 2026-09-24 竹内「希望条件や NG 条件の細かい部分も画像から判断できているか」: 希望1つずつの判定（出どころ＝条件欄・会話・訴求） */}
                        {wantList.length > 0 && a.checks && a.checks.length > 0 && (
                          <div className="mt-1 pt-1 flex flex-col gap-0.5" style={{ borderTop: "1px dashed #cfd8dc" }}>
                            {wantList.map((w) => {
                              const c = a.checks!.find((x) => x.id === w.id);
                              const r = c?.result ?? "unknown";
                              return (
                                <div key={w.id} className="text-[10px] leading-snug" style={{ color: r === "ok" ? "#2e7d32" : r === "ng" ? "#c62828" : "#90a4ae" }}>
                                  {MARK[r] ?? "？"} <span className="font-bold">{w.text}</span>
                                  <span className="ml-1 text-[9px]" style={{ color: "#90a4ae" }}>（{w.source}{w.ng ? "・NG" : ""}{w.must ? "・必須" : ""}）</span>
                                  {c?.why && r !== "unknown" && <span className="ml-1" style={{ color: "#607d8b" }}>— {c.why}</span>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
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
  })() : null;

  // ── 一覧（左の列・LINE の一覧と同じ形と幅 390px） ──
  const listView = (
    <div className="flex flex-col h-full bg-white">
      <div className="px-4 pt-3 pb-2 bg-white flex items-center gap-2 shrink-0" style={{ borderBottom: "1px solid #e9edef" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="名前で検索..." className="flex-1 text-sm px-3 py-2 rounded-lg" style={{ background: "#f0f2f5", border: "none" }} />
        <button onClick={() => void loadList()} className="text-xs text-[#1565C0] font-bold">{loading ? "…" : "更新"}</button>
      </div>
      {!open && msg && <div className="mx-4 mt-2 text-xs px-3 py-2 rounded-lg" style={{ background: "#e3f2fd", color: "#0d47a1" }}>{msg}</div>}
      <div className="flex-1 overflow-y-auto">
      {filtered.length === 0 && !loading && (
        <div className="text-sm text-[#90a4ae] py-10 text-center px-4">まだありません（拡張ツールのブレインモードで「売上番長に送る」をするか、AIX で物件を送ると並びます）</div>
      )}
      {/* 2026-09-24 竹内「ピックアップの一覧は LINE と同じ UI にする（アイコンも付ける）。順番も LINE と同じに連動」:
          行の形は app/page.tsx の LINE 一覧（アイコン・名前＋アカウント札・1行目のプレビュー・右に時刻と緑の件数）と同じ。並びは API が LINE の updated_at 順で返す */}
      {filtered.map((c) => {
        const lb = c.last_batch;
        const sentParts = [c.sent.pickup ? `🟢${c.sent.pickup}` : "", c.sent.recommendation ? `🔵${c.sent.recommendation}` : "", c.sent.other ? `送${c.sent.other}` : ""].filter(Boolean).join(" ");
        const preview = lb ? `🧠 ${lb.count}件${lb.rec_name ? `・🌟${lb.rec_name}` : ""}` : sentParts ? `📦 送った物件 ${sentParts}` : "";
        const at = c.line?.updated_at ?? c.last_at;
        const img = c.line?.profile_image_url ?? null;
        const active = c.key === openKey;
        return (
          <button key={c.key} onClick={() => openCustomer(c)}
            className={`flex w-full items-center gap-3 px-4 py-[16px] text-left transition border-l-[3px] ${active ? "border-[#1565C0] bg-[#f0f2f5]" : c.pending > 0 ? "border-orange-400 bg-orange-50 hover:bg-orange-100" : "border-transparent bg-white hover:bg-[#f5f6f6]"}`}
            style={{ borderBottom: "1px solid #f0f2f5" }}>
            <div className="relative shrink-0">
              {img ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img} alt="" loading="lazy" decoding="async" className="h-12 w-12 rounded-full object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#d9fdd3] text-base font-bold text-[#0f8f44]">{getInitial(c.customer_name)}</div>
              )}
              {c.batch_count > 0 && <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white text-[11px]" style={{ background: "#1565C0" }}>🧠</span>}
            </div>
            <div className="relative min-w-0 flex-1 pr-12">
              <div className="absolute right-0 top-0 flex flex-col items-end gap-1">
                <span className="text-[11px] text-[#667781]" title="LINE の最終更新（並び順）">{at ? fmtWhen(at) : ""}</span>
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
              <div className="truncate text-[13px] text-[#667781]">
                {preview}
                {lb && sentParts && <span className="ml-1 text-[11px]">📦{sentParts}</span>}
                {c.last_pickup_at && <span className="ml-1 text-[11px] text-[#b0bec5]">（{fmtDateTime(c.last_pickup_at)} ブレインモード）</span>}
              </div>
            </div>
          </button>
        );
      })}
      </div>
    </div>
  );

  // LINE と同じ形: パソコンは左に一覧（390px）・右に会話。スマホは一覧 → 開くと会話だけ
  return (
    <div className="md:flex bg-white" style={{ height: "calc(100vh - 230px)", minHeight: 480 }}>
      <div className={`${openKey ? "hidden md:flex" : "flex"} h-full w-full flex-col md:w-[390px] md:min-w-[390px] md:border-r md:border-[#dfe5e7]`}>
        {listView}
      </div>
      <div className={`${openKey ? "flex" : "hidden md:flex"} h-full flex-1 min-w-0 flex-col`}>
        {detailView ?? (
          <div className="flex h-full items-center justify-center text-sm text-[#90a4ae]" style={{ background: "#eef3f7" }}>
            {openKey && detailLoading ? "読み込み中…" : "左の一覧からお客様を選んでください"}
          </div>
        )}
      </div>
    </div>
  );
}
