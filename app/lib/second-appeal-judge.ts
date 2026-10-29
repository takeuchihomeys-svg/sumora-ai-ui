// app/lib/second-appeal-judge.ts — AIX の2通目の「訴求の判断」（ブレインが決め、書き手は従う）＋竹内さんの型と手本（純関数）
//
// 2026-10-29 作業員5（竹内さん KB 585ec774「ここもブレインの判断でこのお客さんに対する訴求する部分をお客さんに合わせて行う。竹内がそうしているように」・
//   9f4f0b48「2通目はお客様に刺さるかを決める一番大事な文」・「今までの竹内が送っているのを参考に。1つや2つだけじゃなくて」）。
//   形: ①候補を拾う網（second-appeal-points.ts の rankAppealPoints＝決定論は網だけ）→ ②ブレインの訴求の判断（LLM・このお客様に一番刺さる物・2番目・言う数・言い方の型・締めを理由つきで）
//       → ③書き手は判断に従い、竹内さんの型の要約（場面ごとの数と言い回し・SECOND_TAKEUCHI_FORMS）と近い手本（SECOND_TAKEUCHI_EXAMPLES から場面と訴求の近さで3通）で書く。
//   判断の材料: 状況のまとめ（ブレインの latent_intent・不安・こだわり・状況・希望の条件）と物件の事実（1通目・資料）。お客様の判断はブレインの番の物（last_brain_meta）。
//   スイッチ AIX_SECOND_APPEAL_JUDGE（既定 off・second-appeal-points の注記 AIX_SECOND_APPEAL_POINTS の代わりに使う）。
import { SECOND_TAKEUCHI_FORMS, SECOND_TAKEUCHI_EXAMPLES } from "./second-takeuchi-data";
import { APPEAL_ELEMENTS, rankAppealPoints, firstMessagePoints, elementsOf, type AppealInput } from "./second-appeal-points";

export function secondAppealJudgeOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_SECOND_APPEAL_JUDGE ?? "").trim().toLowerCase() === "on";
}

/** ピッカー（pickupType）→ 竹内さんの型の場面 */
export function secondFormScene(pickupType: string | null | undefined): string {
  const p = String(pickupType ?? "");
  if (/新着/.test(p)) return "物件オススメ・新着1件";
  if (/継続/.test(p)) return "物件オススメ・継続ピックアップ";
  if (/代替/.test(p)) return "物件オススメ・代替ピックアップ";
  if (/広げ/.test(p)) return "物件オススメ・条件広げピックアップ";
  return "物件オススメ・新規ピックアップ";
}
const ELJA = (k: string) => APPEAL_ELEMENTS.find((e) => e.key === k)?.ja ?? k;
const LINKJA: Record<string, string> = {
  gap_first: "希望とのずれを先に言って勧める（〜となりますが）", life_fit: "暮らし方に合う（同棲・お二人・ペットに最適）", name_osusume: "〇〇さんにかなりオススメ出来るお部屋",
  special_pick: "お送りさせて頂きましたお部屋の中でも特に", new_listing: "新着で…募集に出ました", good_terms: "好条件のお部屋", screening_ease: "審査が通りやすい（独立系の保証会社）",
};
/** 竹内さんの型の要約（場面ごと・数と言い回し） */
export function takeuchiFormSummary(scene: string): string {
  const f = SECOND_TAKEUCHI_FORMS[scene] ?? SECOND_TAKEUCHI_FORMS["物件オススメ・新規ピックアップ"];
  if (!f) return "";
  return [
    `【竹内さんの2通目の型（${scene}・${f.n}通から）】`,
    `・訴求の数は平均 ${f.avgPoints}（1〜2個を強く・並べすぎない）。一番に言う物: ${f.first.map((x) => `${ELJA(x.el)} ${x.pct}%`).join("・")}`,
    `・結び方: ${f.links.map((x) => `${LINKJA[x.key] ?? x.key} ${x.pct}%`).join("・")}`,
    `・締め: ${f.closing.map((x) => `${({ viewing: "内覧へ", apply: "申込へ", receipt: "ご査収", none: "締めなし" } as Record<string, string>)[x.kind] ?? x.kind.replace(/\+/g, "＋")} ${x.pct}%`).join("・")}`,
    `・よく使う言い回し（回数）: ${f.phrases.slice(0, 8).map((x) => `「${x.text}」${x.n}`).join("・")}`,
  ].join("\n");
}
/** 手本: 同じ場面で、今の候補の訴求の要素と近い竹内さんの2通目を最大 n 通（決め打ちにしない） */
export function pickTakeuchiExamples(scene: string, wantEls: string[], n = 3): string[] {
  const want = new Set(wantEls);
  const scored = SECOND_TAKEUCHI_EXAMPLES.map((e, i) => ({ e, i, s: (e.scene === scene ? 2 : 0) + e.els.filter((x) => want.has(x)).length - Math.max(0, e.els.length - 3) * 0.3 }))
    .sort((a, b) => b.s - a.s || b.e.at.localeCompare(a.e.at));
  const out: string[] = [];
  const seenFirst = new Set<string>();
  for (const x of scored) {
    if (out.length >= n) break;
    const head = x.e.text.slice(0, 18);
    if (seenFirst.has(head)) continue; // 似た書き出しを重ねない
    seenFirst.add(head);
    out.push(x.e.text);
  }
  return out;
}

