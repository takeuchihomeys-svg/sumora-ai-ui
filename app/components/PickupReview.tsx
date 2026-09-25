"use client";
// 売上サポ「ピックアップ」: LINE の一覧と同じ形でお客様を並べ、タップすると会話風に開く。
//   左＝ブレイン（拡張が送った1回分の物件と判断・🌟オススメ）／右＝スタッフ（送った・見送り・メモ）
// 2026-09-24 竹内「紐づいているお客さんで LINE のチャット一覧のような UI。判断したのが LINE の会話風に送られる形。
//   DeepSeek 側は左・スタッフの会話は右。スタッフは確認してお客さんに送るだけ」
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { okCountOf, verdictOrder, type CustomerBest } from "@/app/lib/pickup-best";
import { needsTrimBeforeAnalysis, pickSaveImageUrl, saveImageFileName } from "@/app/lib/pickup-image-url";
import { sortForReview, buildReasonView, formatScoreBreakdown } from "@/app/lib/pickup-review-order";
import { floorLabel, NOT_NEEDED_CLAUSE_RE, type PickupEquipment } from "@/app/lib/pickup-equipment";
import type { PickupTerms } from "@/app/lib/pickup-terms";
import { PICKUP_EXPIRED_LABEL, PICKUP_EXPIRED_ACTION_NOTE } from "@/app/lib/pickup-retention";
import { buildPickupCardView, groupPickupRounds, mergeRoundItems, roundSiteSummary, siteLabel, verdictCounts, type CardMark } from "@/app/lib/pickup-card-view";

