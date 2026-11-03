// app/lib/compose-checks.ts — 文の設計図の確かめの段の3つ（純関数・DB/LLM なし。⑤の LLM の指示と読み取りもここ）
//
// 2026-11-03 作業員6（竹内さん了承・KB P1「返信の文に3つの確かめ」）:
//   ① 答え漏れ: 書く前にお客様の発言の質問・依頼を1つずつ出して設計図の部品に割り当て、書いた後で全部が「答えた／約束した」かを見る（漏れは1回だけ書き直し）
//   ② 根拠（一番大事）: 下書きの事実の文に元の材料（資料・会社の事実・送った事の台帳・会話）を結ぶ。根拠の無い文は書き換えて消さず、統括に返す
//      （AixSendBack の kind:"no_ground"・作業員2の opts.sendBack の口）。統括が「スタッフしか分からない→AIX／まだ手元に無い→確認の約束」を決める。
//      竹内さん「AIX で返信する部分かの判断のところがちゃんとできるようになれば、間違え防げれるし判断もより正確になる」
//   ⑤ お客様の立場での読み直し: 安い AI（名札 reply_customer_read・LLM_ALT で DeepSeek に回せる）にお客様として読ませ、意味の通らない所・答えていない所があれば1回だけ書き直し
// スイッチ: どれも BRAIN_COMPOSE_BLUEPRINT=on の下で、別々に COMPOSE_CHECK_COVERAGE／COMPOSE_CHECK_GROUND／COMPOSE_CHECK_READER=on（既定 off）。
// テスト: app/lib/__tests__/compose-checks.test.ts
import { splitRequests, type RequestItem } from "./request-ledger";
import { findUngroundedFacts, groundingKinds, type DraftFactHit } from "./draft-fact-grounding";
import { composeBlueprintOn, sentencesOf, tagSentence, type ComposeBlueprint } from "./compose-blueprint";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";
export function composeCheckOn(kind: "coverage" | "ground" | "reader", env: Env = envOf()): boolean {
  if (!composeBlueprintOn(env)) return false;
  return on(kind === "coverage" ? env.COMPOSE_CHECK_COVERAGE : kind === "ground" ? env.COMPOSE_CHECK_GROUND : env.COMPOSE_CHECK_READER);
}

// ── ① 答え漏れ ───────────────────────────────────────────────────────────
export type AskSlot = { quote: string; topic: RequestItem["topic"]; kind: RequestItem["kind"]; part: number | null; keys: string[] };
/** 質問・依頼の大事な語（数字・カタカナ・漢字の2文字以上・依頼の語）。答えたかの照らしに使う */
export function askKeys(quote: string): string[] {
  const t = String(quote ?? "").normalize("NFKC");
  const words = t.match(/[一-龯]{2,}|[ァ-ヶー]{2,}|[0-9]+/g) ?? [];
  const stop = new Set(["ありがとう", "お願い", "宜しく", "よろしく", "大丈夫", "可能", "確認"]);
  return [...new Set(words.filter((w) => !stop.has(w)))].slice(0, 6);
}
const TOPIC_RE: Record<RequestItem["topic"], RegExp> = {
  cost: /初期費用|費用|見積|御見積|総額|円/, vacancy: /募集|空き|空いて|空室|申込が入/, viewing: /内覧|ご案内|見学|待ち合わせ/, screening: /審査|保証会社/,
  photo: /写真|画像|室内/, pickup: /ピックアップ|お部屋|物件|お送り/, move_in: /入居|退去/, equipment: /設備|エアコン|洗濯|駐車|駐輪|ネット|ガス|オートロック/, contract: /契約|書類|申込/, other: /./,
};
/** 書く前: 質問・依頼を1つずつ出し、設計図の部品（main/add）に割り当てる。割り当てられない物は part=null（＝設計図の段で拾える漏れ） */
export function assignAsks(customerUnits: ReadonlyArray<string>, bp: Pick<ComposeBlueprint, "parts">, saidAt = new Date().toISOString()): AskSlot[] {
  const items = splitRequests(customerUnits, saidAt).filter((r) => !r.deferred);
  return items.map((r) => {
    const keys = askKeys(r.quote);
    const idx = bp.parts.findIndex((p) => (p.role === "main" || p.role === "add") && (keys.some((k) => p.say.includes(k)) || (r.topic !== "other" && TOPIC_RE[r.topic].test(p.say))));
    return { quote: r.quote, topic: r.topic, kind: r.kind, part: idx >= 0 ? idx : null, keys };
  });
}
/** 書いた後: 各質問・依頼が「答えた（語か話題が文にある）」か「約束した（約束の文がその話題）」か。どちらでも無い物が漏れ */
export function coverageMisses(draft: string, slots: ReadonlyArray<AskSlot>): Array<AskSlot & { why: string }> {
  const sens = sentencesOf(draft);
  const out: Array<AskSlot & { why: string }> = [];
  for (const s of slots) {
    const hit = sens.some((x) => s.keys.some((k) => x.includes(k)) || (s.topic !== "other" && TOPIC_RE[s.topic].test(x) && tagSentence(x) !== "close"));
    if (!hit) out.push({ ...s, why: s.part == null ? "設計図の部品に割り当てが無い" : "下書きに答え・約束が無い" });
  }
  return out;
}
export function coverageRewriteNote(misses: ReadonlyArray<AskSlot>): string {
  if (!misses.length) return "";
  return ["", "【答え漏れ（1回だけ書き直す）】次のお客様の質問・依頼に、答えるか約束するかの1文が無い。設計図の順を崩さず、添えの位置に足す:",
    ...misses.map((m) => `・「${m.quote.slice(0, 60)}」`)].join("\n");
}

