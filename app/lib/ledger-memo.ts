// app/lib/ledger-memo.ts — 送った事のうち重要な5つ（金額・期日・条件との違い・確認の結果・断った事）を、お客様のメモに写す（純関数・決まった手順・LLM なし）
//
// 2026-10-28 竹内さん「送った事でも重要な事はメモに残す」・指揮役の線:
//   目的は2つ: ①スタッフが画面で一目で分かる ②台帳の期間（材料の窓）を過ぎても残る。
//   ブレインへの二重渡しはしない: ブレインの材料は台帳（sent-ledger-bind の結び付け）を正とし、メモの注記ではこの行（id が ledger: で始まる）を省く。
//   写すのは台帳から（LLM の読み取りに頼らない）。消すのはスタッフだけ（自動では外さない・数の上限だけ古い順に外す）。
// 切替: LEDGER_MEMO_SYNC（10/28 から既定 on・off で止める）。テスト: app/lib/__tests__/ledger-memo.test.ts
import type { MemoItem, StoredMemo } from "./customer-memo";
import type { SentItem } from "./sent-ledger-bind";

type Env = Record<string, string | undefined>;
export function ledgerMemoSyncEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  // 10/28 既定 on（YUMA5 で DB に写した行を確かめた・本番12会話の写りを書き込みなしで確かめた）。止める時は LEDGER_MEMO_SYNC=off
  return (env.LEDGER_MEMO_SYNC ?? "on").trim().toLowerCase() !== "off";
}
export const LEDGER_MEMO_PREFIX = "ledger:";
export const LEDGER_MEMO_MAX = 20;
export const isLedgerMemoItem = (x: Pick<MemoItem, "id">) => x.id.startsWith(LEDGER_MEMO_PREFIX);

const JST = 9 * 3600_000;
const md = (iso: string) => { const d = new Date(Date.parse(iso) + JST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const clip = (s: string, n: number) => Array.from(s.replace(/\s+/g, " ").trim()).slice(0, n).join("");
/** 決まった id（同じ事は1行・何度写しても増えない） */
function idOf(kind: string, key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `${LEDGER_MEMO_PREFIX}${kind}:${h.toString(36)}`;
}

const AMOUNT_RE = /(?:初期費用|合計|総額)[^0-9０-９]{0,6}([0-9０-９][0-9０-９,，]*)\s*円/;
const DATE_RE = /([0-9０-９]{1,2})\s*[\/月]\s*([0-9０-９]{1,2})\s*日?(?:から|以降|まで|頃|に)?/;
/** 条件との違い（こちらが正直に伝えた、ご希望と違う所） */
const DIFF_RE = /ご(?:希望|条件)(?:の[^。！!\n]{0,12})?(?:とは異な|と異な|から(?:は)?(?:少し)?離れ|では(?:御座|ござ)いません)|(?:では|は)(?:御座|ござ)いませんが/;

/** こちらの文（手打ち・AIX）から、条件との違い・期日を拾う（金額・確認の結果・断った事は台帳の項目から） */
export function diffAndDateItemsOf(text: string, at: string): Array<{ cat: "diff" | "date"; text: string; at: string }> {
  const out: Array<{ cat: "diff" | "date"; text: string; at: string }> = [];
  for (const s of String(text ?? "").normalize("NFKC").split(/(?<=[。！!？?\n])/).map((x) => x.trim()).filter((x) => x.length >= 6)) {
    if (DIFF_RE.test(s)) out.push({ cat: "diff", text: clip(s, 60), at });
    else if (DATE_RE.test(s) && !/^@/.test(s) && !/[0-9０-９]{1,2}[:：][0-9０-９]{2}/.test(s) && /(?:入居|内覧|ご案内|退去|申込|期限|締め切り|までに)/.test(s) && !/(?:させて頂|させていただ)きます/.test(s)) out.push({ cat: "date", text: clip(s, 60), at });
  }
  return out;
}

/** 5つの重要な事をメモの行にする（同じ事は同じ id） */
export function ledgerMemoItems(o: { items: ReadonlyArray<SentItem>; staffTexts: ReadonlyArray<{ text: string; at: string }>; nowIso: string }): MemoItem[] {
  const rows: MemoItem[] = [];
  const push = (cat: string, key: string, text: string, at: string, property: string | null) => rows.push({
    id: idOf(cat, key), kind: "told", text: clip(text, 60), property, sourceAt: at, sourceQuote: null, sourceBy: "staff",
    certainty: "sure", expiresAt: null, origin: "llm", locked: false, retiredAt: null, updatedAt: o.nowIso,
  });
  for (const i of o.items) {
    if (i.kind === "estimate") {
      const amt = (i.text.normalize("NFKC").match(AMOUNT_RE)?.[1] ?? "").replace(/[，,]/g, "");
      if (amt) push("amount", `${i.name ?? ""}|${amt}`, `【金額】${i.name ? `${i.name} ` : ""}御見積書 初期費用 ${Number(amt).toLocaleString("ja-JP")}円（${md(i.at)}に送付）`, i.at, i.name);
    } else if (i.kind === "check_result") {
      if (!/^(?:募集中|募集終了|退去予定|代わりのお部屋を案内|申込あり|2番手)$/.test(i.text) || !i.name || /^(?:募集状況|確認結果|管理会社)$/.test(i.name)) continue; // 状態が読めない・物件が分からない結果は写さない（画面で意味が分からない）
      push("check", `${i.name ?? ""}|${i.text}`, `【確認の結果】${i.name ? `${i.name}: ` : ""}${i.text}（${md(i.at)}）`, i.at, i.name);
    } else if (i.kind === "declined") {
      push("declined", `${i.topic ?? ""}|${i.text}`, `【お断りした事】${i.topic ? `${i.topic}: ` : ""}${i.text}（${md(i.at)}）`, i.at, i.name);
    }
  }
  for (const t of o.staffTexts) {
    for (const d of diffAndDateItemsOf(t.text, t.at)) push(d.cat, d.text, `【${d.cat === "diff" ? "条件との違い" : "期日"}】${d.text}（${md(d.at)}）`, d.at, null);
  }
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** メモに足す（無い id だけ・スタッフが外した行は戻さない・写した行が上限を超えたら古い順に外す）。変わらなければ null */
export function mergeLedgerMemo(memo: StoredMemo, add: ReadonlyArray<MemoItem>, nowIso: string): StoredMemo | null {
  const have = new Set(memo.items.map((x) => x.id));
  const fresh = add.filter((x) => !have.has(x.id));
  if (!fresh.length) return null;
  let items = [...memo.items, ...fresh];
  const live = items.filter((x) => isLedgerMemoItem(x) && !x.retiredAt).sort((a, b) => Date.parse(a.sourceAt ?? a.updatedAt) - Date.parse(b.sourceAt ?? b.updatedAt));
  const over = live.length - LEDGER_MEMO_MAX;
  if (over > 0) {
    const drop = new Set(live.slice(0, over).map((x) => x.id));
    items = items.map((x) => (drop.has(x.id) ? { ...x, retiredAt: nowIso, retiredReason: "写した行の上限（古い順）" } : x));
  }
  return { ...memo, items };
}
