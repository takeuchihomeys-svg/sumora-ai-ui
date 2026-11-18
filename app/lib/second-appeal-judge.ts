// app/lib/second-appeal-judge.ts — AIX の2通目の「訴求の判断」（ブレインが決め、書き手は従う）＋竹内さんの型と手本（純関数）
//
// 2026-10-29 作業員5（竹内さん KB 585ec774「ここもブレインの判断でこのお客さんに対する訴求する部分をお客さんに合わせて行う。竹内がそうしているように」・
//   9f4f0b48「2通目はお客様に刺さるかを決める一番大事な文」・「今までの竹内が送っているのを参考に。1つや2つだけじゃなくて」）。
//   形: ①候補を拾う網（second-appeal-points.ts の rankAppealPoints＝決定論は網だけ）→ ②ブレインの訴求の判断（LLM・このお客様に一番刺さる物・2番目・言う数・言い方の型・締めを理由つきで）
//       → ③書き手は判断に従い、竹内さんの型の要約（場面ごとの数と言い回し・second_takeuchi_forms）と近い手本（second_takeuchi_examples から場面と訴求の近さで3通）で書く。
//   判断の材料: 状況のまとめ（ブレインの latent_intent・不安・こだわり・状況・希望の条件）と物件の事実（1通目・資料）。お客様の判断はブレインの番の物（last_brain_meta）。
//   スイッチ AIX_SECOND_APPEAL_JUDGE（10/29 既定 on・戻す: off。同じ30番2回: 締めが同じ 10→21・一番の訴求 6→11・合格 18→17.5・申込の締め 2/4→0/4 は次の改善）。
import type { SecondFormData } from "./second-takeuchi-build";
/** 手本・型の要約（DB の second_takeuchi_examples・second_takeuchi_forms を second-takeuchi-data-server.ts が読む。会話由来の文は倉庫に置かない） */
export type SecondTakeuchiInput = { forms: Record<string, SecondFormData>; examples: Array<{ scene: string; els: string[]; body: string; sent_on: string }> };
import { APPEAL_ELEMENTS, rankAppealPoints, firstMessagePoints, elementsOf, type AppealInput } from "./second-appeal-points";

export function secondAppealJudgeOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_SECOND_APPEAL_JUDGE ?? "on").trim().toLowerCase() !== "off";
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
export function takeuchiFormSummary(scene: string, forms: SecondTakeuchiInput["forms"], rich = false): string {
  const f = forms[scene] ?? forms["物件オススメ・新規ピックアップ"];
  if (!f) return "";
  return [
    `【竹内さんの2通目の型（${scene}・${f.n}通から）】`,
    `・訴求の数は平均 ${f.avgPoints}${rich ? "（設備が揃ったお部屋は3〜5個・一番刺さる物を先頭）" : "（1〜2個を強く・並べすぎない）"}。一番に言う物: ${f.first.map((x) => `${ELJA(x.el)} ${x.pct}%`).join("・")}`,
    `・結び方: ${f.links.map((x) => `${LINKJA[x.key] ?? x.key} ${x.pct}%`).join("・")}`,
    `・締め: ${f.closing.map((x) => `${({ viewing: "内覧へ", apply: "申込へ", receipt: "ご査収", none: "締めなし" } as Record<string, string>)[x.kind] ?? x.kind.replace(/\+/g, "＋")} ${x.pct}%`).join("・")}`,
    `・よく使う言い回し（回数）: ${f.phrases.slice(0, 8).map((x) => `「${x.text}」${x.n}`).join("・")}`,
  ].join("\n");
}
/** 手本: 同じ場面で、今の候補の訴求の要素と近い竹内さんの2通目を最大 n 通（決め打ちにしない） */
export function pickTakeuchiExamples(examples: SecondTakeuchiInput["examples"], scene: string, wantEls: string[], n = 3): string[] {
  const want = new Set(wantEls);
  const scored = examples.map((e, i) => ({ e, i, s: (e.scene === scene ? 2 : 0) + e.els.filter((x) => want.has(x)).length - Math.max(0, e.els.length - 3) * 0.3 }))
    .sort((a, b) => b.s - a.s || b.e.sent_on.localeCompare(a.e.sent_on));
  const out: string[] = [];
  const seenFirst = new Set<string>();
  for (const x of scored) {
    if (out.length >= n) break;
    const head = x.e.body.slice(0, 18);
    if (seenFirst.has(head)) continue; // 似た書き出しを重ねない
    seenFirst.add(head);
    out.push(x.e.body);
  }
  return out;
}