// ── ② 根拠 ──────────────────────────────────────────────────────────────
export type GroundSendBack = { kind: "no_ground"; why: string; sentences: string[]; needs: string[] };
const NEED_JA: Record<string, string> = {
  date: "日付（内覧・入居の日の確定）", time: "時刻", room: "号室", property_name: "物件名", facility: "設備（資料）", area: "広さ（資料）", floor: "階（資料）",
  direction: "向き（資料）", parking: "駐車場（管理会社・資料）", pet: "ペットの可否（管理会社）", cost_item: "初期費用の内訳（見積書）", movein_immediate: "入居可能日（管理会社）",
  vacate: "退去予定（管理会社）", cancel_fee: "キャンセル料（契約書・管理会社）",
};
/** 下書きの事実の文を材料に照らす（既存の draft-fact-grounding の網・誤検知 0 を確かめた種類だけ）。根拠の無い物を統括へ返す形にする */
export function groundCheck(draft: string, groundText: string, env: Env = envOf()): { misses: DraftFactHit[]; sendBack: GroundSendBack | null } {
  const misses = findUngroundedFacts(draft, groundText, groundingKinds(env)).filter((h) => !h.uncertain);
  if (!misses.length) return { misses, sendBack: null };
  const sentences = [...new Set(misses.map((m) => m.sentence))].slice(0, 2);
  const needs = [...new Set(misses.map((m) => NEED_JA[m.kind] ?? m.kind))];
  return {
    misses,
    sendBack: { kind: "no_ground", sentences, needs, why: `根拠の無い事実の文: ${sentences.map((s) => `「${s.slice(0, 50)}」`).join("・")}／要る材料: ${needs.join("・")}` },
  };
}

