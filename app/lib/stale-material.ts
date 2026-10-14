// app/lib/stale-material.ts（純関数・DB/LLM なし）
// 「資料が古い」の材料の印: 前にお送りした物件の資料が古い（既定 7日以上）のに、お客様がその物件の空き・内覧・申込・初期費用を聞いてきた番。
//
// 2026-10-14 竹内さん「物件を送った時は最新なので大丈夫だが、お客さんから1週間以上前に送った物件について言われた場合は、
//   募集状況を念のために確認する形の方が正確。ただ複雑になる可能性があるので最善の案で練るように」
// ■ 数えた（scripts/audit-stale-material.ts・60日・LLM なし・2026-10-15）
//   こちらが送った物件を引用・名指しして空き/内覧/申込/初期費用を聞いた番 74。資料（送った・オススメ・物件確認の一番新しい物）からの日数:
//   0〜3日 58・3〜7日 7・7〜14日 7・14〜30日 2・30日〜 0（7日以上 9番＝60日で約1番/週）。名指しの無い「まだ空いてますか」で最後の送付から7日以上 7番。
//   7日以上の空きの質問は4番中3番で竹内さんが物件確認（AIX／確認の約束）をし、2番は募集終了・申込あり・1番は別の階の案内だった。
//   確かめる順の ①売上サポの行（3日以内）は 9番中1・②送った時の SUUMO の URL は 9番中1 しか無い → ①②は作らず、印だけ渡す
//   （確かめる手段の決定論を足すより、材料の印を見たブレインが「確認させて頂きます→AIX【物件確認した】」を選ぶ方が単純）。
// ■ 決め（9eb6aa9c・0593a0aa: 判断はブレイン・規則は網と安全の線だけ）
//   - 決定論は「資料が古い」の印（日数・最後に資料の状態が分かった時刻・その後に確認なし）だけ。確認するか・何と言うかはブレインが決める。
//   - 印を出すのは: こちらが送った/オススメした物件（持ち込みは別の規則）・聞いている事が空き/内覧/申込/初期費用（値下げ含む）・
//     資料（送った・オススメ・物件確認の 募集中/退去予定/別の部屋）から線の日数以上・その後に募集終了が分かっていない時。
//   - 戻す: STALE_MATERIAL_NOTE=off（台帳の文に足さない）。線の日数は STALE_MATERIAL_DAYS（既定 7）。
import type { PtRoom, PtTopic } from "./property-thread";
import { jstParts } from "./jst-date";

export function staleMaterialEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.STALE_MATERIAL_NOTE ?? "").trim().toLowerCase() !== "off";
}
export function staleMaterialDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.STALE_MATERIAL_DAYS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 7;
}

const ASKED_TOPICS: ReadonlySet<PtTopic> = new Set<PtTopic>(["vacancy", "viewing", "cost", "discount"]);
const APPLY_RE = /申込|申し込/;
const FRESH_KINDS = new Set(["sent", "recommended", "check_available", "check_vacating", "check_alternative"]);
const ms = (s: string) => Date.parse(s);

export type StaleMaterial = { days: number; freshAt: string; freshKind: "sent" | "recommended" | "checked"; asked: string };

/**
 * 今の番（askAt・お客様の文・話題）の物件の資料が古いか。古くなければ null。
 * 資料の時刻＝askAt より前の 送った・オススメした・物件確認（募集中/退去予定/別の部屋）の一番新しい物。
 */
export function staleMaterialOf(r: PtRoom, askAt: string, customerText: string, topic: PtTopic, env: Record<string, string | undefined> = process.env): StaleMaterial | null {
  if (!staleMaterialEnabled(env) || r.origin !== "ours") return null;
  const at = ms(askAt);
  if (!Number.isFinite(at)) return null;
  const apply = APPLY_RE.test(customerText) && !/申込金|申込書/.test(customerText);
  if (!apply && !ASKED_TOPICS.has(topic)) return null;
  const before = r.events.filter((e) => ms(e.at) < at);
  if (!before.some((e) => e.kind === "sent" || e.kind === "recommended")) return null;
  const fresh = before.filter((e) => FRESH_KINDS.has(e.kind)).at(-1);
  if (!fresh) return null;
  // 資料の後に募集終了が分かっている物件は、台帳の出来事にもう書いてある（印は要らない）
  if (before.some((e) => e.kind === "check_ended" && ms(e.at) >= ms(fresh.at))) return null;
  const days = (at - ms(fresh.at)) / 86400_000;
  if (days < staleMaterialDays(env)) return null;
  const asked = apply ? "申込" : topic === "vacancy" ? "空き" : topic === "viewing" ? "内覧" : "初期費用";
  return { days, freshAt: fresh.at, freshKind: fresh.kind === "sent" || fresh.kind === "recommended" ? fresh.kind : "checked", asked };
}

/** 台帳の文の1行（▶ の物件の下に足す）。事実と竹内さんの方針だけ・言うかどうかはブレイン */
export function staleMaterialLine(s: StaleMaterial): string {
  const p = jstParts(s.freshAt);
  const what = s.freshKind === "checked" ? "最後に募集状況を確認した" : s.freshKind === "recommended" ? "資料をオススメでお送りした" : "資料をお送りした";
  return `  ・資料が古い: この物件は${p.m}/${p.d}に${what}きり（${Math.floor(s.days)}日前）で、その後の募集状況は分からない（今の番は${s.asked}の話）。`
    + `竹内さんの方針（10/14）: 1週間以上前に送った物件を聞かれた時は、念のため募集状況を確認する方が正確`;
}
