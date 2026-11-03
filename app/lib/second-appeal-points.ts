// app/lib/second-appeal-points.ts — AIX の2通目に「このお客様に刺さる点」を強い順に渡すつなぎ（純関数・AIX_SECOND_APPEAL_POINTS）
//
// 2026-10-29 作業員5（竹内さん 10/29 KB 9f4f0b48「AIX の2通目はお客様に刺さるかを決める一番大事な文…統括・ブレインの部分の連携をしっかり」）。
//   実例 R（10/28 S-RESIDENCE難波Briller 411）: 1通目のオススメポイントの「職場の天王寺まで通いやすい」「角部屋で風通し」「インターネット使用料不要」が
//   2通目で全部落ち、「2014年9月築・大国町徒歩6分・敷金礼金なし・7.1帖・浴室乾燥」の一般の並べになった。1通目は 2通目の生成に届いていた（sent-message len 319）が、
//   2通目の場面の注記は「理由は【資料の事実】と1通目の事実を1〜2つ」で、どれがこのお客様に刺さるかの順が無かった＝組み立て（A）の穴。
//   実測（scripts/audit-second-appeal-takeuchi.ts・60日・物件オススメの2通目 竹内さん 207・AI 317）:
//     要素の数 竹内さん 1.9・AI 2.6（AI は並べすぎ）。駅・徒歩 竹内さん 15%・AI 43%（最初に言う 8%・26%）、築年 24%・37%、設備 19%・37%。
//     竹内さんは状況に合わせた一言（独立系の保証会社＝審査が通りやすい・フリーレント・ご条件ギリギリだが…）を使う。締めは内覧 55%（AI 21%）。
//   形: 1通目のオススメポイントの行と、ブレインのお客様の要点（不安・こだわり・状況・希望の条件・通勤先）を突き合わせ、刺さる順に最大3つの候補を渡す。
//   2通目はそのうち1〜2個を強く言い、駅徒歩・築年・帖数・設備の一般の羅列にしない。文は決定論で書かない（材料と順だけ・書くのは LLM）。

export function secondAppealPointsOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_SECOND_APPEAL_POINTS ?? "").trim().toLowerCase() === "on";
}

/** 訴求の要素（2通目の監査 audit-second-appeal-takeuchi.ts と同じ網） */
export const APPEAL_ELEMENTS: Array<{ key: string; ja: string; re: RegExp }> = [
  { key: "commute", ja: "通勤先・よく行く所とのつながり", re: /通いやすい|通勤|職場|お勤め|会社まで|乗り換えなし|乗換なし|直通|一本で|まで(?:電車|徒歩)?[0-9０-９]{1,2}分/ },
  { key: "wish_link", ja: "希望・条件との結び", re: /ご希望の|ご条件(?:に|の)|(?:気にされて|こだわり)|さんにピッタリ|さんの(?:ご希望|条件)/ },
  { key: "saving", ja: "初期費用の節約", re: /節約|お得|[0-9,，]+円(?:も)?(?:安く|抑え|お安く)|初期費用[^。！!\n]{0,14}(?:抑え|安く|無料|0円)|前家賃(?:だけ|のみ)/ },
  { key: "shikirei", ja: "敷金礼金なし", re: /敷金礼金(?:なし|無し|0|ゼロ)|礼金(?:なし|無し|0)/ },
  { key: "rent_total", ja: "家賃管理費込みの額", re: /家賃管理費込|管理費込み?[0-9０-９,]+円|合計[0-9０-９,]+円/ },
  { key: "net_free", ja: "ネット無料", re: /(?:インターネット|ネット|Wi-?Fi)(?:無料|使用料不要|使い放題|費用不要)/i },
  { key: "corner", ja: "角部屋・日当たり・眺望", re: /角部屋|日当たり|南向き|眺望|眺め|風通し/ },
  { key: "size", ja: "広さ・間取り", re: /[0-9０-９.．]+帖|広め|広々|広く|使いやすい間取り|独立した?洋室/ },
  { key: "age", ja: "築年・築浅", re: /築浅|新築|[0-9０-９]{4}年[0-9０-９]{1,2}月築|築[0-9０-９]{1,2}年|リノベ|リフォーム/ },
  { key: "equipment", ja: "設備", re: /浴室乾燥|独立洗面|オートロック|宅配ボックス|システムキッチン|バストイレ別|バス・トイレ別|追い焚き|追焚|コンロ|ウォークイン|駐車場|駐輪場|防犯カメラ/ },
  { key: "station", ja: "駅・徒歩分", re: /「[^」]{1,12}」(?:駅)?\s*徒歩|駅(?:徒歩|から)|徒歩[0-9０-９]{1,2}分/ },
  { key: "move_in", ja: "入居時期", re: /即入居|入居可能|[0-9０-９]{1,2}月(?:中|上旬|中旬|下旬|末)(?:の|に|まで)?(?:ご)?入居/ },
  { key: "screening", ja: "審査（保証会社）", re: /保証会社|審査(?:が|も)?(?:通|柔軟|緩)/ },
  { key: "pet", ja: "ペット", re: /ペット|猫|犬/ },
];
export function elementsOf(text: string): string[] {
  return APPEAL_ELEMENTS.filter((e) => e.re.test(text)).map((e) => e.key);
}

