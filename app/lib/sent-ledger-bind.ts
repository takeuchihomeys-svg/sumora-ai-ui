// app/lib/sent-ledger-bind.ts — 「こちらが送った事」を項目ごとに拾い、お客様の文が「どの送った事への反応か」を結び付ける（純関数・DB/LLM なし）
//
// 2026-10-28 竹内さんの決定（KB P1「こちらが送った事を根本から理解する — 重要な事はメモに残し、お客様の文がこちらの送った事への反応と
//   判断したら、その送った事に結び付けて読み取る」）・統括の設計図 ①拾う。
// 今まで: 行動台帳 sent_facts・sent-props・SENT_BUNDLES・引用画像の種類・aixHistory・SENT_CONFIRMED_NOTE が別々で、
//   説明した中身（ネット・ガス・保証料・違約金 等）と断った事は残っていなかった（未来穂・てん・☆・長堀橋・和樹）。
// 学び（10/28 SENT_CONFIRMED_NOTE の試験 q183 6/6→3/6・q197〜q199 の依頼の落ち）: 送った物件を全部並べ、場面の決まり（「〜の場面ではない」）まで
//   材料に書くと、依頼を押しのけ・言い切りが強すぎて道が割れた。→ ここは**事実だけ**・**今の発言が指す項目だけ**を短く渡す。どう返すかはブレイン（P0）。
// 切替: SENT_LEDGER_BIND=on（既定 off）。テスト: app/lib/__tests__/sent-ledger-bind.test.ts

type Env = Record<string, string | undefined>;
export function sentLedgerBindEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_LEDGER_BIND ?? "").trim().toLowerCase() === "on";
}

const DAY = 86_400_000;
const norm = (s: string) => String(s ?? "").normalize("NFKC");
const squash = (s: string) => norm(s).replace(/[\s・･\-ー〜~「」『』（）()【】\[\]！!？?、。🌟✨😊😌]/gu, "").toLowerCase();

// ── ① こちらが送った事の項目 ───────────────────────────────────────────────
export type SentItemKind = "property" | "estimate" | "check_result" | "promise" | "explained" | "declined";
export type SentItem = {
  kind: SentItemKind;
  at: string;              // 送った時刻
  name: string | null;     // 物件名（あれば）
  topic: string | null;    // 説明・断りの話題（ネット・ガス・保証料 等）
  text: string;            // 送った中身の要点（80字まで・こちらの文そのまま）
  messageId?: string | null;
};

/** 説明の話題（実送信でよく説明する物・増やす時はここ） */
export const EXPLAIN_TOPICS: ReadonlyArray<[string, RegExp]> = [
  ["ネット", /インターネット|ネット(?:無料|使い放題|回線|環境)|Wi-?Fi|wifi/i],
  ["ガス", /ガス(?:代|料金|会社|の開栓|プロパン|都市ガス)|プロパンガス|都市ガス/],
  ["保証料", /保証料|保証会社の?(?:費用|初回|料金)/],
  ["違約金", /違約金|短期解約/],
  ["鍵交換", /鍵交換/],
  ["火災保険", /火災保険/],
  ["仲介手数料", /仲介手数料/],
  ["更新料", /更新料/],
  ["退去費用", /退去(?:費用|時の費用)|クリーニング(?:費|代)/],
  ["駐車場", /駐車場|駐輪場|バイク置き場/],
  ["ペット", /ペット(?:可|飼育|相談)/],
  ["初期費用の中身", /初期費用(?:の内訳|には|に含まれ)|日割(?:家賃|り家賃)/],
  ["入居日", /最短(?:で)?(?:の)?(?:ご)?入居|入居可能日|ご入居(?:頂ける|可能)/],
  ["審査", /審査(?:の流れ|期間|に通|には|が通)/],
];
/** お客様の文の話題（こちらの説明より緩く・語の幹だけ） */
export const CUSTOMER_TOPICS: ReadonlyArray<[string, RegExp]> = [
  ["ネット", /ネット|wi-?fi|ワイファイ/i], ["ガス", /ガス/], ["保証料", /保証料|保証会社/], ["違約金", /違約金|短期解約|解約/], ["鍵交換", /鍵/],
  ["火災保険", /火災保険|保険/], ["仲介手数料", /仲介/], ["更新料", /更新/], ["退去費用", /退去|クリーニング/], ["駐車場", /駐車|駐輪|バイク/],
  ["ペット", /ペット|犬|猫/], ["初期費用の中身", /初期費用|日割/], ["入居日", /入居/], ["審査", /審査/], ["保証会社", /保証会社/], ["見積", /見積|初期費用|費用/],
];
const EXPLAIN_SHAPE_RE = /(?:となります|になります|かかります|御座います|ございます|無料|込み|含まれ|円|ヶ月|か月|日|可能です|出来ます|できます|不要)/;
const DECLINE_RE = /(?:難しい|出来かね|できかね|出来ません|できません|不可|お断り|対応して(?:おり|い)ません|ご希望に(?:添え|沿え)ず)/;
const PROMISE_RE = /(?:させて頂きます|させていただきます|お送りさせて|ご連絡させて|確認させて|ピックアップさせて)/;

