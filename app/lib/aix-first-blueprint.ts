// app/lib/aix-first-blueprint.ts — AIX の1通目・✨テンプレートを文の設計図の型に乗せる骨組み（純関数・未接続・AIX_FIRST_BLUEPRINT 既定 off）
//
// 2026-11-03 作業員6（竹内さん KB P1「構成を考えるブレインを、返信・AIX の1通目・2通目・テンプレートの全部の文の生成に置く」・統括の順番の3段目）。
//   流れは2通目（second-blueprint.ts）と同じ: 統括の判断（AIX の番・どのボタン×ピッカー＝作業員1の AIX の統括）→ 構成の意図 → 設計図 → 書き手が従う。
//   設計図の根拠に作業員1の担当の札（aix_desk_cards の card_text）を使う: 「送る中身（スタッフだけが知る事）」＝メインの1文の中身、「目的」＝次の手、
//   「似たボタンとの線」＝外れの見張り。札は表の物（DB・会話由来の文は入らない）。
//   竹内さんの AIX の1通目は、物件の札・見積・申込のフォーマット等の定型の塊（表の行）が中心（11/03 の数え: 室内イメージの札 165・かしこまりました→表→締め 69・
//   申込フォーマット 25・挨拶→訴求→締め 22）＝定型の塊は設計図の「材料」として固定し、構成のブレインは前後の文（受け・メイン・締め）だけを決める。
// テスト: app/lib/__tests__/aix-first-blueprint.test.ts
import { buildBlueprint, type ComposeIntent, type ComposeBlueprint, type ComposePurpose, type ComposeClosing, type ComposeNext } from "./compose-blueprint";

export function aixFirstBlueprintOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_FIRST_BLUEPRINT ?? "").trim().toLowerCase() === "on";
}
/** ボタン（catalog key の頭）→ 1通目の既定（2026-11-03 竹内さんの AIX の1通目 直近120日の数え・ボタンごと）:
 *   物件オススメ 306（定型の塊 89%・ご査収 11%・挨拶 5%）／見積書送る 203（塊 98%・締めほぼ無し）／物件ピックアップした 135（ご査収 90%・挨拶 42%）／
 *   物件確認した 101（挨拶 25%・塊 27%・ご査収 20%・何卒 8%）／内覧日調整 60（受け 63%・挨拶 17%）／待ち合わせ 47（受け 96%・何卒 96%）／
 *   申込へ 35（塊 80%・何卒 11%）／条件ヒアリング 23（塊 96%）。 greet は書き出し（多数派）・closing は多数派の締め（2割未満なら none） */
const BUTTON_DEFAULTS: Record<string, { purpose: ComposePurpose; subject: ComposeIntent["main"]["subject"]; closing: ComposeClosing; next: ComposeNext; greet: "name_greet" | "uke" | "none" }> = {
  property_recommendation: { purpose: "appeal", subject: "property", closing: "none", next: "viewing", greet: "none" },
  estimate_sheet: { purpose: "inform", subject: "property", closing: "none", next: "viewing", greet: "none" },
  property_send: { purpose: "appeal", subject: "property", closing: "receipt", next: "viewing", greet: "name_greet" },
  property_check_result: { purpose: "inform", subject: "property", closing: "receipt", next: "viewing", greet: "name_greet" },
  viewing_invite: { purpose: "ask", subject: "us", closing: "none", next: "viewing", greet: "uke" },
  meeting_place: { purpose: "inform", subject: "process", closing: "nanitozo", next: "viewing", greet: "uke" },
  application_push: { purpose: "inform", subject: "process", closing: "none", next: "apply", greet: "none" },
  condition_hearing: { purpose: "ask", subject: "customer", closing: "none", next: "reply", greet: "none" },
  cost_explain: { purpose: "inform", subject: "process", closing: "kigaru", next: "answer_only", greet: "uke" },
  acknowledge_check: { purpose: "promise", subject: "us", closing: "nanitozo", next: "wait_check", greet: "uke" },
  followup_revive: { purpose: "ask", subject: "customer", closing: "kigaru", next: "reply", greet: "name_greet" },
  greeting_viewing: { purpose: "ack", subject: "us", closing: "nanitozo", next: "none", greet: "name_greet" },
};
/** 担当の札（card_text）から設計図の根拠を抜く */
export function readDeskCard(cardText: string): { sends: string | null; purpose: string | null; line: string | null } {
  const t = String(cardText ?? "");
  const pick = (re: RegExp) => (t.match(re)?.[1] ?? "").trim().slice(0, 120) || null;
  return { sends: pick(/送る中身[^:：]*[:：]\s*([^\n]+)/), purpose: pick(/目的[:：]\s*([^\n]+)/), line: pick(/似たボタンとの線[:：]\s*([^\n]+)/) };
}
/** ボタンの書き出し（数えの多数派） */
export function aixFirstGreet(key: string): "name_greet" | "uke" | "none" { return BUTTON_DEFAULTS[key.split("/")[0]]?.greet ?? "uke"; }
export function aixFirstIntent(o: { key: string; cardText?: string | null; why?: string | null }): ComposeIntent {
  const head = o.key.split("/")[0];
  const d = BUTTON_DEFAULTS[head] ?? { purpose: "inform" as ComposePurpose, subject: "us" as const, closing: "nanitozo" as ComposeClosing, next: "none" as ComposeNext, greet: "uke" as const };
  const card = o.cardText ? readDeskCard(o.cardText) : { sends: null, purpose: null, line: null };
  return {
    purpose: d.purpose, why: o.why ?? card.purpose ?? `AIX ${o.key}`, feel: "",
    next: d.next, main: { subject: d.subject, what: card.sends ?? `AIX ${o.key} で送る中身` },
    adds: [], closing: d.closing, confidence: card.sends ? "mid" : "low", source: "fallback",
  };
}
/** 1通目の設計図: 定型の塊（札・見積・フォーマット）は「材料」として固定（書き換えない）、前後の受け・メイン・締めだけ */
export function aixFirstBlueprint(o: { key: string; cardText?: string | null; hasFixedBlock: boolean; why?: string | null }): ComposeBlueprint {
  const intent = aixFirstIntent(o);
  const bp = buildBlueprint({ intent, requirements: [], greet: aixFirstGreet(o.key) });
  if (o.hasFixedBlock) {
    const mi = bp.parts.findIndex((p) => p.role === "main");
    bp.parts.splice(mi >= 0 ? mi + 1 : bp.parts.length, 0, { role: "add", say: "（定型の塊: 物件の札・御見積書・申込フォーマット等をそのまま・1文字も変えない）", from: "material" });
  }
  const card = o.cardText ? readDeskCard(o.cardText) : null;
  if (card?.line) bp.check.issues.push(`似たボタンとの線: ${card.line.slice(0, 60)}`);
  return bp;
}
/** 1通目が定型の塊（札・見積・フォーマット）中心のボタン（11/03 の数えで塊 80% 以上） */
export const AIX_FIRST_FIXED_BLOCK: ReadonlySet<string> = new Set(["property_recommendation", "estimate_sheet", "application_push", "condition_hearing"]);