/** 1通目（🌟カード）のオススメポイントの行（「・」で始まる行）。見出し・家賃だけ・面積だけの行も残す（下で点を付ける） */
export function firstMessagePoints(first: string | null | undefined): string[] {
  return String(first ?? "").split(/\n/).map((l) => l.trim()).filter((l) => /^[・･]/.test(l)).map((l) => l.replace(/^[・･]\s*/, "").trim()).filter((l) => l.length >= 4);
}
/** 1通目の節約額の一文（「初期費用108,900円節約」等）。無ければ null */
export function firstMessageSaving(first: string | null | undefined): string | null {
  const m = String(first ?? "").match(/[^\n。！!]*(?:[0-9,，]+円(?:の)?(?:節約|お得)|節約[^\n。！!]{0,8}[0-9,，]+円)[^\n。！!]*/);
  return m ? m[0].replace(/^[・･🌟\s]+/, "").trim() : null;
}

/** スペックだけの行（家賃・間取り・面積・築年だけ）＝理由になっていない */
const SPEC_ONLY_RE = /^(?:家賃|管理費|間取り|専有面積|敷金|礼金|築|所在|最寄)/;
/** 理由の言い方（〜ので・〜出来ます・〜過ごしやすい）＝1通目で既にお客様に結んで書いた行 */
const REASON_RE = /ので|ため|出来ます|できます|過ごしやすい|節約|通いやすい|便利|安心|嬉しい|オススメ/;

/** お客様の要点から、効きやすい要素へ（不安・状況・こだわりの言葉） */
const CONCERN_TO_ELEMENTS: Array<{ re: RegExp; els: string[] }> = [
  { re: /初期費用|費用|安く|予算|お金|節約|家賃/, els: ["saving", "shikirei", "rent_total", "net_free"] },
  { re: /審査|保証会社|ブラック|滞納|無職|収入/, els: ["screening"] },
  { re: /入居|時期|急ぎ|早く|[0-9０-９]{1,2}月/, els: ["move_in"] },
  { re: /通勤|職場|会社|通学|学校|駅/, els: ["commute", "station"] },
  { re: /広|帖|収納|同棲|二人|2人|家族/, els: ["size"] },
  { re: /綺麗|きれい|新し|築/, els: ["age"] },
  { re: /日当たり|眺望|角部屋|静か|風通し/, els: ["corner"] },
  { re: /ペット|猫|犬/, els: ["pet"] },
  { re: /セキュリティ|オートロック|防犯|女性/, els: ["equipment"] },
  { re: /比べ|迷|決めきれ|納得/, els: ["wish_link", "saving", "commute", "corner", "net_free"] },
];