const INTERNAL_AUTH_HEADER = { Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` };

type Item = {
  id: number; rank: number; property_name: string; room_no: string | null; summary_text: string;
  pdf_blob_url: string | null; pdf_has_text: boolean; verdict: string | null; score: number | null;
  reasons_ja: string[] | null; reason_codes?: string[] | null; ad_yen: number | null; profit_yen: number | null; recommended: number; status: string; sent_at: string | null;
  page_image_url: string | null; agent_image_url?: string | null; trim_image_url?: string | null; image_lines: string[] | null; image_facts: Record<string, boolean | null> | null;
  image_analysis?: { match?: number | null; [k: string]: unknown } | null;
  equipment?: PickupEquipment | null;
  /** 2026-09-25 資料の表の募集の条件（敷礼・築年・入居時期・契約・更新料）と希望の照合 */
  terms?: PickupTerms | null;
  /** 2026-09-25 物件の場所と希望のエリア・通勤の照合（area-want.ts の PickupLocation・画面は line と area.code だけ読む） */
  location?: { line?: string; area?: { code?: string; why?: string } | null; ward?: string | null; stations?: Array<{ station?: string | null; line?: string | null; walk?: number | null }> | null } | null;
  /** 2026-09-25 画像・資料の保存期間（届いてから 72時間・pickup-retention.ts）。切れた行は URL が空で来る */
  expired?: boolean; expiry_hours_left?: number | null; expiry_warn?: boolean;
  /** 元の回（まとめた回の中でどの回・どのサイトから来たか） */
  batch_id?: string; site?: string | null;
};
/**
 * 1回分。2026-09-25 竹内「まとめられていない」: 画面では短い間に届いた回（リアプロ・itandi）を1つにまとめた回（pickup-card-view.groupPickupRounds）で扱う。
 *   まとめた回は batch_id＝元の回を「,」でつないだ物（/send もこの形を受ける）・parts＝元の回
 */
type Batch = { batch_id: string; created_at: string; site: string | null; conversation_id: string | null; items: Item[]; round_id?: string | null; parts?: Batch[]; last_at?: string };
type Note = { id: number; created_at: string; batch_id: string | null; text: string; author: string | null };
type LineLite = { profile_image_url: string | null; updated_at: string | null; account: string | null; status: string | null; last_sender: string | null };
type SentHist = { id: string; property_name: string; room_no: string | null; channel: string | null; delivery: string | null; source: string | null; sent_at: string; image_url: string | null; pickup_id: number | null };
type Customer = { key: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; batches: Batch[]; notes: Note[]; pending: number; last_at: string; line?: LineLite | null; last_pickup_at?: string; order_at?: string; sent_history?: SentHist[]; has_more_batches?: boolean;
  /** 2026-09-24 回をまたいだ一番（画像で分析の点）と、画像で確かめる希望の有無（詳細だけ） */
  best?: (CustomerBest & { image_url?: string | null; status?: string | null }) | null; image_need?: { level: "recommended" | "optional" | "none"; labels: string[]; topics: string[]; from?: string } | null;
  /** 2026-09-25 条件の要約（決定論＋DeepSeek で読めない節だけ）と照らせない条件。スタッフ向け（お客様には出さない） */
  condition_summary?: { line: string; uncheckable: string[]; ai: boolean } | null };
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

/** 左の吹き出しの横の丸いアイコン（起きた事の種類） */
function Icon({ bg, children }: { bg: string; children: React.ReactNode }) {
  return <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0" style={{ background: bg, color: "#fff" }}>{children}</div>;
}
/** パソコン幅（md 以上）か。画像の開き方（新しいタブ／ライトボックス）と全画面の切替に使う */
function isDesktop(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
}
/** 吹き出しの時刻（buildBubbles は並びのために末尾へ「~」を付けるので外す） */
function bubbleDate(at: string): Date { return new Date(at.replace(/~+$/u, "")); }
/** 日付の区切り（LINE のトーク画面と同じ ja-JP の年月日） */
function dayLabel(at: string): string { return bubbleDate(at).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" }); }
/** 吹き出しの外に出す時刻（HH:MM。日付は区切りで出す） */
function hm(at: string): string { const d = bubbleDate(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }

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
  | { kind: "staff"; at: string; text: string; sub?: string }
  | { kind: "history"; at: string; items: SentHist[] }
  | { kind: "best"; at: string; best: NonNullable<Customer["best"]> };

/** 点数の丸い札の色（○ 通す＝緑・△ 保留＝橙・× 外す候補＝赤） */
const MARK_STYLE: Record<CardMark["tone"], { color: string; bg: string }> = {
  pass: { color: "#2e7d32", bg: "#f1f8e9" }, hold: { color: "#e65100", bg: "#fff3e0" },
  drop: { color: "#c62828", bg: "#ffebee" }, none: { color: "#90a4ae", bg: "#f5f5f5" },
};
/** 畳んだ時の1行の色 */
const HEADLINE_COLOR: Record<"drop" | "minus" | "plus" | "info", string> = { drop: "#c62828", minus: "#e65100", plus: "#2e7d32", info: "#78909c" };

/** 理由の札の色（外す理由＝赤・減点＝橙・加点＝緑・知らせ＝灰） */
const CHIP_STYLE: Record<string, { bg: string; color: string }> = {
  drop: { bg: "#ffebee", color: "#b71c1c" }, minus: { bg: "#fff3e0", color: "#e65100" },
  plus: { bg: "#e8f5e9", color: "#2e7d32" }, info: { bg: "#eceff1", color: "#607d8b" },
};

/**
 * 点の横の理由の札。2026-09-24 竹内「今回なんで外されているのか理由が分かれば大きい」:
 *   外す・減点の理由（何点）を先に、読めなかった材料（点が動かない理由）を灰色で、加点は後ろに。「内訳」で 基準50 からの足し引きを出す
 */
function ReasonChips({ it, open, onToggle }: { it: Item; open: boolean; onToggle: () => void }) {
  const v = buildReasonView(it);
  const chips = [...v.minus, ...v.plus.slice(0, it.verdict === "pass" ? 3 : 2)];
  const breakdown = formatScoreBreakdown(v, it.score);
  if (chips.length === 0 && v.missing.length === 0 && v.notes.length === 0 && it.profit_yen == null) return null;
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1">
        {chips.map((c) => {
          const st = CHIP_STYLE[c.tone];
          return <span key={c.code} className="text-[10px] leading-none px-1.5 py-1 rounded-full font-bold" style={{ background: st.bg, color: st.color }}>
            {c.tone === "drop" ? "✕ " : ""}{c.label}{c.points !== 0 ? ` ${c.points > 0 ? "+" : "−"}${Math.abs(c.points)}` : ""}</span>;
        })}
        {v.missing.length > 0 && <span className="text-[10px] leading-none px-1.5 py-1 rounded-full" style={CHIP_STYLE.info}>材料なし: {v.missing.join("・")}</span>}
        {it.profit_yen != null && <span className="text-[10px] leading-none px-1.5 py-1 rounded-full" style={CHIP_STYLE.info}>利益目安 {it.profit_yen.toLocaleString()}円</span>}
        {breakdown && (
          <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
            className="leading-none px-1.5 py-1 rounded-full font-bold" style={{ color: "#1565C0", background: "#e3f2fd", fontSize: 10 }}>{open ? "内訳を閉じる" : "点の内訳"}</button>
        )}
      </div>
      {open && breakdown && <div className="text-[10px] mt-1 leading-snug break-words" style={{ color: "#546e7a" }}>{breakdown}</div>}
      {v.notes.length > 0 && <div className="text-[10px] text-[#78909c] mt-0.5">{v.notes.join("・")}</div>}
    </div>
  );
}

/** 設備の印の色（○ 緑・× 赤・－ 灰・△ 橙） */
const equipMarkColor = (result: string, mark: string) =>
  result === "ng" ? "#c62828" : result === "unlisted" ? "#90a4ae" : mark === "△" ? "#ef6c00" : "#2e7d32";

/**
 * 資料の設備欄 × お客様の条件の1行。2026-09-24 竹内「宅配BOX付きなども条件なのに入れていない」「設備欄を見る」「202号室なら2階」:
 *   「条件: 2階以上○ エレベーター○〔建〕 宅配ボックス－」（× 赤・－ 灰・○ 緑）。印をタップすると根拠（資料の文字）を出す。
 *   所在階は「9階（所在階）」「5階（号室から推定）」。どの設備にも当たらない条件は「照らせない条件」で1行
 */
function EquipmentLine({ eq }: { eq: PickupEquipment | null | undefined }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!eq) return null;
  const fl = floorLabel(eq);
  const match = eq.match ?? [];
  // 喫煙・家具家電は不要（竹内 2026-09-25）。保存済みの古い行にも効くよう表示でも外す
  const uncovered = (eq.uncovered ?? []).filter((t) => !NOT_NEEDED_CLAUSE_RE.test(t));
  if (!match.length && !fl && !uncovered.length) return null;
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  const sel = open != null ? match[open] ?? null : null;
  return (
    <div className="mt-1 text-[10px] leading-snug">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {fl && <span style={{ color: "#37474f" }}>🏢 {fl}</span>}
        {match.length > 0 && <span style={{ color: "#546e7a" }}>条件:</span>}
        {match.map((m, k) => (
          <button key={`${m.key}-${m.mode}-${k}`} type="button" onClick={(e) => { stop(e); setOpen(open === k ? null : k); }}
            className="font-bold" style={{ color: equipMarkColor(m.result, m.mark), textDecoration: open === k ? "underline" : "none" }}
            title={m.why}>{m.label}{m.strong ? "（必須）" : ""}{m.mark}</button>
        ))}
      </div>
      {sel && <div className="mt-0.5 break-words" style={{ color: "#546e7a" }}>
        {sel.label}: {sel.result === "unlisted" ? `資料に記載なし（無いとは限らない）${sel.why && sel.why !== "資料に記載なし" ? `・${sel.why}` : ""}` : sel.why}</div>}
      {uncovered.length > 0 && <div className="mt-0.5 break-words" style={{ color: "#78909c" }}>照らせない条件: {uncovered.join("・")}</div>}
    </div>
  );
}

/**
 * 資料の表の募集の条件の1行と、希望との照合の札。2026-09-25 竹内「敷金礼金と入居時期、組み込みたい」:
 *   「💴 敷0/礼1ヶ月 築8年 入居:11月上旬 普通2年 更新1ヶ月」＋「入居○（希望 11月上旬まで）」「楽器不可」（× 赤・△/－ 灰・○ 緑）。
 *   書いていない条件は「要確認」（不可とは限らない）
 */
function TermsLine({ t }: { t: PickupTerms | null | undefined }) {
  if (!t) return null;
  const mi = t.want?.moveIn ?? null;
  const conds = t.want?.conditions ?? [];
  if (!t.line && !mi && !conds.length) return null;
  const miChip = mi ? (mi.result === "ok" ? { text: "入居○", color: "#2e7d32" } : mi.result === "late" ? { text: "入居×（希望より遅い）", color: "#c62828" } : { text: "入居 要確認", color: "#90a4ae" }) : null;
  return (
    <div className="mt-1 text-[10px] leading-snug">
      {t.line && <div className="break-words" style={{ color: "#37474f" }}>{t.line}{t.filled?.length ? <span style={{ color: "#90a4ae" }}>（資料の表から）</span> : null}</div>}
      {(miChip || conds.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-0.5">
          <span style={{ color: "#546e7a" }}>希望:</span>
          {miChip && mi && <span className="font-bold" style={{ color: miChip.color }} title={mi.wantBy ? `希望 ${mi.wantBy} まで` : undefined}>{miChip.text}{mi.label ? `（希望 ${mi.label}）` : ""}</span>}
          {conds.map((c) => (
            <span key={c.key} className="font-bold" style={{ color: c.status === "ng" ? "#c62828" : c.status === "ok" ? "#2e7d32" : c.status === "consult" ? "#ef6c00" : "#90a4ae" }}>
              {c.label}{c.status === "ng" ? "不可" : c.status === "ok" ? "○" : c.status === "consult" ? "相談" : "－"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** 分析結果の並び: 点の高い順（要確認・点なしは後ろ）→ 🌟 → 順位 */
function analysisOrder(items: Item[]): Item[] {
  const m = (x: Item) => {
    const a = x.image_analysis as { match?: unknown; review?: { status?: string } } | null;
    if (a?.review?.status === "要確認") return -2;
    return typeof a?.match === "number" ? a.match : -1;
  };
  return items.slice().sort((a, z) => (m(z) - m(a)) || (z.recommended - a.recommended) || (a.rank - z.rank));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 画像を手元に保存（別ドメインの画像は download 属性が効かないので、取ってきて Blob の URL で落とす。取れなければ新しいタブで開く） */
async function saveImage(url: string, name: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    // スマホは共有シート（「画像を保存」で写真に入る）。a[download] だと iPhone は「ファイル」に落ちる
    const file = new File([blob], name, { type: blob.type || "image/jpeg" });
    if (!isDesktop() && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if ((e as { name?: string })?.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** 2026-09-25 竹内「保存期間が終了しましたと出る感じで（実際の LINE のように）」: 画像のかわりに出す灰色の枠 */
function ExpiredImage({ width, height }: { width?: number; height?: number }) {
  return (
    <div className="shrink-0 rounded-md flex flex-col items-center justify-center text-center leading-tight"
      style={{ width: width ?? "100%", height: height ?? undefined, aspectRatio: height ? undefined : "1.41", background: "#eceff1", border: "1px solid #cfd8dc", color: "#90a4ae" }}>
      <span className="text-[14px]">🔒</span>
      <span className="text-[9px] font-bold px-1">{PICKUP_EXPIRED_LABEL}</span>
    </div>
  );
}

/** 回の画像・資料の保存期間が切れたか（同じ回の行は同じ時刻に届くので、全部が切れていれば切れた回） */
function batchExpired(b: Batch): boolean {
  return b.items.length > 0 && b.items.every((x) => x.expired);
}

/**
 * 2026-09-25 竹内「まとめられていない。スタッフモードで送った時は完了ボタンでリアプロと itandi の全部を分析」:
 *   同じお客様に短い間（前の回から30分以内・拡張の「完了」の印 round_id があればそれ）に届いた回を1つの吹き出しにまとめる。
 *   物件は 🌟★ → 🌟 → 点の高い順（サイトが混ざってもよい・カードにサイトの小さな札）
 */
function toRounds(batches: Batch[]): Batch[] {
  return groupPickupRounds(batches).map((r) => {
    if (r.batches.length === 1) return { ...r.batches[0], parts: r.batches, last_at: r.last_at };
    const sites = [...new Set(r.batches.map((b) => b.site ?? "-"))];
    return {
      batch_id: r.key, created_at: r.created_at, last_at: r.last_at, round_id: r.round_id,
      site: sites.length === 1 ? sites[0] : "mixed",
      conversation_id: r.batches.find((b) => b.conversation_id)?.conversation_id ?? null,
      // 元の回とサイトを物件に残す（カードの札・送る時の回）
      items: mergeRoundItems(r.batches.map((b) => ({ items: b.items.map((it) => ({ ...it, batch_id: it.batch_id ?? b.batch_id, site: it.site ?? b.site })) }))),
      parts: r.batches,
    };
  });
}

function buildBubbles(c: Customer): Bubble[] {
  const out: Bubble[] = [];
  for (const b of toRounds(c.batches)) {
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
      // 同点（全件が必須 NG で 20 点など）は上限前の点 →「合う」の数で並べる（pickup-image-analysis.pickBest と同じ）
      // 2026-09-24 竹内「前回の反証で出た点も直す」: 同点は「合う」の数が多い方を上に
      // 2026-09-25 それでも同じなら判定（通す＞保留＞外す候補）。全体の 👑（pickCustomerBest）と同じ
      const best = scored.slice().sort((a, z) => (m(z) - m(a)) || (raw(z) - raw(a)) || (okCountOf(z.image_analysis) - okCountOf(a.image_analysis)) || (verdictOrder(a) - verdictOrder(z)) || (a.rank - z.rank))[0];
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
  // 2026-09-24 夜: 送った物件の履歴は上のカードではなく、起きた事として左の吹き出しに（一番新しく送った時刻の位置）
  const hist = c.sent_history ?? [];
  if (hist.length > 0) out.push({ kind: "history", at: hist.map((h) => h.sent_at).sort().slice(-1)[0] + "~~~", items: hist });
  const sorted = out.sort((a, z) => a.at.localeCompare(z.at));
  // 2026-09-24 竹内「1番オススメの物件全体の中で」: 回をまたいだ一番は一番下（最新の位置）に1つだけ
  if (c.best && sorted.length > 0) sorted.push({ kind: "best", at: sorted[sorted.length - 1].at + "~", best: c.best });
  return sorted;
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
  /** 点の内訳を開いている物件 */
  const [openBreakdown, setOpenBreakdown] = useState<Record<number, boolean>>({});
  /** 2026-09-25 物件カードの「詳細 ▾」を開いている物件（既定は畳む） */
  const [openCard, setOpenCard] = useState<Record<number, boolean>>({});
  /** iPhone で共有シートを開けなかった時（画像の用意に時間がかかり、押した操作の有効期限が切れた）の「もう一度押す」用 */
  const [shareReady, setShareReady] = useState<File[] | null>(null);
  const openRef = useRef<{ key: string; pcid: string | null; conv: string | null } | null>(null);
  const nBatchesRef = useRef(3);
  const historyPushedRef = useRef(false);

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

  const loadDetail = useCallback(async (target: { key: string; pcid: string | null; conv: string | null }, n: number, resetChecks: boolean): Promise<Customer | null> => {
    setDetailLoading(true);
    try {
      const qs = target.pcid ? `pcid=${encodeURIComponent(target.pcid)}` : `conv=${encodeURIComponent(target.conv ?? "")}`;
      const res = await fetch(`/api/property-pickups?view=detail&${qs}&batches=${n}`, { cache: "no-store" });
      const json = await res.json() as { ok: boolean; customer?: Customer; error?: string };
      if (!json.ok || !json.customer) throw new Error(json.error || "取得に失敗");
      if (openRef.current?.key !== target.key) return null;   // 読み込み中に別のお客様を開いた
      setDetail({ ...json.customer, key: target.key });
      if (resetChecks) {
        // 既定のチェック: 未確認のうち「外す候補」以外
        const next: Record<number, boolean> = {};
        for (const b of json.customer.batches) for (const it of b.items) next[it.id] = it.status === "pending" && it.verdict !== "drop";
        setChecked(next);
      }
      return json.customer;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /** 操作の後に一覧と開いている詳細を取り直す（旧 load と同じ呼び方） */
  const load = useCallback(async () => {
    await Promise.all([
      loadList(true),
      openRef.current ? loadDetail(openRef.current, nBatchesRef.current, false) : Promise.resolve(null),
    ]);
  }, [loadList, loadDetail]);

  useEffect(() => { void loadList(); }, [loadList]);
  // LINE の一覧の並びに追従（30秒ごと・画面に戻った時）
  // 2026-09-24 竹内「画像で分析」がスマホで「Load failed」: 待っている間に画面が裏に回ると fetch が切れるが、サーバーは結果を保存している。
  //   → 分析中（と切れた後しばらく）は開いている詳細も取り直し、画面に戻った時も詳細を読み直す（保存済みの結果と 👑 が出る）
  const analyzingRef = useRef(false);
  const refreshUntilRef = useRef(0);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void loadList(true);
      if (openRef.current && (analyzingRef.current || Date.now() < refreshUntilRef.current)) void loadDetail(openRef.current, nBatchesRef.current, false);
    };
    const onBack = () => {
      if (document.visibilityState !== "visible") return;
      void loadList(true);
      if (openRef.current) void loadDetail(openRef.current, nBatchesRef.current, false);
    };
    const id = window.setInterval(tick, 30_000);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => { window.clearInterval(id); window.removeEventListener("focus", onBack); document.removeEventListener("visibilitychange", onBack); };
  }, [loadList, loadDetail]);

  const openCustomer = (c: { key: string; property_customer_id: string | null; conversation_id: string | null }) => {
    const target = { key: c.key, pcid: c.property_customer_id, conv: c.conversation_id };
    openRef.current = target;
    stickBottomRef.current = true;   // 開いたら一番下（最新）から（LINE のトーク画面と同じ）
    nBatchesRef.current = 3;
    setNBatches(3);
    setOpenKey(c.key);
    setDetail(null);
    setChecked({});
    setMsg("");
    void loadDetail(target, 3, true);
    // スマホ: 端末の「戻る」で一覧に戻れるよう履歴を1つ積む（LINE のトーク画面と同じ操作）。Next の状態は引き継ぐ
    if (!isDesktop() && !historyPushedRef.current) {
      try { window.history.pushState({ ...(window.history.state ?? {}), pickupDetail: true }, ""); historyPushedRef.current = true; } catch { /* 積めなくても閉じるボタンで戻れる */ }
    }
  };
  const clearDetail = () => { openRef.current = null; setOpenKey(null); setDetail(null); setLightbox(null); };
  const closeDetail = () => {
    if (historyPushedRef.current) {
      // 積んだ履歴を戻す → popstate で clearDetail（二重に戻らない）
      historyPushedRef.current = false;
      clearDetail();
      try { window.history.back(); } catch { /* noop */ }
      return;
    }
    clearDetail();
  };
  useEffect(() => {
    const onPop = () => {
      if (!historyPushedRef.current) return;
      // 2026-09-24 点検: 画像を大きく開いている時の「戻る」は画像だけ閉じる（LINE と同じ）。会話まで閉じない → 履歴を積み直す
      if (lightboxRef.current) {
        setLightbox(null);
        try { window.history.pushState({ ...(window.history.state ?? {}), pickupDetail: true }, ""); } catch { historyPushedRef.current = false; }
        return;
      }
      historyPushedRef.current = false;
      clearDetail();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 2026-09-24 夜 竹内「スマホの場合下側に資料一枚分の余白が出る」: スマホで開いた会話は LINE のトーク画面と同じく全画面（fixed）。
  //   高さは visualViewport（キーボード・アドレスバーに追従）、取れなければ 100dvh（app/page.tsx 3213 と同じ型）
  const [desk, setDesk] = useState(false);
  // kb: キーボードが出ているか（LINE の page.tsx 3218 と同じ求め方: innerHeight − visualViewport.height > 100）
  const [vp, setVp] = useState<{ h: number | null; top: number; kb: boolean }>({ h: null, top: 0, kb: false });
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onMq = () => setDesk(mq.matches);
    onMq();
    mq.addEventListener?.("change", onMq);
    return () => mq.removeEventListener?.("change", onMq);
  }, []);
  useEffect(() => {
    if (desk || !openKey) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const h = () => setVp({ h: vv.height, top: vv.offsetTop, kb: window.innerHeight - vv.height > 100 });
    h();
    vv.addEventListener("resize", h);
    vv.addEventListener("scroll", h);
    return () => { vv.removeEventListener("resize", h); vv.removeEventListener("scroll", h); };
  }, [desk, openKey]);

  // 右スワイプで一覧へ戻る（LINE の page.tsx 6416-6447 と同じ: 90px 超・入力欄の上から始めたタッチは追わない）
  const detailRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<{ x: number; y: number; dx: number; on: boolean } | null>(null);
  const onSwipeStart = (e: React.TouchEvent) => {
    if (desk) return;
    const tg = e.target as HTMLElement;
    // label は除かない（物件カードが丸ごと <label> で、画面の大半でスワイプが効かなくなる）。
    //   代わりにスワイプと認めた後の合成クリックを 500ms 止め、チェックが切り替わらないようにする（page.tsx の swipeBlockClickRef と同じ）
    if (tg.closest("input, textarea, button, a")) { swipeRef.current = null; return; }
    const t0 = e.touches[0];
    swipeRef.current = { x: t0.clientX, y: t0.clientY, dx: 0, on: false };
  };
  const onSwipeMove = (e: React.TouchEvent) => {
    const s = swipeRef.current;
    if (!s) return;
    const t0 = e.touches[0];
    const dx = t0.clientX - s.x, dy = t0.clientY - s.y;
    if (!s.on) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (dx <= 0 || Math.abs(dy) > Math.abs(dx)) { swipeRef.current = null; return; }
      s.on = true;
    }
    s.dx = Math.max(0, dx);
    if (detailRef.current) { detailRef.current.style.transition = "none"; detailRef.current.style.transform = `translateX(${Math.min(s.dx * 0.7, 200)}px)`; }
  };
  const onSwipeEnd = () => {
    const s = swipeRef.current;
    swipeRef.current = null;
    const el = detailRef.current;
    if (el) { el.style.transition = "transform 0.25s cubic-bezier(0.25,0.46,0.45,0.94)"; el.style.transform = ""; }
    if (s?.on) {
      swipeBlockClickRef.current = true;
      window.setTimeout(() => { swipeBlockClickRef.current = false; }, 500);
    }
    if (s?.on && s.dx > 90) closeDetail();
  };
  const swipeBlockClickRef = useRef(false);
  const onDetailClickCapture = (e: React.MouseEvent) => {
    if (!swipeBlockClickRef.current) return;
    e.preventDefault();   // label の既定動作（チェックの切り替え）も止まる
    e.stopPropagation();
  };

  // 画像を開く: パソコンは今のまま新しいタブ（余白が出ない）。スマホは LINE と同じライトボックス（縦持ちで A4 横の資料の下に空きが出ない）
  //   noSave: 元付業者の資料（2ページ目・AD の記載あり）は見るだけで 💾 保存を出さない（写真に入るとお客様に送る事故になる）
  const [lightbox, setLightbox] = useState<{ url: string; name: string; noSave?: boolean } | null>(null);
  const lightboxRef = useRef(lightbox);
  lightboxRef.current = lightbox;

  // 2026-09-24 点検: 会話は古い順（上に「もっと前を見る」）なのに、開いた時に一番上（古い方）から出ていた。
  //   LINE と同じく開いた時・メモを残した後・キーボードが出た時は一番下（最新と入力欄の上）を見せる。
  //   画像は遅れて読み込まれて高さが伸びるので、少し後にもう一度合わせる
  const scrollBoxRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(false);
  const scrollToBottom = () => {
    const go = () => { const el = scrollBoxRef.current; if (el) el.scrollTop = el.scrollHeight; };
    requestAnimationFrame(go);
    window.setTimeout(go, 350);
  };
  useEffect(() => {
    if (!detail || !stickBottomRef.current) return;
    stickBottomRef.current = false;
    scrollToBottom();
  }, [detail]);
  useEffect(() => { if (vp.kb) scrollToBottom(); }, [vp.kb]);
  const openImage = (e: React.MouseEvent, url: string | null | undefined, name: string, opts?: { noSave?: boolean }) => {
    e.stopPropagation();
    if (!url || isDesktop()) return;   // パソコンは <a target=_blank> のまま
    e.preventDefault();
    setLightbox({ url, name, noSave: !!opts?.noSave });
  };
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

  // 2026-09-24 夜: お客様への送信は「📤 AIXで送る」だけ（/send の直接送信はサーバーで止めた・説明文の AD・🌟 が届いたため）。ここは見送りだけ
  const act = async (b: Batch, action: "skip") => {
    const ids = b.items.filter((it) => checked[it.id] && it.status === "pending").map((it) => it.id);
    if (ids.length === 0) { setMsg("見送る物件にチェックを入れてください"); return; }
    setBusy(b.batch_id);
    try {
      const res = await fetch("/api/property-pickups/send", {
        method: "POST", headers: { "Content-Type": "application/json", ...INTERNAL_AUTH_HEADER },
        body: JSON.stringify({ batch_id: b.batch_id, item_ids: ids, action }),
      });
      const json = await res.json() as { ok: boolean; error?: string; skipped?: number };
      if (!json.ok) throw new Error(json.error || "失敗");
      setMsg(`${json.skipped}件 見送りにしました`);
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

  // 2026-09-24 竹内「画像トリミングボタンを画像保存にして、押したら選択しているのが一括で携帯に保存される形にする」:
  //   保存するのはお客様に送る1ページ目（トリミング → 文字のある page_image_url）だけ。元付の資料（2ページ目）は絶対に使わない（pickSaveImageUrl）。
  //   送る形の画像が無い物件は先にトリミングしてから保存する。
  //   スマホ（iPhone Safari）: navigator.share({ files }) で複数枚を共有シートへ →「N枚の画像を保存」で写真に入る。
  //     画像の取得に時間がかかると押した操作の有効期限が切れて share が NotAllowedError になる → 「📲 写真に保存」をもう一度押してもらう
  //   パソコン（または share で画像を渡せない端末）: 1枚ずつダウンロード（少し間を空ける＝ブラウザが複数のダウンロードを止めにくい）
  //   画像は Vercel Blob（公開・Access-Control-Allow-Origin: *）なので、そのまま fetch できる（2026-09-24 実測）
  const openShareSheet = async (files: File[]): Promise<void> => {
    try {
      await navigator.share({ files });
      setShareReady(null);
      setMsg(`💾 ${files.length}枚を共有シートに渡しました（「画像を保存」で写真に入ります）`);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "AbortError") { setShareReady(null); setMsg("保存を取りやめました"); return; }
      // 押した操作の有効期限切れ（NotAllowedError）→ もう一度押してもらう。
      //   それ以外（DataError・TypeError＝この端末では画像を渡せない）はもう一度押しても同じなので、ダウンロードに回す（押す→失敗の繰り返しを防ぐ）
      if (name === "NotAllowedError") {
        setShareReady(files);
        setMsg(`💾 ${files.length}枚の画像を用意しました。下の「📲 写真に保存」を押してください`);
        return;
      }
      setShareReady(null);
      await downloadFiles(files);
      setMsg(`💾 ${files.length}枚をダウンロードしました（共有シートが使えませんでした）`);
    }
  };
  /** パソコン（または共有シートで渡せない端末）: 1枚ずつダウンロード（少し間を空ける＝ブラウザが複数のダウンロードを止めにくい） */
  async function downloadFiles(files: File[]): Promise<void> {
    for (const f of files) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      document.body.appendChild(a); a.click();
      const href = a.href;
      setTimeout(() => { URL.revokeObjectURL(href); a.remove(); }, 2000);
      await sleep(400);
    }
  }
  const saveImages = async (b: Batch | null, targetsIn?: Item[]) => {
    const targets = targetsIn ?? (b ? b.items.filter((it) => checked[it.id]) : []);
    if (targets.length === 0) { setMsg("保存する物件にチェックを入れてください"); return; }
    if (targets.some((it) => it.expired)) { setMsg(`🔒 ${PICKUP_EXPIRED_ACTION_NOTE}`); return; }
    let list = targets;
    const needTrim = targets.filter((it) => !pickSaveImageUrl(it));
    if (needTrim.length > 0 && b) {
      if (!(await trim(b, needTrim.filter((it) => b.items.some((x) => x.id === it.id))))) return;
      const fresh = openRef.current ? await loadDetail(openRef.current, nBatchesRef.current, false) : null;
      const byId = new Map((fresh?.batches ?? []).flatMap((x) => x.items).map((x) => [x.id, x] as const));
      list = targets.map((t) => byId.get(t.id) ?? t);
    }
    const pairs = list.map((it) => ({ it, url: pickSaveImageUrl(it) })).filter((x): x is { it: Item; url: string } => !!x.url);
    const noImage = list.length - pairs.length;
    if (pairs.length === 0) { setMsg("保存できる画像がありません（資料の PDF が無い物件です）"); return; }
    setBusy(`save:${b?.batch_id ?? "best"}`);
    setShareReady(null);
    try {
      const files: File[] = [];
      const failed: string[] = [];
      for (const { it, url } of pairs) {
        setMsg(`💾 画像を用意しています… ${files.length + failed.length}/${pairs.length}`);
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const name = saveImageFileName(it, url);
          files.push(new File([blob], name, { type: blob.type || (name.endsWith(".png") ? "image/png" : "image/jpeg") }));
        } catch {
          failed.push(`【${it.rank}】`);
        }
      }
      if (files.length === 0) throw new Error("画像を取得できませんでした");
      const tail = [noImage ? `画像の無い ${noImage}件は除きました` : "", failed.length ? `取れなかった: ${failed.join("")}` : ""].filter(Boolean).join("・");
      const canShareFiles = !isDesktop() && typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files });
      if (canShareFiles) {
        await openShareSheet(files);
        if (tail) setMsg((m) => `${m}（${tail}）`);
        return;
      }
      await downloadFiles(files);
      setMsg(`💾 ${files.length}枚をダウンロードしました${tail ? `（${tail}）` : ""}`);
    } catch (e) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // 2026-09-24 竹内「画像で分析ボタンを付ける。お客さんの要望【水回り・キッチン・リビングと洋室の位置関係・収納（WIC 等）】を判断できる。
  //   トリミングした画像の中で一番条件に合った物件がわかる」→ 画像が無い物件は先に画像にしてから DeepSeek が読む
  // 2026-09-24 竹内「文字が反映されていないバグ」: 文字のある画像が無い物件（トリミングが無く、サーバーの画像が文字抜けの頃の物）は
  //   先に画面でトリミングしてから読む（以前は page_image_url があるとトリミングせず、文字の無い画像のまま DeepSeek に渡っていた）
  // 2026-09-24 スマホで「Load failed」: 10件を1回のリクエストで待つと 33〜60秒かかり、その間に画面が裏に回ると fetch が切れる
  //   （サーバーは 200 で結果を保存済み）→ 1件ずつ・同時3件で送り、1件終わるごとに詳細を取り直して結果を出す。
  //   切れた物件は再送しない（二重に費用がかかる）。保存済みの結果を読み直し、その後もしばらく 30秒ごとに読み直す
  const ANALYZE_CONCURRENCY = 3;
  const analyze = async (b: Batch) => {
    const targets = b.items.filter((it) => checked[it.id] && it.status === "pending");
    if (targets.length === 0) { setMsg("分析する物件にチェックを入れてください"); return; }
    if (targets.some((it) => it.expired)) { setMsg(`🔒 ${PICKUP_EXPIRED_ACTION_NOTE}`); return; }
    const needTrim = targets.filter((it) => needsTrimBeforeAnalysis(it));
    if (needTrim.length > 0 && !(await trim(b, needTrim))) return;
    setBusy(`analyze:${b.batch_id}`);
    analyzingRef.current = true;
    const startedAt = new Date().toISOString();
    let done = 0, ok = 0;
    const cut: number[] = [];
    const failed: string[] = [];
    // 2026-09-24 間取り図だけを切り出して推論なしで読む形にした（1件 数秒・2回目以降は保存した読み取りで画像を読まない）
    const progress = () => setMsg(`🔍 画像で分析しています… ${done}/${targets.length}件（1件 数秒〜20秒・同時${ANALYZE_CONCURRENCY}件。画面を切り替えても結果は保存されます）`);
    progress();
    const queue = targets.slice();
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const item = it;
        try {
          const res = await fetch("/api/property-pickups/analyze", {
            method: "POST", headers: { "Content-Type": "application/json", ...INTERNAL_AUTH_HEADER },
            body: JSON.stringify({ item_ids: [item.id] }),
          });
          const json = await res.json() as { ok: boolean; items?: Array<{ id: number; error?: string }>; error?: string };
          if (json.ok) ok++; else failed.push(`【${item.rank}】${json.items?.[0]?.error ?? json.error ?? "読めなかった"}`);
        } catch {
          cut.push(item.id);   // 通信が切れた（サーバーは続けて保存しているかもしれない）
        }
        done++;
        progress();
        if (openRef.current) void loadDetail(openRef.current, nBatchesRef.current, false);   // 1件ずつ結果を出す
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(ANALYZE_CONCURRENCY, targets.length) }, worker));
      const fresh = openRef.current ? await loadDetail(openRef.current, nBatchesRef.current, false) : null;
      // 切れた物件のうち、保存済みの結果が読めた件数
      const saved = fresh ? fresh.batches.flatMap((x) => x.items).filter((x) => cut.includes(x.id) && String((x.image_analysis as { analyzed_at?: string } | null)?.analyzed_at ?? "") >= startedAt).length : 0;
      if (cut.length > saved) refreshUntilRef.current = Date.now() + 150_000;   // サーバーはまだ読んでいるかもしれない → 2分半は読み直す
      const best = fresh?.best;
      const parts = [
        `🔍 ${ok + saved}/${targets.length}件を分析しました`,
        best ? `👑 全体で一番条件に合うのは【${best.rank}】${best.property_name}（${best.match}点）` : "",
        cut.length > saved ? `通信が切れた ${cut.length - saved}件は結果が保存され次第ここに出ます` : "",
        failed.length ? `⚠ 読めなかった: ${failed.join("・")}` : "",
      ].filter(Boolean);
      setMsg(parts.join("。"));
      void loadList(true);
    } catch (e) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}（保存済みの結果を読み直します）`);
      refreshUntilRef.current = Date.now() + 150_000;
      void load();
    } finally {
      analyzingRef.current = false;
      setBusy(null);
    }
  };

  // 2026-09-24 竹内「確認してお客様に送るの部分を AIX で送るにして。押したら AIX の物件ピックアップに選択した画像がセットされた状態にする
  //   （トリミングされた画像＝PDF 1枚目の弊社帯替え用が送られる形）。元付業者の資料は送られないようにする」
  //   → 画像が無い物件は先に画像にし、LINE の会話画面を AIX【物件ピックアップした】に画像をセットして開く（/?conv=…&aix=property_send&pickup=ids）
  const sendViaAix = async (c: Customer, b: Batch, only?: Item[]) => {
    // only: 👑 全体で一番の吹き出しから、その1件だけを送る時（2026-09-24 竹内「1番オススメの物件全体の中で送る」）
    const targets = only ?? b.items.filter((it) => checked[it.id] && it.status === "pending");
    if (targets.length === 0) { setMsg("送る物件にチェックを入れてください"); return; }
    if (targets.some((it) => it.expired)) { setMsg(`🔒 ${PICKUP_EXPIRED_ACTION_NOTE}`); return; }
    // 2026-09-25 反証: AIX に渡せるのは1回10件まで（GET ?ids が10件で切る）。回をまとめてチェックが増えると、
    //   届かない11件目以降にも送り終えた印（mark_sent は渡した id 全部）が付いてしまう → 10件を超えたら止める
    if (targets.length > 10) { setMsg(`AIX で一度に送れるのは10件までです（今 ${targets.length}件にチェック。10件以下にしてください）`); return; }
    const convId = c.conversation_id ?? b.conversation_id;
    if (!convId) { setMsg("このお客様は LINE の会話に紐付いていません（お客さん画面で紐付けてから）"); return; }
    const noImage = targets.filter((it) => !it.trim_image_url);
    if (noImage.length > 0 && !(await trim(b, noImage))) return;
    const ids = targets.map((it) => it.id).join(",");
    leaveTo(`/?conv=${encodeURIComponent(convId)}&aix=property_send&pickup=${encodeURIComponent(ids)}&batch=${encodeURIComponent(b.batch_id)}`);
  };
  /** 別のページへ移る。スマホで開いた時に積んだ履歴があれば、それを置き換えて移る（戻った時に中身の無い履歴が1つ残り「戻る」が空振りしない） */
  const leaveTo = (href: string) => {
    if (historyPushedRef.current) { historyPushedRef.current = false; window.location.replace(href); return; }
    window.location.href = href;
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
      stickBottomRef.current = true;   // 残したメモ（右の吹き出し）が見えるように
      await load();
    } catch (e) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ── 会話画面（右の列。開いたお客様1人分だけ） ──
  // 2026-09-24 夜 竹内「スマホ用で使えるように。見た目は LINE トーク詳細と同じ UI。左が起きた事項、右はこちらからの指示」:
  //   スマホ（md 未満）は LINE のトーク画面（app/page.tsx 7050〜9491）と同じ形: 全画面・‹ 戻る／名前のヘッダー・水色の背景・
  //   左の白い吹き出し＝起きた事（🧠ピックアップ・✂️画像・🔍分析・📦送った履歴）／右の緑の吹き出し＝こちら（メモ・送った・見送り）・時刻は吹き出しの外・下に入力欄。
  //   パソコン（md 以上）はヘッダーと背景だけ今のまま（2列はそのまま）
  const LEFT_BUBBLE = "min-w-0 max-w-[86%] md:max-w-[92%] rounded-2xl rounded-bl-md bg-white text-[#3d4a52] shadow-sm px-3 py-2.5";

  /**
   * 物件カード（1件）。2026-09-25 竹内「リアプロの物件一覧と同じ見た目にして、図面だけ今と同じようにして、図面の下にリアプロの物件一覧の項目の表記で。
   *   点数の項目も入れて。内訳や分析した内容等は折りたたんで詳細押したら出る。スマホでより使いやすく」:
   *   建物の段＝チェック・図面（今のサムネイル・タップで拡大）・物件名・住所・沿線と徒歩・点数の丸い札（○通す／△保留／×外す候補）
   *   部屋の段＝茶色の見出し帯・白い値の段（部屋/階・状態/入居・間取り/㎡・賃料/管理費・敷金/礼金・保証金/償却・AD・築年・点数）。スマホは3列の格子
   *   畳んだ時は一番大事な1行だけ。「詳細 ▾」で理由の札・点の内訳・設備・募集の条件・場所・画像の読み取り・画像で分析・資料
   */
  const renderCard = (it: Item, b: Batch) => {
    const cv = buildPickupCardView(it);
    const pending = it.status === "pending";
    const img = it.trim_image_url ?? it.page_image_url ?? null;
    const opened = !!openCard[it.id];
    const ms = MARK_STYLE[cv.mark.tone];
    const hl = cv.headline;
    const site = it.site ?? b.site;
    const a = it.image_analysis as { match?: number | null; water?: string; kitchen?: string; layout?: string; storage?: string; good?: string[]; concern?: string[]; review?: { status?: string } } | null;
    const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
    // 建物の段の文字（物件名・住所・沿線と徒歩）
    const nameBlock = (
      <>
        <div className="text-[13px] font-bold leading-snug break-words" style={{ color: cv.name ? "#3e2723" : "#90a4ae" }}>{cv.name ?? "物件名なし"}</div>
        {(cv.address || cv.access) && (
          <div className="text-[10px] leading-snug break-words">
            {cv.address && <span className="text-[#6d4c41]">{cv.address}</span>}
            {cv.address && cv.access && <span className="text-[#bcaaa4]">　</span>}
            {cv.access && <span className="text-[#37474f]">{cv.access}</span>}
          </div>
        )}
      </>
    );
    return (
      <div key={it.id} className="rounded-xl overflow-hidden bg-white" style={{ border: `1px solid ${it.recommended > 0 ? "#ffcc80" : "#d7ccc8"}`, opacity: pending ? 1 : 0.6 }}>
        {/* 建物の段（リアプロの写真の位置に図面） */}
        <div className="flex gap-2 p-2 items-start" style={{ background: it.recommended > 0 ? "#fff8e1" : "#fffdfb" }}>
          <label className="shrink-0 -m-1.5 p-1.5 flex items-start" aria-label={`【${it.rank}】を選ぶ`}>
            <input type="checkbox" className="mt-1 h-4 w-4" disabled={!pending} checked={!!checked[it.id]} onChange={(e) => setChecked((p) => ({ ...p, [it.id]: e.target.checked }))} />
          </label>
          {it.expired && <ExpiredImage width={88} height={62} />}
          {img && (
            <a href={img} target="_blank" rel="noreferrer" className="shrink-0 relative" onClick={(e) => openImage(e, img, `${it.property_name}${it.room_no ? `_${it.room_no}` : ""}.jpg`)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img} alt="" loading="lazy" decoding="async" className="rounded-md object-cover" style={{ width: 88, height: 62, border: "1px solid #e0e0e0", background: "#fff" }} />
              {it.trim_image_url && <span className="absolute -top-1 -left-1 text-[9px] font-bold px-1 rounded" style={{ background: "#6a1b9a", color: "#fff" }}>✂️ 送る形</span>}
            </a>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 flex-wrap leading-none mb-0.5">
              <span className="text-[9px] font-bold px-1 py-[2px] rounded" style={site === "itandi" ? { background: "#fff3e0", color: "#e65100" } : { background: "#e3f2fd", color: "#1565C0" }}>{siteLabel(site)}</span>
              <span className="text-[10px] text-[#8d6e63] font-bold">【{it.rank}】</span>
              {it.recommended === 2 && <span className="text-[10px] font-bold whitespace-nowrap" style={{ color: "#f57f17" }}>🌟★ 一番オススメ</span>}
              {it.recommended === 1 && <span className="text-[10px] font-bold whitespace-nowrap" style={{ color: "#f57f17" }}>🌟 オススメ</span>}
              {!pending && <span className="text-[10px] text-[#90a4ae]">{it.status === "sent" ? "送信済" : "見送り"}</span>}
            </div>
            {/* パソコンは図面の横・スマホは図面の下の全幅（360px でも物件名が1〜2行に収まる） */}
            <div className="hidden md:block">{nameBlock}</div>
          </div>
          {/* 点数の丸い札（リアプロの「○75点」） */}
          <div className="shrink-0 flex h-[46px] w-[46px] flex-col items-center justify-center rounded-full leading-none" style={{ border: `2px solid ${ms.color}`, background: ms.bg, color: ms.color }} title={cv.mark.label}>
            <span className="text-[13px] font-bold">{cv.mark.symbol}</span>
            <span className="text-[11px] font-bold tabular-nums mt-0.5">{cv.mark.score != null ? `${cv.mark.score}点` : "－"}</span>
          </div>
        </div>
        <div className="md:hidden px-2 pb-2 -mt-0.5" style={{ background: it.recommended > 0 ? "#fff8e1" : "#fffdfb" }}>{nameBlock}</div>
        {/* 部屋の段（茶色の見出し帯・白い値の段）。スマホは3列の格子で横に流れない・パソコンは1列の表 */}
        <div className="grid grid-cols-3 md:grid-cols-9 gap-px" style={{ background: "#d7ccc8", borderTop: "1px solid #d7ccc8" }}>
          {cv.cells.map((c) => (
            <div key={c.key} className="flex min-w-0 flex-col bg-white">
              <div className="px-0.5 py-[3px] text-center text-[9px] font-bold leading-none text-white whitespace-nowrap overflow-hidden text-ellipsis" style={{ background: "#8d6e63" }}>{c.head}</div>
              <div className="flex flex-1 flex-col items-center justify-center px-1 py-1 text-center leading-tight">
                <span className="text-[11px] font-bold break-all" style={{ color: c.key === "score" ? ms.color : c.value === "－" ? "#bcaaa4" : "#3e2723" }}>{c.value}</span>
                {c.sub != null && <span className="text-[10px] break-all" style={{ color: c.sub === "－" ? "#bcaaa4" : "#6d4c41" }}>{c.sub}</span>}
              </div>
            </div>
          ))}
        </div>
        {/* 畳んだ時の1行と「詳細 ▾」 */}
        <div className="flex items-center gap-2 px-2 py-1.5" style={{ borderTop: "1px solid #efebe9" }}>
          <div className="flex-1 min-w-0 text-[10px] font-bold leading-snug break-words" style={{ color: hl ? HEADLINE_COLOR[hl.tone] : "#bcaaa4" }}>
            {hl ? hl.text : "理由の記録なし"}
            {a && typeof a.match === "number" && a.review?.status !== "要確認" && <span className="ml-1 font-normal" style={{ color: "#00695c" }}>🔍{a.match}点</span>}
            {a?.review?.status === "要確認" && <span className="ml-1" style={{ color: "#e65100" }}>🔍要確認</span>}
          </div>
          <button type="button" onClick={(e) => { stop(e); setOpenCard((p) => ({ ...p, [it.id]: !p[it.id] })); }} aria-expanded={opened}
            className="shrink-0 rounded-full px-2.5 py-1 font-bold leading-none" style={{ background: "#efebe9", color: "#5d4037", fontSize: 11 /* globals.css の button { font: inherit } が text-[11px] に勝つため */ }}>{opened ? "詳細 ▴" : "詳細 ▾"}</button>
        </div>
        {opened && (
          <div className="px-2 pb-2 pt-1" style={{ background: "#fafafa", borderTop: "1px dashed #d7ccc8" }}>
            <ReasonChips it={it} open={openBreakdown[it.id] ?? true} onToggle={() => setOpenBreakdown((p) => ({ ...p, [it.id]: !(p[it.id] ?? true) }))} />
            <EquipmentLine eq={it.equipment} />
            <TermsLine t={it.terms} />
            {it.location?.line && (
              <div className="text-[10px] mt-1 break-words" style={{ color: it.location.area?.code === "AREA_EXCLUDED" ? "#c62828" : it.location.area?.code === "AREA_FAR" ? "#ef6c00" : "#37474f" }}>{it.location.line}</div>
            )}
            {it.image_lines && it.image_lines.length > 0 && (
              <div className="text-[10px] mt-1 break-words" style={{ color: "#37474f" }}>📷 {it.image_lines.slice(0, 8).join("／")}</div>
            )}
            {a && (a.water || a.kitchen || a.layout || a.storage || a.good?.length || a.concern?.length) && (
              <div className="text-[10px] mt-1 leading-relaxed" style={{ color: "#37474f" }}>
                <div className="font-bold" style={{ color: "#00695c" }}>🔍 画像で分析{typeof a.match === "number" ? ` ${a.match}点` : ""}</div>
                {a.water && <div>🚿 水回り: {a.water}</div>}
                {a.kitchen && <div>🍳 キッチン: {a.kitchen}</div>}
                {a.layout && <div>🛋️ リビングと洋室: {a.layout}</div>}
                {a.storage && <div>🧥 収納: {a.storage}</div>}
                {a.good && a.good.length > 0 && <div style={{ color: "#2e7d32" }}>◎ {a.good.join("／")}</div>}
                {a.concern && a.concern.length > 0 && <div style={{ color: "#c62828" }}>△ {a.concern.join("／")}</div>}
              </div>
            )}
            <div className="flex gap-3 flex-wrap mt-1.5">
              {it.pdf_blob_url && <a href={it.pdf_blob_url} target="_blank" rel="noreferrer" className="text-[11px] font-bold" style={{ color: "#1565C0" }}>📄 資料を見る{!it.pdf_has_text ? "（文字層なし）" : ""}</a>}
              {/* 偶数ページ＝元付業者の資料（AD の記載・ブレインが読んだ側）。お客様には送らない・見るだけ（保存を出さない） */}
              {it.agent_image_url && <a href={it.agent_image_url} target="_blank" rel="noreferrer" className="text-[11px] font-bold" style={{ color: "#6a1b9a" }}
                onClick={(e) => openImage(e, it.agent_image_url, `${it.property_name}_元付.png`, { noSave: true })}>🏢 元付の資料（見るだけ）</a>}
            </div>
          </div>
        )}
      </div>
    );
  };
  const TIME = "mb-0.5 shrink-0 text-[10px] leading-none text-[#667781]";
  const detailView = open ? (() => {
    const bubbles = buildBubbles(open);
    // 2026-09-24 竹内「画像で分析が推奨される条件のお客さん（WIC 等）は画像読み取りを推奨なので、画像読み取りボタンをだす」:
    //   判定は詳細 API の image_need（条件欄 or 分析済みの希望から決定論・DeepSeek は呼ばない）。
    //   none でもボタンは消さない（スタッフのメモで希望を足すことがある）→ 灰色で小さく
    const needRecommended = open.image_need?.level === "recommended";
    const needNone = open.image_need?.level === "none";
    const needLabels = (open.image_need?.labels ?? []).join("・");
    const lineHref = open.conversation_id ? `/?conv=${encodeURIComponent(open.conversation_id)}` : null;
    let lastDay = "";
    return (
      <div className="flex flex-col h-full min-h-0 bg-[linear-gradient(180deg,#e8f4fd_0%,#f0f8ff_50%,#f8fbff_100%)] md:bg-none md:bg-[#eef3f7]">
        {/* スマホのヘッダー（LINE と同じ: 左 ‹・中央に名前とアカウント・右に札） */}
        <div className="md:hidden shrink-0 border-b border-[#e9edef] px-3 pb-3 pt-[max(14px,env(safe-area-inset-top))] backdrop-blur-md" style={{ background: "rgba(218,238,253,0.88)" }}>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
            <button onClick={closeDetail} aria-label="一覧に戻る" className="flex items-center gap-1.5 shrink-0 justify-self-start">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111b21" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              {open.pending > 0 && <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#06C755] px-1 text-[11px] font-bold text-white leading-none">{open.pending}</span>}
            </button>
            <div className="flex min-w-0 max-w-[52vw] flex-col items-center justify-center">
              <span className="block w-full truncate text-[15px] font-semibold text-[#111b21] text-center leading-tight">{open.customer_name ?? "（名前なし）"}</span>
              <span className="text-[8px] text-[#999] leading-none mt-0.5">{accountLabel(open.line?.account)}{open.conversation_id ? "" : "・LINE 未紐付け"}</span>
            </div>
            <div className="flex shrink-0 items-center justify-self-end gap-0.5">
              {lineHref && <a href={lineHref} onClick={(e) => { if (historyPushedRef.current) { e.preventDefault(); leaveTo(lineHref); } }} className="whitespace-nowrap rounded-full border px-1 py-[2px] text-[9px] font-bold leading-none bg-[#06C755] border-[#06C755] text-white">LINE</a>}
              <button onClick={() => void load()} className="whitespace-nowrap rounded-full border px-1 py-[2px] text-[9px] font-bold leading-none border-[#d1d7db] bg-white text-[#8696a0]">{detailLoading ? "…" : "更新"}</button>
            </div>
          </div>
        </div>
        {/* パソコンのヘッダー（今のまま） */}
        <div className="hidden md:flex items-center gap-2 px-3 py-2 bg-white shrink-0" style={{ borderBottom: "1px solid #e0e0e0" }}>
          {open.line?.profile_image_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={open.line.profile_image_url} alt="" loading="lazy" className="h-9 w-9 rounded-full object-cover shrink-0" />
            : <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#d9fdd3] text-sm font-bold text-[#0f8f44] shrink-0">{getInitial(open.customer_name)}</div>}
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm truncate">{open.customer_name ?? "（名前なし）"}さん</div>
            <div className="text-[10px] text-[#78909c]">{open.conversation_id ? "LINE 紐付け済み" : "LINE 未紐付け（送れません）"}</div>
          </div>
          {lineHref && <a href={lineHref} className="text-xs text-[#06C755] font-bold">LINE を開く</a>}
          <button onClick={() => void load()} className="text-xs text-[#1565C0] font-bold">{detailLoading ? "…" : "更新"}</button>
        </div>
        {msg && <div className="mx-3 mt-2 text-xs px-3 py-2 rounded-lg shrink-0" style={{ background: "#e3f2fd", color: "#0d47a1" }}>{msg}</div>}
        <div ref={scrollBoxRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-4 md:py-3">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3.5">
          {open.has_more_batches && (
            <button onClick={loadMoreBatches} disabled={detailLoading} className="self-center text-[11px] font-bold px-3 py-1 rounded-full bg-white" style={{ color: "#1565C0", border: "1px solid #cfd8dc" }}>
              {detailLoading ? "読み込み中…" : "▲ もっと前のピックアップを見る"}
            </button>
          )}
          {bubbles.map((bb, i) => {
            const day = dayLabel(bb.at);
            const divider = day !== lastDay ? (
              <div key={`d${i}`} className="flex items-center gap-3 py-2">
                <div className="h-px flex-1 bg-[#e9edef]" />
                <span className="rounded-full bg-[#e9edef] px-3 py-1 text-[11px] text-[#8696a0]">{day}</span>
                <div className="h-px flex-1 bg-[#e9edef]" />
              </div>
            ) : null;
            lastDay = day;
            let row: React.ReactNode;
            if (bb.kind === "brain") row = (
            <div key={`b${i}`} className="flex items-end gap-1.5">
              <Icon bg="#1565C0">🧠</Icon>
              {/* 2026-09-25 物件カードに幅を使う（スマホ 360〜420px で表が3列に収まるよう、吹き出しは残りの幅いっぱい） */}
              <div className={`${LEFT_BUBBLE} flex-1 !max-w-full md:!max-w-[92%]`}>
                {/* 2026-09-24 竹内「ブレインモードで売上サポに送った日時も出るようにする」
                    2026-09-25 竹内「まとめられていない」: 短い間に届いた回（リアプロ・itandi）は1つにまとめ、サイトごとの件数と届いた時刻の幅を出す */}
                <div className="text-xs font-bold mb-0.5">ピックアップ {bb.batch.items.length}件（{roundSiteSummary(bb.batch.parts ?? [bb.batch])}）を確認しました</div>
                <div className="text-[10px] text-[#78909c] mb-1">
                  🧠 ブレインモードで {fmtDateTime(bb.batch.created_at)}{bb.batch.last_at && bb.batch.last_at.slice(0, 16) !== bb.batch.created_at.slice(0, 16) ? `〜${hm(bb.batch.last_at)}` : ""} に届きました
                  {(bb.batch.parts?.length ?? 1) > 1 ? `（${bb.batch.parts!.length}回分をまとめて表示）` : ""}
                </div>
                {verdictCounts(bb.batch.items) && <div className="text-[11px] font-bold mb-1.5" style={{ color: "#5d4037" }}>{verdictCounts(bb.batch.items)}</div>}
                {/* 2026-09-24 竹内「画像で分析が推奨される条件のお客さん（WIC 等）は画像読み取りを推奨」 */}
                {needRecommended && (
                  <div className="text-[11px] font-bold mb-1.5 px-2 py-1 rounded-lg" style={{ background: "#e0f2f1", color: "#00695c" }}>🔍 画像で確かめたい希望: {needLabels}</div>
                )}
                {/* 2026-09-25 竹内「売上サポに送られたら、条件指定あれば間取り図とか設備も自動的に読み取る」: 届いた時に自動で読んだ件数 */}
                {(() => {
                  const autos = bb.batch.items.filter((x) => (x.image_analysis as { auto?: unknown } | null)?.auto);
                  if (!autos.length) return null;
                  const lab = ((autos[0].image_analysis as { auto?: { labels?: string[] } }).auto?.labels ?? []).join("・");
                  return <div className="text-[11px] font-bold mb-1.5 px-2 py-1 rounded-lg" style={{ background: "#e8f5e9", color: "#2e7d32" }}>🔍 自動で読みました（{autos.length}件{lab ? `・推奨: ${lab}` : ""}）</div>;
                })()}
                {/* 2026-09-25 竹内「文章の部分も要約できるように」: 条件の要約と、資料で照らせない条件（スタッフ向け）。
                    2026-09-25 竹内「内訳や分析した内容等は折りたたんで詳細押したら出る」→ 畳んでおく */}
                {open.condition_summary && (open.condition_summary.line || open.condition_summary.uncheckable.length > 0) && (
                  <details className="mb-1.5 text-[10px] leading-snug">
                    <summary className="cursor-pointer font-bold" style={{ color: "#455a64" }}>📝 条件の要約{open.condition_summary.uncheckable.length ? `・照らせない条件 ${open.condition_summary.uncheckable.length}` : ""}</summary>
                    {open.condition_summary.line && <div className="mt-0.5 break-words" style={{ color: "#455a64" }}>{open.condition_summary.line}</div>}
                    {open.condition_summary.uncheckable.length > 0 && <div className="mt-0.5 break-words" style={{ color: "#78909c" }}>照らせない条件: {open.condition_summary.uncheckable.join("／")}</div>}
                  </details>
                )}
                <div className="flex flex-col gap-2.5">
                  {/* 2026-09-24 竹内「並び順は物件オススメが一番上でスコアリング順にする」
                      2026-09-25 竹内「リアプロの物件一覧と同じ見た目にして、図面だけ今と同じ。図面の下にリアプロの物件一覧の項目の表記で。点数の項目も」 */}
                  {sortForReview(bb.batch.items).map((it) => renderCard(it, bb.batch))}
                </div>
                {/* 2026-09-25 竹内「保存期間が終了しましたと出る感じで（実際の LINE のように）」: 切れた回は理由を1行・切れる前 12時間は残りを小さく */}
                {batchExpired(bb.batch)
                  ? <div className="text-[10px] mt-1.5 px-2 py-1 rounded-lg leading-snug" style={{ background: "#eceff1", color: "#78909c" }}>🔒 {PICKUP_EXPIRED_ACTION_NOTE}</div>
                  : (() => { const w = bb.batch.items.find((x) => x.expiry_warn); return w ? <div className="text-[10px] mt-1 text-[#ef6c00]">⏳ あと{w.expiry_hours_left}時間で画像・資料の保存期間が終了します（届いてから3日）</div> : null; })()}
                {bb.batch.items.some((it) => it.status === "pending") && (
                  <div className="flex flex-col gap-2 mt-2">
                    {/* 推奨のお客様: 画像で分析を先頭・全幅・濃い色で（ラベルに確かめたい希望） */}
                    {needRecommended && (
                      <button disabled={!!busy || batchExpired(bb.batch)} onClick={() => void analyze(bb.batch)}
                        title="お客様の希望に、間取り図で確かめるのが確実な物（WIC・キッチン・水回り・部屋の配置）があります"
                        className="w-full px-3 py-2.5 rounded-lg text-xs font-bold text-white" style={{ background: "#00796b", opacity: busy || batchExpired(bb.batch) ? 0.4 : 1 }}>
                        {busy === `analyze:${bb.batch.batch_id}` ? "🔍 分析中…" : `🔍 画像で分析（推奨: ${needLabels}）`}
                      </button>
                    )}
                    <div className="flex gap-2">
                      {/* 2026-09-24 竹内「画像トリミングボタンを画像保存にして、押したら選択しているのが一括で携帯に保存される形にする」 */}
                      <button disabled={!!busy || batchExpired(bb.batch)} onClick={() => void saveImages(bb.batch)}
                        title="選んだ物件の資料画像（PDF 1ページ目・弊社帯替え）をまとめて保存する（元付業者の資料は保存しない）"
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#f3e5f5", color: "#6a1b9a", opacity: busy || batchExpired(bb.batch) ? 0.4 : 1 }}>
                        {busy === `trim:${bb.batch.batch_id}` || busy === `save:${bb.batch.batch_id}` ? "💾 …" : "💾 画像保存"}
                      </button>
                      {!needRecommended && (
                        <button disabled={!!busy || batchExpired(bb.batch)} onClick={() => void analyze(bb.batch)}
                          title="選んだ物件の資料画像を DeepSeek が読み、水回り・キッチン・リビングと洋室の位置関係・収納をお客様の希望に照らして判断"
                          className={`flex-1 px-3 py-2 rounded-lg font-bold ${needNone ? "text-[10px]" : "text-xs"}`}
                          style={needNone ? { background: "#f5f5f5", color: "#9e9e9e", opacity: busy || batchExpired(bb.batch) ? 0.4 : 1 } : { background: "#e0f2f1", color: "#00695c", opacity: busy || batchExpired(bb.batch) ? 0.4 : 1 }}>
                          {busy === `analyze:${bb.batch.batch_id}` ? "🔍 分析中…" : needNone ? "🔍 画像で分析（画像で確かめる希望なし）" : "🔍 画像で分析"}
                        </button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button disabled={!!busy || batchExpired(bb.batch)} onClick={() => void sendViaAix(open, bb.batch)}
                        title="LINE の会話画面で AIX【物件ピックアップした】を開き、選んだ物件の資料画像（1ページ目）をセットする"
                        className="flex-1 py-2 rounded-lg text-xs font-bold text-white" style={{ background: "#7C3AED", opacity: busy || batchExpired(bb.batch) ? 0.4 : 1 }}>
                        📤 AIXで送る（物件ピックアップした）
                      </button>
                      <button disabled={!!busy} onClick={() => void act(bb.batch, "skip")}
                        className="px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#eceff1", color: "#546e7a" }}>見送り</button>
                    </div>
                  </div>
                )}
              </div>
              <span className={TIME}>{hm(bb.at)}</span>
            </div>
            );
            else if (bb.kind === "trim") row = (
            <div key={`t${i}`} className="flex items-end gap-1.5">
              <Icon bg="#6a1b9a">✂️</Icon>
              <div className={LEFT_BUBBLE}>
                <div className="text-xs font-bold mb-1">✂️ お客様に送る物件資料の画像 {bb.items.length}枚（PDF 1ページ目・弊社帯替え）</div>
                {/* 重くならないよう小さく並べ、押すと原寸（パソコンは新しいタブ・スマホはライトボックス）。画像は見えた時だけ読む（lazy） */}
                <div className="grid grid-cols-2 gap-2" style={{ maxWidth: 520 }}>
                  {sortForReview(bb.items).map((it) => {
                    const name = `${it.property_name}${it.room_no ? `_${it.room_no}` : ""}.jpg`;
                    return (
                    <div key={`ti${it.id}`} className="rounded-xl overflow-hidden" style={{ border: "1px solid #e0e0e0" }}>
                      <a href={it.trim_image_url ?? undefined} target="_blank" rel="noreferrer" onClick={(e) => openImage(e, it.trim_image_url, name)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={it.trim_image_url ?? undefined} alt={it.property_name} loading="lazy" decoding="async" className="w-full block" style={{ aspectRatio: "1.41", objectFit: "cover", objectPosition: "top", background: "#fff" }} />
                      </a>
                      <div className="flex items-center justify-between gap-1 px-2 py-1.5" style={{ background: "#f7f9fb" }}>
                        <span className="text-[11px] font-bold truncate min-w-0">【{it.rank}】{it.property_name}{it.room_no ? ` ${it.room_no}号室` : ""}</span>
                        <button onClick={() => void saveImage(it.trim_image_url as string, name)}
                          className="text-[11px] font-bold px-2 py-1 rounded-lg shrink-0" style={{ background: "#6a1b9a", color: "#fff" }}>💾 保存</button>
                      </div>
                    </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between gap-2 mt-1.5">
                  <button disabled={!!busy} onClick={() => void saveImages(bb.batch, bb.items)}
                    className="text-[11px] font-bold px-2.5 py-1 rounded-lg" style={{ background: "#f3e5f5", color: "#6a1b9a", opacity: busy ? 0.6 : 1 }}>💾 {bb.items.length}枚まとめて保存</button>
                  <span className="text-[10px] text-[#b0bec5] text-right">「📤 AIXで送る」はこの画像をセットします</span>
                </div>
              </div>
              <span className={TIME}>{hm(bb.at)}</span>
            </div>
            );
            else if (bb.kind === "analysis") row = (
            <div key={`a${i}`} className="flex items-end gap-1.5">
              <Icon bg="#00695c">🔍</Icon>
              <div className={LEFT_BUBBLE}>
                <div className="text-xs font-bold mb-1">🔍 画像で分析しました（水回り・キッチン・リビングと洋室・収納）</div>
                {bb.bestId != null && (() => {
                  const best = bb.items.find((it) => it.id === bb.bestId);
                  // 全体の一番（下の 👑 の吹き出し）と違う時は「この回で一番」として色を弱める
                  const isGlobal = !open.best || open.best.id === bb.bestId;
                  return best ? <div className="text-xs font-bold mb-1.5 px-2 py-1 rounded-lg" style={isGlobal ? { background: "#e0f2f1", color: "#00695c" } : { background: "#f5f5f5", color: "#78909c" }}>
                    {isGlobal ? "👑 一番条件に合う" : "この回で一番"}: 【{best.rank}】{best.property_name}（{best.image_analysis?.match}点）</div> : null;
                })()}
                <div className="flex flex-col gap-2">
                  {/* 2026-09-24 竹内「分析結果のところに画像を添付。分析によって絞られたのもそのまま使えるように」:
                      点の高い順に並べ、各物件に送る形の画像（1ページ目）とチェックを付ける。チェックは上の一覧と同じ（下のボタンでそのまま送る・保存） */}
                  {analysisOrder(bb.items).map((it) => {
                    const a = it.image_analysis as unknown as { water?: string; kitchen?: string; layout?: string; storage?: string; match?: number | null; good?: string[]; concern?: string[];
                      checks?: Array<{ id: string; result: string; why: string }>; wants?: Array<{ id: string; source: string; text: string; ng: boolean; must: boolean }> | string;
                      review?: { status: string; reasons: string[] }; sheet?: { type?: string; crop_mode?: string | null; crop_basis?: string | null; crop_reason?: string | null; source?: string } } | null;
                    if (!a) return null;
                    // 2026-09-24 竹内「物件と一致しているか。食い違いは点を出さず『要確認』」: 要確認は点の代わりに理由を出す
                    const needCheck = a.review?.status === "要確認";
                    const TYPE_JA: Record<string, string> = { realpro: "リアプロ", itandi: "itandi", unknown: "型不明" };
                    const CROP_JA: Record<string, string> = { floor: "間取り図を切り出し", image_area: "画像の範囲を切り出し", page: "1ページ全体" };
                    const SRC_JA: Record<string, string> = { read: "今回読んだ", saved_row: "保存した読み取り", saved_unit: "保存した読み取り（同じ部屋）", saved_fp: "保存した読み取り（同じ図）", none: "文字層だけ" };
                    const sheetNote = a.sheet ? [TYPE_JA[a.sheet.type ?? ""] ?? a.sheet.type, a.sheet.crop_mode ? CROP_JA[a.sheet.crop_mode] ?? a.sheet.crop_mode : null, a.sheet.source ? SRC_JA[a.sheet.source] ?? a.sheet.source : null].filter(Boolean).join("・") : "";
                    const wantList = Array.isArray(a.wants) ? a.wants : [];
                    const MARK: Record<string, string> = { ok: "◎", ng: "×", unknown: "？" };
                    const aImg = pickSaveImageUrl(it);
                    const aPending = it.status === "pending";
                    return (
                      <div key={`ai${it.id}`} className="rounded-xl px-2 py-1.5" style={{ background: it.id === bb.bestId ? "#f1f8e9" : "#f7f9fb", opacity: aPending ? 1 : 0.6 }}>
                        <div className="flex gap-2 items-start">
                        <input type="checkbox" className="mt-1 shrink-0" disabled={!aPending} checked={!!checked[it.id]} aria-label={`【${it.rank}】を選ぶ`}
                          onChange={(e) => setChecked((p) => ({ ...p, [it.id]: e.target.checked }))} />
                        {aImg ? (
                          <a href={aImg} target="_blank" rel="noreferrer" className="shrink-0" onClick={(e) => openImage(e, aImg, saveImageFileName(it, aImg))}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={aImg} alt="" loading="lazy" decoding="async" className="rounded-md object-cover" style={{ width: 88, height: 62, border: "1px solid #e0e0e0", background: "#fff", objectPosition: "top" }} />
                          </a>
                        ) : it.expired ? <ExpiredImage width={88} height={62} /> : (
                          <div className="shrink-0 rounded-md flex items-center justify-center text-[9px] text-[#90a4ae] text-center" style={{ width: 88, height: 62, border: "1px dashed #cfd8dc" }}>画像は保存時に作成</div>
                        )}
                        <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold break-words">【{it.rank}】{it.property_name}{it.room_no ? ` ${it.room_no}号室` : ""}{a.match != null ? `　${a.match}点` : ""}{needCheck && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px]" style={{ background: "#fff3e0", color: "#e65100" }}>⚠ 要確認</span>}{!aPending && <span className="ml-1 text-[10px] text-[#90a4ae]">{it.status === "sent" ? "送信済" : "見送り"}</span>}</div>
                        {it.recommended > 0 && <div className="text-[10px] font-bold mt-0.5" style={{ color: "#f57f17" }}>{it.recommended === 2 ? "🌟★ 一番オススメ" : "🌟 オススメ"}</div>}
                        </div>
                        </div>
                        {needCheck && (a.review?.reasons ?? []).length > 0 && (
                          <div className="text-[10px] mt-0.5 leading-snug" style={{ color: "#e65100" }}>{(a.review?.reasons ?? []).slice(0, 3).map((x, k) => <div key={k}>・{x}</div>)}<div style={{ color: "#90a4ae" }}>（点は出しません。資料が正しい物件か確かめてください）</div></div>
                        )}
                        {/* 2026-09-25 竹内「内訳や分析した内容等は折りたたんで詳細押したら出る」: 読み取りの中身と希望ごとの判定は畳む（点と要確認は上に出したまま） */}
                        <details className="mt-0.5">
                          <summary className="cursor-pointer text-[10px] font-bold" style={{ color: "#00695c" }}>分析の内訳{(() => { const cs = a.checks ?? []; const ok = cs.filter((x) => x.result === "ok").length, ng = cs.filter((x) => x.result === "ng").length; return cs.length ? `（◎${ok}・×${ng}）` : ""; })()} 詳細 ▾</summary>
                        {sheetNote && <div className="text-[9px] mt-0.5" style={{ color: "#b0bec5" }}>📐 {sheetNote}{a.sheet?.crop_reason ? `（${a.sheet.crop_reason}）` : ""}</div>}
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
                        </details>
                      </div>
                    );
                  })}
                </div>
                {/* 分析で絞った物件をそのまま使う（チェックは上の一覧と同じ）。点の高い順の上位3件を選ぶ手早い道も */}
                {(() => {
                  const pend = analysisOrder(bb.items).filter((it) => it.status === "pending");
                  if (pend.length === 0) return null;
                  const sel = pend.filter((it) => checked[it.id]);
                  const top = pend.filter((it) => typeof (it.image_analysis as { match?: unknown } | null)?.match === "number" && (it.image_analysis as { review?: { status?: string } } | null)?.review?.status !== "要確認").slice(0, 3);
                  return (
                    <div className="flex flex-col gap-2 mt-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-[#607d8b]">この分析から {sel.length}件を選択中</span>
                        {top.length > 0 && (
                          <button type="button" disabled={!!busy} onClick={() => setChecked((p) => { const n = { ...p }; for (const it of pend) n[it.id] = top.some((t) => t.id === it.id); return n; })}
                            className="text-[10px] font-bold px-2 py-1 rounded-full" style={{ background: "#e0f2f1", color: "#00695c" }}>点の高い{top.length}件だけ選ぶ</button>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button disabled={!!busy || sel.length === 0} onClick={() => void sendViaAix(open, bb.batch, sel)}
                          className="flex-1 py-2 rounded-lg text-xs font-bold text-white" style={{ background: "#7C3AED", opacity: busy || sel.length === 0 ? 0.5 : 1 }}>📤 AIXで送る（{sel.length}件）</button>
                        <button disabled={!!busy || sel.length === 0} onClick={() => void saveImages(bb.batch, sel)}
                          className="px-3 py-2 rounded-lg text-xs font-bold" style={{ background: "#f3e5f5", color: "#6a1b9a", opacity: busy || sel.length === 0 ? 0.5 : 1 }}>
                          {busy === `save:${bb.batch.batch_id}` || busy === `trim:${bb.batch.batch_id}` ? "💾 …" : "💾 画像保存"}</button>
                      </div>
                    </div>
                  );
                })()}
              </div>
              <span className={TIME}>{hm(bb.at)}</span>
            </div>
            );
            else if (bb.kind === "best") {
              // 2026-09-24 竹内「1番オススメの物件全体の中で送る。今回は物件数多かったからか出ていなかった」:
              //   直近の回（6時間以内）をまたいで一番条件に合う物件を1つ。押すとその1件だけ AIX で送る
              const bst = bb.best;
              const bBatch = open.batches.find((x) => x.batch_id === bst.batch_id) ?? null;
              const bItem = bBatch?.items.find((x) => x.id === bst.id) ?? null;
              row = (
            <div key={`w${i}`} className="flex items-end gap-1.5">
              <Icon bg="#f9a825">👑</Icon>
              <div className={LEFT_BUBBLE}>
                <div className="text-xs font-bold mb-1">👑 全体で一番条件に合う（直近 {bst.batches}回分・画像で分析）</div>
                <div className="text-[13px] font-bold px-2 py-1.5 rounded-lg" style={{ background: "#fff8e1", color: "#e65100" }}>
                  【{bst.rank}】{bst.property_name}{bst.room_no ? ` ${bst.room_no}号室` : ""}（{bst.match}点）
                </div>
                {/* 2026-09-24 竹内「全体で一番条件に合うのところも画像表示する」: お客様に送る1ページ目（元付の資料は出さない）。押すと原寸 */}
                {(() => {
                  const bImg = (bItem ? pickSaveImageUrl(bItem) : null) ?? bst.image_url ?? null;
                  if (!bImg) return null;
                  const bName = saveImageFileName(bst, bImg);
                  return (
                    <div className="mt-1.5 rounded-xl overflow-hidden" style={{ border: "1px solid #e0e0e0", maxWidth: 360 }}>
                      <a href={bImg} target="_blank" rel="noreferrer" onClick={(e) => openImage(e, bImg, bName)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={bImg} alt={bst.property_name} loading="lazy" decoding="async" className="w-full block" style={{ aspectRatio: "1.41", objectFit: "cover", objectPosition: "top", background: "#fff" }} />
                      </a>
                      <div className="flex justify-end px-2 py-1.5" style={{ background: "#f7f9fb" }}>
                        <button onClick={() => void saveImage(bImg, bName)} className="text-[11px] font-bold px-2 py-1 rounded-lg" style={{ background: "#6a1b9a", color: "#fff" }}>💾 保存</button>
                      </div>
                    </div>
                  );
                })()}
                <div className="text-[10px] text-[#607d8b] mt-1 leading-relaxed">
                  {bst.tied_names.length > 0 && <div>同点: {bst.tied_names.join("・")}</div>}
                  {bst.unscored > 0 && <div style={{ color: "#e65100" }}>⚠ {bst.unscored}件は資料から読めず未判定</div>}
                  {(bst.needs_check ?? 0) > 0 && <div style={{ color: "#e65100" }}>⚠ {bst.needs_check}件は要確認（物件と資料が一致しない・点なし）</div>}
                  {bst.not_analyzed > 0 && <div>{bst.not_analyzed}件はまだ画像で分析していません</div>}
                </div>
                {bBatch && bItem && bItem.status === "pending" && (
                  <button disabled={!!busy} onClick={() => void sendViaAix(open, bBatch, [bItem])}
                    className="mt-2 w-full py-2 rounded-lg text-xs font-bold text-white" style={{ background: "#7C3AED", opacity: busy ? 0.6 : 1 }}>
                    📤 この物件を AIXで送る（物件ピックアップした）
                  </button>
                )}
              </div>
              <span className={TIME}>{hm(bb.at)}</span>
            </div>
              );
            } else if (bb.kind === "history") {
              // 2026-09-24 竹内「開くと履歴が見れる」: このお客様に送った物件（物件送った表・経路つき）。吹き出しの中で開閉
              const histCustomer = bb.items.filter((h) => !(h.delivery === "shared" || (h.delivery == null && h.source === "line_group")));
              const histShared = bb.items.length - histCustomer.length;
              row = (
            <div key={`h${i}`} className="flex items-end gap-1.5">
              <Icon bg="#455a64">📦</Icon>
              <div className={LEFT_BUBBLE}>
                <details>
                  <summary className="text-xs font-bold cursor-pointer">📦 送った物件の履歴　お客様に送付 {histCustomer.length}件{histShared ? `・グループ共有のみ ${histShared}件` : ""}（直近40件）</summary>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {bb.items.map((h) => {
                      const ch = channelLabel(h);
                      return (
                        <div key={h.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                          <span className="text-[#90a4ae] shrink-0 tabular-nums">{fmtDateTime(h.sent_at)}</span>
                          <span className="truncate flex-1 min-w-[40%]">{h.property_name}{h.room_no ? ` ${h.room_no}` : ""}</span>
                          <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold" style={{ background: ch.bg, color: ch.color }}>{ch.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </div>
              <span className={TIME}>{hm(bb.at)}</span>
            </div>
              );
            } else row = (
            <div key={`s${i}`} className="flex items-end justify-end gap-1">
              <span className={TIME}>{hm(bb.at)}</span>
              <div className="min-w-0 max-w-[86%] md:max-w-[80%] rounded-2xl rounded-br-md px-4 py-2.5 text-[#3d4a52] shadow-sm" style={{ backgroundColor: "rgba(220,248,198,0.55)" }}>
                <div className="whitespace-pre-wrap break-words text-[14px] leading-6">{bb.text}</div>
                {bb.sub && <div className="text-[11px] text-[#667781] mt-0.5 break-words">{bb.sub}</div>}
              </div>
            </div>
            );
            return <div key={`r${i}`} className="contents">{divider}{row}</div>;
          })}
          {bubbles.length === 0 && <div className="text-sm text-[#90a4ae] text-center py-10">まだ何もありません</div>}
          </div>
        </div>
        {/* 下の入力欄（LINE と同じ形）。メモは右の吹き出しに残る（社内の記録だけ・お客様には届かない） */}
        <div className="shrink-0 border-t border-[#e9edef] bg-white px-2 pt-1.5 md:px-3" style={{ paddingBottom: !desk && vp.kb ? "4px" : "max(10px, env(safe-area-inset-bottom))" }}>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 min-w-0 items-center rounded-[24px] bg-[#f0f2f5] px-4 py-2">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="メモ（右側に残ります・お客様には届きません）"
                className="min-h-[22px] w-full bg-transparent text-[14px] leading-6 text-[#111b21] outline-none placeholder:text-[#aaa]"
                // 日本語の変換を確定しただけの Enter ではメモを送らない
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void addNote(open); } }} />
            </div>
            <button disabled={busy === "note" || !note.trim()} onClick={() => void addNote(open)} aria-label="メモを残す"
              className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#29B6F6] text-white shadow-sm disabled:opacity-50">
              {busy === "note" ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              )}
            </button>
          </div>
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

  // LINE と同じ形: パソコンは左に一覧（390px）・右に会話。スマホは一覧 → 開くと会話が全画面（LINE のトーク画面と同じ）
  // 2026-09-24 夜 竹内「スマホの場合下側に資料一枚分の余白が出る」— 原因（実物のコード）:
  //   ①外枠が height: calc(100vh - 230px)・minHeight 480 の PC 向けの決め打ち（iOS の 100vh はアドレスバーが隠れた時の大きい高さ・親は 100svh）
  //   ②親（conditions/page.tsx）の pb-16 が内外で二重（128px の空白）③スマホで開いた会話がページの流れの中（ヘッダー＋タブの下）
  //   ④画像を <a target=_blank> で直接開き、縦持ちで A4 横の資料の下が空く
  //   → スマホの一覧は親（conditions/page.tsx の 100svh の flex-col）の残りを h-full で取る（ヘッダーの高さを決め打ちしない＝ノッチの PWA でもずれない）。
  //     開いた会話は fixed の全画面（visualViewport か 100dvh・下ナビより上の z-[60]）、画像はライトボックス
  const mobileOpen = !!openKey && !desk;
  return (
    <>
    <div className="bg-white h-full md:flex md:h-[calc(100vh-230px)] md:min-h-[480px]">
      {/* 一覧はスマホで会話を開いている間も下に残す（戻った時にスクロール位置が変わらない） */}
      <div className="flex h-full w-full flex-col md:w-[390px] md:min-w-[390px] md:border-r md:border-[#dfe5e7]">
        {listView}
      </div>
      <div ref={detailRef}
        className={`${openKey ? "fixed inset-0 z-[60] flex" : "hidden"} md:static md:inset-auto md:z-auto md:flex md:h-full flex-1 min-w-0 flex-col`}
        style={mobileOpen ? { top: vp.top, bottom: "auto", height: vp.h != null ? `${vp.h}px` : "100dvh", touchAction: "pan-y" } : undefined}
        onTouchStart={onSwipeStart} onTouchMove={onSwipeMove} onTouchEnd={onSwipeEnd} onTouchCancel={onSwipeEnd} onClickCapture={onDetailClickCapture}>
        {detailView ?? (
          <div className="flex h-full flex-col bg-[linear-gradient(180deg,#e8f4fd_0%,#f0f8ff_50%,#f8fbff_100%)] md:bg-none md:bg-[#eef3f7]">
            {openKey && (
              <div className="md:hidden shrink-0 border-b border-[#e9edef] px-3 pb-3 pt-[max(14px,env(safe-area-inset-top))]" style={{ background: "rgba(218,238,253,0.88)" }}>
                <button onClick={closeDetail} aria-label="一覧に戻る" className="flex items-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111b21" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </button>
              </div>
            )}
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-sm text-[#90a4ae]">
              {openKey && detailLoading ? "読み込み中…" : openKey ? (
                // 読み込みに失敗した時（スマホでは一覧が全画面の下に隠れて msg が見えない）→ ここに理由と再読み込みを出す
                msg ? (
                  <>
                    <div className="text-xs px-3 py-2 rounded-lg text-center break-words" style={{ background: "#e3f2fd", color: "#0d47a1" }}>{msg}</div>
                    <button onClick={() => { if (openRef.current) { setMsg(""); void loadDetail(openRef.current, nBatchesRef.current, true); } }}
                      className="text-xs font-bold px-4 py-1.5 rounded-full bg-white" style={{ color: "#1565C0", border: "1px solid #cfd8dc" }}>再読み込み</button>
                  </>
                ) : ""
              ) : "左の一覧からお客様を選んでください"}
            </div>
          </div>
        )}
      </div>
    </div>
    {/* 画像を用意した後に共有シートを開けなかった時（iPhone で押した操作の有効期限切れ）: もう一度押して写真に保存 */}
    {shareReady && (
      <div className="fixed inset-x-0 bottom-0 z-[110] flex items-center gap-2 px-3 pt-3 bg-white shadow-[0_-4px_16px_rgba(0,0,0,0.12)]" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
        <button onClick={() => void openShareSheet(shareReady)} className="flex-1 py-3 rounded-xl text-sm font-bold text-white" style={{ background: "#6a1b9a" }}>
          📲 写真に保存（{shareReady.length}枚）
        </button>
        <button onClick={() => setShareReady(null)} aria-label="閉じる" className="h-11 w-11 shrink-0 rounded-xl text-[#607d8b]" style={{ background: "#eceff1" }}>✕</button>
      </div>
    )}
    {/* 画像のライトボックス（スマホ・LINE の page.tsx 14701 と同じ形: 黒い背景・中央・object-contain） */}
    {lightbox && (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90" onClick={() => setLightbox(null)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={lightbox.url} alt="" className="max-h-[90svh] max-w-[96vw] rounded-xl object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
        <button onClick={() => setLightbox(null)} aria-label="閉じる"
          className="absolute right-4 top-[max(16px,env(safe-area-inset-top))] flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-lg text-white">✕</button>
        {!lightbox.noSave && <button onClick={(e) => { e.stopPropagation(); void saveImage(lightbox.url, lightbox.name); }}
          className="absolute bottom-[max(20px,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 rounded-full bg-white/20 px-4 py-2 text-sm font-bold text-white">💾 保存</button>}
      </div>
    )}
    </>
  );
}