export type AppealJudge = {
  first: { text: string; why: string };
  second: { text: string; why: string } | null;
  count: 1 | 2;
  form: string;
  closing: "viewing" | "apply" | "receipt";
  closingWhy: string;
};
export const APPEAL_JUDGE_SYSTEM = [
  "あなたは賃貸仲介会社の営業の統括（ブレイン）です。お客様に物件を1件オススメする LINE の2通目で、何を訴求するかを決めます（文は書きません）。",
  "竹内さん（社長）は、そのお客様の希望・こだわり・不安・暮らし方・今の状況に合わせて、物件の事実のうち一番刺さる物を1〜2個だけ強く言います。一般的な設備の羅列はしません。",
  "決める物: first（一番刺さる物＝下の物件の事実の候補から1つ・お客様の何に応えるかの理由）・second（2番目・無ければ null）・count（1か2）・form（言い方の型を1つ: 下の型の要約の結び方から）・closing（viewing＝内覧へ／apply＝申込へ／receipt＝ご査収だけ）と理由。",
  "締めの決まり（竹内さん 10/29 確認事項 No.34）: 退去予定でまだ内覧できない部屋→receipt（お手隙の際にご査収）が基本。apply（申込へ）は、入居が近い・お客様が急いでいる・かなり刺さっている（前向きな言葉がある）時だけ。今内覧できる部屋は、希望の条件に合っていれば刺さると見て viewing（竹内さんは空室の2通目の64%で内覧に誘う）。条件のずれが大きい・お客様が様子見・比べている途中の時だけ receipt。下の「締めの候補になる状況」（新着1件で先に申込が入りそう・入居が近い）がある時は、条件にぴったり合う時だけ apply も選ぶ（候補が無ければ上の決まりのまま）。",
  "物件の事実は候補に書いてある事だけ。候補に無い事実・金額・節約額は使わない。",
  "出力は JSON だけ: {\"first\":{\"text\":\"…\",\"why\":\"…\"},\"second\":{\"text\":\"…\",\"why\":\"…\"}|null,\"count\":1|2,\"form\":\"…\",\"closing\":\"viewing\"|\"apply\"|\"receipt\",\"closingWhy\":\"…\"}",
].join("\n");

/** 判断の入力（候補は網・お客様の要点はブレイン） */
export function appealJudgePrompt(i: AppealInput & { situation?: string | null; scene: string; notViewable: boolean; materialFacts?: string | null; closingCandidates?: string[] }): { prompt: string; candidates: string[] } {
  const net = rankAppealPoints(i).map((p) => p.text);
  const allLines = firstMessagePoints(i.firstMessage);
  const candidates = [...new Set([...net, ...allLines])].slice(0, 10);
  const prompt = [
    `## お客様（ブレインの状況のまとめ）\n${(i.customerPoints ?? "").slice(0, 700) || "（無し）"}`,
    i.situation ? `## 今の状況\n${i.situation.slice(0, 200)}` : "",
    `## 希望の条件\n${(i.conditions ?? "").slice(0, 300) || "（無し）"}`,
    `## 物件の事実の候補（1通目のオススメポイント・網が刺さりそうな順に先頭）\n${candidates.map((c, k) => `${k + 1}. ${c}`).join("\n") || "（無し）"}`,
    i.materialFacts ? `## 資料の事実\n${i.materialFacts.slice(0, 400)}` : "",
    `## 内覧\n${i.notViewable ? "まだ内覧できない（退去予定等）" : "今内覧できる"}`,
    i.closingCandidates?.length ? `## 締めの候補になる状況（網が拾った物・決めるのはあなた）\n${i.closingCandidates.map((c) => `・${c}`).join("\n")}` : "",
    takeuchiFormSummary(i.scene),
  ].filter(Boolean).join("\n\n");
  return { prompt, candidates };
}