export type AppealInput = {
  firstMessage: string | null | undefined;
  /** お客様の要点（ブレインの latent_intent・customer_concern・hesitancy・situation・感情）をつないだ文 */
  customerPoints: string | null | undefined;
  /** 希望の条件（エリア・通勤先・こだわり）の文 */
  conditions: string | null | undefined;
};
export type AppealPoint = { text: string; els: string[]; score: number; why: string[] };

/** 刺さる順に並べた候補（最大3）。1通目のオススメポイントの行が材料（無い時は空） */
export function rankAppealPoints(i: AppealInput): AppealPoint[] {
  const cust = `${i.customerPoints ?? ""}\n${i.conditions ?? ""}`;
  const wanted = new Set<string>();
  for (const c of CONCERN_TO_ELEMENTS) if (c.re.test(cust)) c.els.forEach((e) => wanted.add(e));
  // お客様の言葉（2文字以上のかな・漢字の塊）で1通目の行と重なる物
  const custWords = [...new Set((cust.match(/[一-龯゠-ヿ]{2,8}/g) ?? []).filter((w) => !/^(?:お客様|物件|お部屋|希望|条件|状況|確認|連絡)$/.test(w)))];
  const pts: AppealPoint[] = [];
  for (const line of firstMessagePoints(i.firstMessage)) {
    const els = elementsOf(line);
    const why: string[] = [];
    let score = 0;
    const hitWords = custWords.filter((w) => line.includes(w));
    if (hitWords.length) { score += 3; why.push(`お客様の言葉（${hitWords.slice(0, 2).join("・")}）`); }
    const hitEls = els.filter((e) => wanted.has(e));
    if (hitEls.length) { score += 2; why.push(`要点に合う（${hitEls.map((e) => APPEAL_ELEMENTS.find((x) => x.key === e)?.ja).join("・")}）`); }
    if (REASON_RE.test(line)) { score += 1; why.push("1通目で理由まで書いた"); }
    if (SPEC_ONLY_RE.test(line) && !hitEls.length && !hitWords.length) score -= 2;
    if (els.every((e) => e === "station" || e === "age" || e === "size" || e === "equipment") && !hitEls.length && !hitWords.length) score -= 1;
    pts.push({ text: line, els, score, why });
  }
  const saving = firstMessageSaving(i.firstMessage);
  if (saving && !pts.some((p) => p.text.includes(saving))) pts.push({ text: saving, els: ["saving"], score: 2 + (wanted.has("saving") ? 2 : 0), why: ["1通目・見積書の節約額"] });
  return pts.filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

/** 2通目の注記（場面の形の注記の後・締めの前に置く）。候補が無ければ空 */
export function buildSecondAppealNote(i: AppealInput & { situation?: string | null }): string {
  const pts = rankAppealPoints(i);
  if (!pts.length) return "";
  const L = ["", "【このお客様に刺さる点（強い順・1通目のオススメポイントとお客様の要点から）】"];
  pts.forEach((p, k) => L.push(`${k + 1}) ${p.text}（${p.why.join("・")}）`));
  if (i.situation?.trim()) L.push(`今の状況: ${i.situation.trim().slice(0, 120)}`);
  L.push(
    "・2通目の「なぜこのお部屋をオススメするか」は、上の 1) を一番に、多くても 2) までを強く言う（1通目の言葉をそのまま使ってよい）。",
    "・駅徒歩・築年・帖数・設備を並べるだけの文にしない（竹内さんの2通目は要素 1〜2 個・AI は並べすぎていた）。上に無い一般の設備は足さない。",
    "・駅名・徒歩分を理由の最初に置かない（竹内さんが駅から言い始めるのは 8%）。駅は通勤先・よく行く所とのつながりで言う時だけ。",
    "・今の状況があれば、このお部屋がそこにどう応えるかを1文で（作り事・確認していない事は書かない）。竹内さんの一言の例: 審査が不安な方には「独立系の保証会社の為審査通過する可能性が高い」、"
      + "費用を気にされる方には「敷金礼金なし（フリーレント）で初期費用を抑える事が出来る」、希望と少しずれる時は「（ずれ）となりますが」と先に言ってから勧める。資料・1通目に無い事実は書かない。",
  );
  return L.join("\n");
}