function sentencesOf(text: string): string[] {
  return norm(text).split(/(?<=[。！!？?\n])/).map((s) => s.trim()).filter((s) => s.length >= 4);
}
const clip = (s: string, n: number) => Array.from(s.replace(/\s+/g, " ").trim()).slice(0, n).join("");

/** こちらの1通（手打ち・AIX）から、説明した事・断った事を項目にする（送った物件・見積・確認の結果・約束は行動台帳の行を使う） */
export function explainedItemsOf(text: string, at: string, messageId?: string | null): SentItem[] {
  const out: SentItem[] = [];
  const seen = new Set<string>();
  for (const s of sentencesOf(text)) {
    const decline = DECLINE_RE.test(s);
    for (const [topic, re] of EXPLAIN_TOPICS) {
      if (!re.test(s)) continue;
      const kind: SentItemKind = decline ? "declined" : EXPLAIN_SHAPE_RE.test(s) && !PROMISE_RE.test(s) ? "explained" : "promise";
      if (kind === "promise") continue; // 約束は行動台帳が持つ（ここで二重に持たない）
      const k = `${kind}:${topic}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind, at, name: null, topic, text: clip(s, 80), messageId: messageId ?? null });
    }
  }
  return out;
}

// ── ② 行動台帳の行を項目にそろえる ─────────────────────────────────────────
export type LedgerLike = { kind: string; status: string; at: string | null; evidence?: string | null; detail?: { propertyNames?: string[]; estimateFor?: string[] | null; object?: string | null; propStatuses?: string[]; guarantors?: Array<{ name: string; company: string; type: string }> } | null };
export function itemsFromLedger(entries: ReadonlyArray<LedgerLike>): SentItem[] {
  const out: SentItem[] = [];
  for (const e of entries) {
    if (!e.at) continue;
    const ev = clip(String(e.evidence ?? ""), 80);
    if (e.kind === "properties_sent" && e.status === "done") {
      for (const n of e.detail?.propertyNames ?? []) if (String(n ?? "").trim()) out.push({ kind: "property", at: e.at, name: String(n).trim(), topic: null, text: ev });
    } else if (e.kind === "estimate_sent" && e.status === "done") {
      const names = (e.detail?.estimateFor ?? []).filter(Boolean);
      if (names.length) for (const n of names) out.push({ kind: "estimate", at: e.at, name: n, topic: "見積", text: ev });
      else out.push({ kind: "estimate", at: e.at, name: null, topic: "見積", text: ev });
    } else if (e.kind === "confirmation_reported") {
      const names = e.detail?.propertyNames ?? [];
      if (names.length) names.forEach((n, k) => out.push({ kind: "check_result", at: e.at!, name: n, topic: "確認の結果", text: clip(`${e.detail?.propStatuses?.[k] ? `${e.detail.propStatuses[k]}・` : ""}${ev}`, 80) }));
      else out.push({ kind: "check_result", at: e.at, name: e.detail?.object ?? null, topic: "確認の結果", text: ev });
    } else if (e.kind === "guarantor_explained" && e.detail?.guarantors?.length) {
      for (const g of e.detail.guarantors) out.push({ kind: "explained", at: e.at, name: g.name, topic: "保証会社", text: clip(`${g.company}（${g.type}）`, 80) });
    } else if (e.kind === "cost_explained" || e.kind === "cost_breakdown_explained") {
      out.push({ kind: "explained", at: e.at, name: null, topic: "初期費用の中身", text: ev });
    } else if (e.status === "promised") {
      out.push({ kind: "promise", at: e.at, name: e.detail?.object ?? null, topic: e.kind, text: ev });
    }
  }
  return out;
}

// ── ③ どの送った事への反応か ───────────────────────────────────────────────
export type BindResult = { item: SentItem; by: "quote" | "name" | "topic" | "recent"; others: number } | null;

/** 物件名の頭（号室・記号を落とした先頭6〜8字）が文にあるか */
function nameHit(text: string, name: string | null): boolean {
  if (!name) return false;
  const t = squash(text);
  const n = squash(name.replace(/\s*[A-Za-z]?[0-9]{1,5}\s*(?:号室|号)?\s*$/, ""));
  if (n.length < 3) return false;
  return t.includes(n) || (n.length >= 5 && t.includes(n.slice(0, Math.min(8, Math.max(5, n.length - 1)))));
}

/**
 * お客様の今の文（引用があれば引用された通の本文も）が、どの送った事への反応かを決める。
 *   手がかりの強い順: 引用（引用された通の項目）→ 物件名の頭 → 話題 → 直前に送った物（3時間以内・お客様の文に指示語「これ・こちら・その」か短文）
 *   決まらない時は null（推測で結ばない）
 */
export function bindReaction(o: { customerText: string; quotedText?: string | null; quotedMessageId?: string | null; items: ReadonlyArray<SentItem>; nowMs: number }): BindResult {
  const items = [...o.items].filter((i) => Date.parse(i.at) <= o.nowMs + 60_000).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!items.length) return null;
  const text = norm(o.customerText ?? "");
  if (o.quotedMessageId) {
    const q = items.filter((i) => i.messageId && i.messageId === o.quotedMessageId);
    if (q.length) return { item: q[0], by: "quote", others: q.length - 1 };
  }
  if (o.quotedText) {
    const qt = squash(o.quotedText);
    const q = items.filter((i) => (i.name && nameHit(o.quotedText!, i.name)) || (i.text && qt.includes(squash(i.text).slice(0, 12))));
    if (q.length) return { item: q[0], by: "quote", others: q.length - 1 };
  }
  const byName = items.filter((i) => nameHit(text, i.name));
  if (byName.length) {
    const names = new Set(byName.map((i) => i.name));
    return { item: byName[0], by: "name", others: names.size - 1 };
  }
  const topics = CUSTOMER_TOPICS.filter(([, re]) => re.test(text)).map(([t]) => t);
  if (topics.length) {
    const byTopic = items.filter((i) => i.topic && topics.includes(i.topic));
    if (byTopic.length) return { item: byTopic[0], by: "topic", others: byTopic.length - 1 };
  }
  const last = items[0];
  const recent = o.nowMs - Date.parse(last.at) <= 3 * 3600_000;
  if (recent && (/(?:これ|こちら|その|そこ|ここ|この)/.test(text) || Array.from(text.trim()).length <= 25)) return { item: last, by: "recent", others: 0 };
  return null;
}

// ── ④ 材料の1行（事実だけ・短く） ──────────────────────────────────────────
const KIND_JA: Record<SentItemKind, string> = { property: "送った物件", estimate: "送った御見積書", check_result: "伝えた確認の結果", promise: "こちらの約束", explained: "こちらが説明した事", declined: "こちらがお断りした事" };
const BY_JA = { quote: "引用", name: "物件名", topic: "話題", recent: "直前に送った物" } as const;
function ageJa(at: string, nowMs: number): string {
  const d = Math.floor((nowMs - Date.parse(at)) / DAY);
  return d <= 0 ? "今日" : `${d}日前`;
}
/** 結び付けの材料（決まらない時は ""）。送った物件で7日以内なら「送った時点で募集中を確認済み」の事実を1つだけ添える（SENT_CONFIRMED の吸収） */
export function bindMaterialLine(b: BindResult, nowMs: number): string {
  if (!b) return "";
  const i = b.item;
  const what = [i.name, i.topic && i.kind !== "property" ? i.topic : null].filter(Boolean).join("・");
  const fresh = i.kind === "property" && nowMs - Date.parse(i.at) <= 7 * DAY ? "（こちらが探して送った物件＝送った時点で募集中を確認済み）" : "";
  const body = i.text ? `：「${i.text}」` : "";
  const more = b.others > 0 ? `（ほかにも当てはまる送った事が${b.others}件・どれへの反応かはあなたが会話から決める）` : "";
  return `【この発言が指す、こちらが送った事（${BY_JA[b.by]}から）】${KIND_JA[i.kind]}${what ? `「${what}」` : ""}（${ageJa(i.at, nowMs)}）${body}${fresh}${more}`;
}