// ── ⑤ お客様の立場での読み直し（安い AI） ─────────────────────────────────────
export const CUSTOMER_READ_SYSTEM = [
  "あなたは賃貸のお部屋を探しているお客様です。不動産会社の担当者から LINE の返事が来ました。お客様として読み、次の2つだけを答えます（文は直しません）。",
  "1) 意味が通らない所（何を言っているか分からない・前後がぶつかる・同じ事を2回言う）",
  "2) 自分が聞いた・頼んだのに答えていない所（約束してくれているなら答えた扱い）",
  "細かい言い回し・敬語・絵文字・長さは気にしない。無ければ空の配列。",
  "出力は JSON だけ: {\"unclear\":[\"…\"],\"unanswered\":[\"…\"]}",
].join("\n");
export function customerReadPrompt(o: { customerText: string; draft: string }): string {
  return `## あなた（お客様）が送った文\n${o.customerText.slice(0, 600)}\n\n## 担当者からの返事\n${o.draft.slice(0, 900)}`;
}
export type CustomerRead = { unclear: string[]; unanswered: string[] };
export function parseCustomerRead(text: string): CustomerRead | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const arr = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean).slice(0, 3);
    return { unclear: arr(o.unclear), unanswered: arr(o.unanswered) };
  } catch { return null; }
}
export function customerReadRewriteNote(r: CustomerRead | null): string {
  if (!r || (!r.unclear.length && !r.unanswered.length)) return "";
  return ["", "【お客様として読んだ時に引っかかった所（設計図に戻して1回だけ書き直す・設計図の順と役割は変えない）】",
    ...r.unclear.map((x) => `・意味が通らない: ${x}`), ...r.unanswered.map((x) => `・答えていない: ${x}`)].join("\n");
}

/** digest と毎晩の数えの1行（引っかかった数） */
export function composeChecksDigest(o: { coverage?: number | null; ground?: number | null; reader?: CustomerRead | null; rewrote?: boolean; sentBack?: boolean }): string {
  const parts: string[] = [];
  if (o.coverage != null) parts.push(`答え漏れ=${o.coverage}`);
  if (o.ground != null) parts.push(`根拠なし=${o.ground}${o.sentBack ? "（統括へ返した）" : ""}`);
  if (o.reader) parts.push(`読み直し=意味${o.reader.unclear.length}・未回答${o.reader.unanswered.length}`);
  if (o.rewrote != null) parts.push(`書き直し=${o.rewrote ? "1回" : "なし"}`);
  return parts.length ? `compose-checks: ${parts.join(" ")}` : "";
}

// ── ⑥ 読んだ気持ちに文が答えたか（COMPOSE_CHECK_WORRY・既定 off） ─────────────────────────────
// 2026-11-03 作業員6（竹内さん KB P1「お客様の潜在意識と要点を読む部分を6つで強化」⑥）。一番の要点（作業員2の main_point）と
//   奥の心配（ブレインが決めた物・無ければ候補の札）に、下書きが答えたか。語の網なので「答えていない」は候補（書き直し1回は比べで効いてから）。
import { answersWorry, WORRY_JA, type WorryTag } from "./reading-tags";
export function composeCheckWorryOn(env: Env = envOf()): boolean {
  return composeBlueprintOn(env) && on(env.COMPOSE_CHECK_WORRY);
}
/** 要点の語（漢字・カタカナ2文字以上）が下書きに1つも無ければ「要点に答えていない」 */
export function mainPointMissed(draft: string, mainPoint: string | null | undefined): boolean {
  const mp = String(mainPoint ?? "").normalize("NFKC");
  if (!mp.trim()) return false;
  const words = (mp.match(/[一-龯]{2,}|[ァ-ヶー]{2,}/g) ?? []).filter((w) => !["お客様", "返信", "こちら"].includes(w));
  if (!words.length) return false;
  const d = String(draft ?? "").normalize("NFKC");
  return !words.some((w) => d.includes(w));
}
export function worryCheck(draft: string, o: { mainPoint?: string | null; worries: ReadonlyArray<WorryTag> }): { mainMissed: boolean; worryMissed: WorryTag[]; note: string } {
  const mainMissed = mainPointMissed(draft, o.mainPoint);
  const worryMissed = o.worries.filter((w) => !answersWorry(draft, w));
  const note = !mainMissed && !worryMissed.length ? "" : ["", "【読んだ気持ちに答えていない所（1回だけ書き直す・設計図の順と役割は変えない）】",
    mainMissed ? `・一番の要点「${String(o.mainPoint).slice(0, 60)}」がメインの1文に出ていない` : "",
    ...worryMissed.map((w) => `・奥の心配（${WORRY_JA[w]}）に一言も答えていない（添えの位置に1文）`)].filter(Boolean).join("\n");
  return { mainMissed, worryMissed, note };
}
