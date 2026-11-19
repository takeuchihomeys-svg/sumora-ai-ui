// scripts/lib/compose-prod-elements.ts — 竹内さん本人の実送信と、その番の下書き（line_watch_turns.draft_last）を、文の要素ごとに比べる（純関数・LLM なし）
//   2026-11-15 作業員H（統括役の頼み②・文の当たりを本番で毎日数える物差し）。試験の物差し（compose-gold.evalGoldTurn）と同じ見方をできるだけ使う:
//     頭＝openerOfText（compose-gold）／締め＝closingOfText（compose-brief）／押さえ（主の中身の文の趣旨）＝purposeOfText（compose-blueprint）／
//     信頼＝サポートの文（support）があるか／つなぎ＝誘いの文（内覧・申込の誘い）があるか・どれか／潜在＝竹内さんの文に心配への一言（大丈夫・ご安心・ご不安）があるか
//     事実＝竹内さんの答えの文（info・promise・appeal）の2文字の並びが下書きにある割合（compose-gold.factContentRatio・0.4 以上）／2通目＝竹内さんが同じ番に2通以上送ったか
//   竹内さんの文に無い要素は「数えない」（has=false）。両方に無い頭・締めは同じ型として数える
import { openerOfText, factContentRatio, FACT_CONTENT_MIN } from "./compose-gold";
import { closingOfText } from "../../app/lib/compose-brief";
import { purposeOfText, sentencesOf, tagSentence } from "../../app/lib/compose-blueprint";

export const PROD_ELEMENTS = ["頭", "押さえ", "信頼", "潜在", "つなぎ", "締め", "事実", "2通目"] as const;
export type ProdEl = typeof PROD_ELEMENTS[number];
export type ProdElResult = { el: ProdEl; has: boolean; hit: boolean; detail: string };

const LATENT_RE = /ご安心|ご不安|ご心配|大丈夫です|問題ございません|問題御座いません/;
function inviteOf(text: string): "viewing" | "apply" | "none" {
  const tags = sentencesOf(text).map(tagSentence);
  if (tags.includes("cta_apply")) return "apply";
  if (tags.includes("cta_viewing")) return "viewing";
  const c = closingOfText(text);
  return c === "apply_cta" ? "apply" : c === "viewing_cta" ? "viewing" : "none";
}
/** 竹内さんの答えの中身の文（答え・約束・推し） */
function answerText(text: string): string {
  return sentencesOf(text).filter((s) => ["info", "promise", "appeal", "decline"].includes(tagSentence(s))).join("\n");
}

/** 1番: 竹内さんの実送信（同じ番の文を全部）× 下書き */
export function compareProdTurn(takeuchiTexts: ReadonlyArray<string>, draft: string): ProdElResult[] {
  // 下書きは竹内さんの1通目に当たる（2通目は別の通）＝要素は1通目で比べ、2通目は「2通目の役目が下書きの1通に入っているか」で数える（11/15 の見直し:
  //   旧は全部の通をつないで比べ、2通目の誘い・締めを1通目の下書きの外れに数えていた＝見張り 12406 は1通目の締めが下書きと同じなのに外れ）
  const T = takeuchiTexts[0] ?? "", D = String(draft ?? "");
  const out: ProdElResult[] = [];
  const ot = openerOfText(takeuchiTexts[0] ?? ""), od = openerOfText(D);
  out.push({ el: "頭", has: true, hit: ot === od, detail: `竹内=${ot} 下書き=${od}` });
  const pt = purposeOfText(T).purpose, pd = purposeOfText(D).purpose;
  out.push({ el: "押さえ", has: pt !== "ack", hit: pt === pd, detail: `竹内=${pt} 下書き=${pd}` });
  const st = sentencesOf(T).some((s) => tagSentence(s) === "support"), sd = sentencesOf(D).some((s) => tagSentence(s) === "support");
  out.push({ el: "信頼", has: st, hit: st && sd, detail: `竹内=${st} 下書き=${sd}` });
  const lt = LATENT_RE.test(T), ld = LATENT_RE.test(D);
  out.push({ el: "潜在", has: lt, hit: lt && ld, detail: `竹内=${lt} 下書き=${ld}` });
  const it = inviteOf(T), id = inviteOf(D);
  out.push({ el: "つなぎ", has: it !== "none", hit: it !== "none" && it === id, detail: `竹内=${it} 下書き=${id}` });
  const ct = closingOfText(T), cd = closingOfText(D);
  out.push({ el: "締め", has: true, hit: ct === cd, detail: `竹内=${ct} 下書き=${cd}` });
  const at = answerText(T);
  const fr = at ? factContentRatio(at, D) : { ratio: 0, n: 0 };
  out.push({ el: "事実", has: fr.n > 0, hit: fr.n > 0 && fr.ratio >= FACT_CONTENT_MIN, detail: `重なり=${fr.n ? Math.round(fr.ratio * 100) + "%" : "答えの文なし"}` });
  // 2通目: 竹内さんが返信を2通に分けた番で、2通目の中身の役目（答え・約束・推し・誘い・サポート）が下書きの1通の中にあるか
  const two = takeuchiTexts.length >= 2;
  const MAIN2 = new Set(["info", "promise", "appeal", "support", "cta_viewing", "cta_apply", "ask", "decline"]);
  const t2 = two ? [...new Set(takeuchiTexts.slice(1).flatMap((x) => sentencesOf(x).map(tagSentence)).filter((t) => MAIN2.has(t)))] : [];
  const dTags = new Set(sentencesOf(D).map(tagSentence));
  const has2 = two && t2.length > 0;
  out.push({ el: "2通目", has: has2, hit: has2 && t2.every((t) => dTags.has(t)), detail: `竹内=${takeuchiTexts.length}通（2通目の役目 ${t2.join("+") || "なし"}）` });
  return out;
}
export type ProdTally = Record<ProdEl, { has: number; hit: number }>;
export function tallyProd(rows: ReadonlyArray<ProdElResult[]>): ProdTally {
  const t = Object.fromEntries(PROD_ELEMENTS.map((e) => [e, { has: 0, hit: 0 }])) as ProdTally;
  for (const r of rows) for (const x of r) if (x.has) { t[x.el].has++; if (x.hit) t[x.el].hit++; }
  return t;
}