// ── 推す点の数を場面で変える（2026-11-18 竹内さんの決定・統括役から作業員K・SECOND_APPEAL_COUNT_BY_SCENE・既定 off）─────────
//   竹内さんの選び A: 「設備が揃った部屋は、刺さる事実を3〜5個並べ、一番刺さる物を先頭に置く。それ以外は1〜2個」。
//   線（推測でなく竹内さんの物件オススメの2通目 92通（訴求0個を除く）で引いた）: 1通目の設備（下の表）が 5個以上の部屋 21通では 3個以上並べた通が 57%、
//   5個未満の 71通では 35%（4個以上の線は 48%／35%・3個以上は 46%／33% で、5個が一番よく分かれた）。場面（新着・新規）・お客様の希望の数では分かれなかった。
//   手元の写し（.claude/exam-cache/aix-text-exam/raw-second-appeal.json）で測った台本は作業員K の手元（equip-line.ts）。
export function secondAppealCountBySceneOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.SECOND_APPEAL_COUNT_BY_SCENE ?? "").trim().toLowerCase() === "on";
}
const EQUIPMENT_ITEMS: Array<[string, RegExp]> = [
  ["ネット無料", /(?:インターネット|ネット|Wi-?Fi)(?:無料|使用料不要|使い放題)/], ["浴室乾燥機", /浴室乾燥/], ["独立洗面台", /独立洗面|洗面所独立/],
  ["追い焚き", /追い?焚き|追焚/], ["バス・トイレ別", /バス・?トイレ別|BT別/], ["オートロック", /オートロック/], ["宅配ボックス", /宅配ボックス|宅配BOX/i],
  ["システムキッチン", /システムキッチン/], ["2口以上コンロ", /[2２3３]口(?:以上)?(?:の)?(?:ガス|IH)?コンロ/], ["温水洗浄便座", /温水洗浄便座|ウォシュレット/],
  ["モニター付インターホン", /モニター付き?インターホン|TVモニタ/], ["室内洗濯機置場", /室内洗濯機置場|室内洗濯/], ["エアコン", /エアコン/], ["ロフト", /ロフト/],
  ["床暖房", /床暖房/], ["食洗機", /食洗機|食器洗/], ["ウォークインクローゼット", /ウォークイン|WIC/i], ["防犯カメラ", /防犯カメラ/],
];
/** 1通目（物件の事実）に書いてある設備 */
export function equipmentItemsOf(first: string | null | undefined): string[] {
  const t = String(first ?? "");
  return EQUIPMENT_ITEMS.filter(([, re]) => re.test(t)).map(([k]) => k);
}
export const EQUIPMENT_RICH_MIN = 5;
/** 設備が揃った部屋（1通目の設備が5個以上） */
export function equipmentRichOf(first: string | null | undefined): boolean {
  return equipmentItemsOf(first).length >= EQUIPMENT_RICH_MIN;
}