export function parseAppealJudge(text: string): AppealJudge | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const f = o.first as { text?: unknown; why?: unknown } | undefined;
    if (!f || typeof f.text !== "string" || !f.text.trim()) return null;
    const s = o.second as { text?: unknown; why?: unknown } | null | undefined;
    const closing = String(o.closing ?? "");
    if (!/^(?:viewing|apply|receipt)$/.test(closing)) return null;
    return {
      first: { text: f.text.trim().slice(0, 120), why: String(f.why ?? "").slice(0, 120) },
      second: s && typeof s.text === "string" && s.text.trim() ? { text: s.text.trim().slice(0, 120), why: String(s.why ?? "").slice(0, 120) } : null,
      count: Number(o.count) === 2 ? 2 : 1,
      form: String(o.form ?? "").slice(0, 60),
      closing: closing as AppealJudge["closing"],
      closingWhy: String(o.closingWhy ?? "").slice(0, 120),
    };
  } catch { return null; }
}

/** 書き手への注記（判断・型・手本）。書き手は並べ直さない */
export function judgedAppealNote(j: AppealJudge, scene: string): string {
  const wantEls = [...elementsOf(j.first.text), ...(j.second ? elementsOf(j.second.text) : [])];
  const ex = pickTakeuchiExamples(scene, wantEls, 3);
  return [
    "",
    "【ブレインの訴求の判断（この通りに書く・自分で並べ直さない）】",
    `・一番に言う物: ${j.first.text}（理由: ${j.first.why}）`,
    j.second && j.count === 2 ? `・2番目: ${j.second.text}（理由: ${j.second.why}）` : "・2番目: 言わない（1個を強く）",
    `・言い方の型: ${j.form}`,
    `・締め: ${({ viewing: "内覧へ（お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます）", apply: "申込へ（お気に召されましたらお申込しお部屋抑えさせて頂きます）", receipt: "ご査収だけ（誘いを足さない）" })[j.closing]}（理由: ${j.closingWhy}）`,
    "・上に無い設備・駅・築年を並べ足さない。事実は1通目・資料にある事だけ。金額・節約額は書かない（初期費用は「敷金礼金なしで初期費用を抑える事ができ」の言い方まで）。",
    takeuchiFormSummary(scene),
    ex.length ? `【竹内さんの2通目の手本（場面と訴求が近い物・写さず型だけ使う）】\n${ex.map((t, k) => `${k + 1}) ${t.replace(/\n+/g, " ")}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

/** 2通目の訴求の数（挨拶・締めの行は数えない・「敷金礼金なし＋初期費用を抑える」は1つ）。出た後の確かめ用 */
export function countAppeals(text: string): number {
  const body = String(text ?? "").split(/\n/).filter((l) => !/お手隙|ご査収|お気に召され|お気軽|お世話になって/.test(l)).join("\n");
  const els = new Set(APPEAL_ELEMENTS.filter((e) => e.re.test(body)).map((e) => e.key));
  if (els.has("shikirei") && els.has("saving")) els.delete("saving");
  return els.size;
}
/** 判断した数を超えて並べたか（竹内さんの2通目は平均 2.4＝言い回し1つが2要素に当たる分を1つ見込む） */
export function overAppealCount(text: string, j: Pick<AppealJudge, "count">): boolean {
  return countAppeals(text) > j.count + 1;
}

/** 締めの候補になる状況（決定論の網・決めるのはブレイン）。竹内さんが申込で締めた番の型（10/29・30番中4番）:
 *   新着1件で条件に合う（先に申込が入りそう）／見積書を送った後で費用の話が進んでいる／退去予定でも入居の希望時期が近い（今月か来月）／お客様が急いでいる */
export function closingCandidatesOf(i: { newListing: boolean; estimateSent: boolean; vacating: boolean; customerText: string; nowMonth: number }): string[] {
  const out: string[] = [];
  if (i.newListing) out.push("新着1件で、条件に合えば先に申込が入りそう → 申込で抑える候補");
  // 10/29 2回目: 見積書の後・急ぎは網が広すぎた（内覧 15→9/16・ご査収 6→2/10）→ 新着1件と入居が近い時だけ候補にする
  const m = i.customerText.match(/([0-9０-９]{1,2})月(?:頭|上旬|中旬|下旬|末|中|から|頃|位|くらい)/);
  const want = m ? Number(m[1].replace(/[０-９]/g, (d) => String("０１２３４５６７８９".indexOf(d)))) : null;
  if (want != null && want >= 1 && want <= 12 && ((want - i.nowMonth + 12) % 12) <= 1) out.push(`お客様の入居の希望が${want}月（今月か来月）＝入居が近い → ${i.vacating ? "退去予定でも" : ""}申込で抑える候補`);
  return out;
}