export type AppealJudge = {
  first: { text: string; why: string };
  second: { text: string; why: string } | null;
  /** 3番目以降（設備が揃った部屋で 3〜5個並べる時だけ・SECOND_APPEAL_COUNT_BY_SCENE） */
  more?: Array<{ text: string; why: string }>;
  count: 1 | 2 | 3 | 4 | 5;
  form: string;
  closing: "viewing" | "apply" | "receipt";
  closingWhy: string;
};
export const APPEAL_JUDGE_SYSTEM = [
  "あなたは賃貸仲介会社の営業の統括（ブレイン）です。お客様に物件を1件オススメする LINE の2通目で、何を訴求するかを決めます（文は書きません）。",
  "竹内さん（社長）は、そのお客様の希望・こだわり・不安・暮らし方・今の状況に合わせて、物件の事実のうち一番刺さる物を1〜2個だけ強く言います。一般的な設備の羅列はしません。",
  "決める物: first（一番刺さる物＝下の物件の事実の候補から1つ・お客様の何に応えるかの理由）・second（2番目・無ければ null）・count（1か2）・form（言い方の型を1つ: 下の型の要約の結び方から）・closing（viewing＝内覧へ／apply＝申込へ／receipt＝ご査収だけ）と理由。",
  "締めの決まり（竹内さん 10/29 確認事項 No.34）: 退去予定でまだ内覧できない部屋→receipt（お手隙の際にご査収）が基本。apply（申込へ）は、入居が近い・お客様が急いでいる・かなり刺さっている（前向きな言葉がある）時だけ。今内覧できる部屋は、希望の条件に合っていれば刺さると見て viewing（竹内さんは空室の2通目の64%で内覧に誘う）。条件のずれが大きい・お客様が様子見・比べている途中の時だけ receipt。",
  "物件の事実は候補に書いてある事だけ。候補に無い事実・金額・節約額は使わない。",
  "出力は JSON だけ: {\"first\":{\"text\":\"…\",\"why\":\"…\"},\"second\":{\"text\":\"…\",\"why\":\"…\"}|null,\"count\":1|2,\"form\":\"…\",\"closing\":\"viewing\"|\"apply\"|\"receipt\",\"closingWhy\":\"…\"}",
].join("\n");
/** 設備が揃った部屋（SECOND_APPEAL_COUNT_BY_SCENE=on かつ equipmentRichOf）の時の判断の決まり。それ以外は今までの APPEAL_JUDGE_SYSTEM のまま */
export function appealJudgeSystem(rich: boolean): string {
  if (!rich) return APPEAL_JUDGE_SYSTEM;
  return [
    APPEAL_JUDGE_SYSTEM.split("\n")[0],
    "竹内さん（社長）は、そのお客様の希望・こだわり・不安・暮らし方・今の状況に合わせて、物件の事実のうち一番刺さる物を先頭に置きます。このお部屋は設備が揃っているので、竹内さんの決まり（11/18）どおり刺さる事実を3〜5個並べます（一番刺さる物を先頭）。お客様に関係の無い設備は入れません。",
    // 2026-11-19 k1118-count-on の外れ（6問中3問で点が下がった）: 並べる数を増やした判断が、家賃の額を一番にし（1通目に既にある値）、締めを全部 receipt に変えた。
    //   竹内さんの3〜5個の実送信は、敷金礼金なし・ネット無料・独立洗面台・浴室乾燥機等の事実を並べ、締めは数と関係なく決めている → 2つを決まりに書く
    "並べる物は、敷金礼金なし・初期費用・ネット無料・設備（独立洗面台・浴室乾燥機・オートロック等）・駅・築年などの事実です。家賃・管理費の額は一番にしません（1通目に既にあります）。締めは並べる数と関係なく、下の締めの決まりで決めます（数を増やしたからご査収にする、はしません）。",
    "決める物: first（一番刺さる物＝下の物件の事実の候補から1つ・お客様の何に応えるかの理由）・second（2番目）・more（3番目以降を1〜3個）・count（3〜5）・form（言い方の型を1つ: 下の型の要約の結び方から）・closing（viewing＝内覧へ／apply＝申込へ／receipt＝ご査収だけ）と理由。",
    ...APPEAL_JUDGE_SYSTEM.split("\n").slice(3, 5),
    "出力は JSON だけ: {\"first\":{\"text\":\"…\",\"why\":\"…\"},\"second\":{\"text\":\"…\",\"why\":\"…\"},\"more\":[{\"text\":\"…\",\"why\":\"…\"}],\"count\":3|4|5,\"form\":\"…\",\"closing\":\"viewing\"|\"apply\"|\"receipt\",\"closingWhy\":\"…\"}",
  ].join("\n");
}

/** 判断の入力（候補は網・お客様の要点はブレイン） */
export function appealJudgePrompt(i: AppealInput & { situation?: string | null; scene: string; notViewable: boolean; materialFacts?: string | null; closingCandidates?: string[]; data: SecondTakeuchiInput; rich?: boolean }): { prompt: string; candidates: string[] } {
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
    i.rich ? `## 設備が揃ったお部屋（1通目の設備 ${equipmentItemsOf(i.firstMessage).length}個: ${equipmentItemsOf(i.firstMessage).join("・")}）\n刺さる事実を3〜5個並べる（一番刺さる物を先頭・お客様に関係の無い物は入れない）` : "",
    takeuchiFormSummary(i.scene, i.data.forms, i.rich),
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
      ...(() => {
        // 3番目以降は設備が揃った部屋の判断（appealJudgeSystem(true)）だけが出す。count は並べた数に合わせる（3〜5）。more が無ければ今まで通り 1 か 2
        const more = (Array.isArray(o.more) ? o.more : []).map((x) => x as { text?: unknown; why?: unknown }).filter((x) => typeof x?.text === "string" && x.text.trim()).slice(0, 3)
          .map((x) => ({ text: String(x.text).trim().slice(0, 120), why: String(x.why ?? "").slice(0, 120) }));
        const hasSecond = !!(s && typeof s.text === "string" && s.text.trim());
        if (more.length && hasSecond) return { more, count: (2 + more.length) as AppealJudge["count"] };
        return { count: (Number(o.count) === 2 ? 2 : 1) as AppealJudge["count"] };
      })(),
      form: String(o.form ?? "").slice(0, 60),
      closing: closing as AppealJudge["closing"],
      closingWhy: String(o.closingWhy ?? "").slice(0, 120),
    };
  } catch { return null; }
}

/** 書き手への注記（判断・型・手本）。書き手は並べ直さない */
export function judgedAppealNote(j: AppealJudge, scene: string, data: SecondTakeuchiInput): string {
  const wantEls = [...elementsOf(j.first.text), ...(j.second ? elementsOf(j.second.text) : [])];
  const ex = pickTakeuchiExamples(data.examples, scene, wantEls, 3);
  return [
    "",
    "【ブレインの訴求の判断（この通りに書く・自分で並べ直さない）】",
    `・一番に言う物: ${j.first.text}（理由: ${j.first.why}）`,
    j.second && j.count >= 2 ? `・2番目: ${j.second.text}（理由: ${j.second.why}）` : "・2番目: 言わない（1個を強く）",
    // 2026-11-18 設備が揃ったお部屋（SECOND_APPEAL_COUNT_BY_SCENE）: 3番目以降を1文に並べる（竹内さんの実送信「〜・〜・〜と設備も充実しており」の型）
    ...(j.more?.length ? [`・3番目以降: ${j.more.map((m) => m.text).join("・")}（一番の物を先頭に、2番目からは1文に並べる。上に無い設備は足さない）`] : []),
    `・言い方の型: ${j.form}`,
    `・締め: ${({ viewing: "内覧へ（お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます）", apply: "申込へ（お気に召されましたらお申込しお部屋抑えさせて頂きます）", receipt: "ご査収だけ（誘いを足さない）" })[j.closing]}（理由: ${j.closingWhy}）`,
    "・上に無い設備・駅・築年を並べ足さない。事実は1通目・資料にある事だけ。金額・節約額は書かない（初期費用は「敷金礼金なしで初期費用を抑える事ができ」の言い方まで）。",
    takeuchiFormSummary(scene, data.forms, !!j.more?.length),
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

// 2026-11-03 作業員6（竹内さんの決定 No.32・竹内さんの送信が根拠）: 2通目の文の知識。人気シリーズ（プレジオ等）は「人気マンション」と言う／
//   お客様の暮らし方（同棲・ご家族・ペット 等）に合う間取りはそう言う（「〇〇さん達の暮らしに最適な間取り」）。スイッチ AIX_SECOND_KNOWLEDGE=on（既定 off）。
export function secondKnowledgeOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_SECOND_KNOWLEDGE ?? "").trim().toLowerCase() === "on";
}
export const POPULAR_SERIES_RE = /プレジオ|プレサンス|エステムコート|アドバンス|セレニテ|ワールドアイ|ラグゼ|スプランディッド|ファーストフィオーレ|エスリード/;
/** 物件名と暮らし方の材料から、2通目の知識の行（当てはまる物だけ） */
export function secondKnowledgeLines(o: { propertyName: string | null | undefined; lifestyle?: ReadonlyArray<string> }): string[] {
  const out: string[] = [];
  const name = String(o.propertyName ?? "");
  const m = name.match(POPULAR_SERIES_RE);
  if (m) out.push(`・${m[0]}シリーズは人気マンション＝「${m[0]}シリーズは人気マンションとなり」と言ってよい（竹内さんの言い方）`);
  const life = (o.lifestyle ?? []).join(" ");
  if (/同棲|お二人|二人暮らし|カップル|ご夫婦|ご家族|お子|ペット|猫|犬/.test(life)) out.push("・お客様の暮らし方（同棲・ご家族・ペット 等）に間取りが合う時は「〇〇さん達の暮らしに最適な間取り」と結ぶ（暮らし方が材料にある時だけ・作らない）");
  return out.length ? ["【2通目の文の知識（竹内さんの決定 No.32）】", ...out] : [];
}
