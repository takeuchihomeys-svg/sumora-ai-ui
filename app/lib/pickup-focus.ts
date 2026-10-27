// app/lib/pickup-focus.ts — AIX【物件ピックアップした】のピックアップの1行に入れる「こだわりの軸」の候補（純関数・既定 off）
//
// 2026-10-28 竹内さんの指摘（owner-fb:1015-pickup-focus・10/15 会話E）: 下書きはエリア・新着の決まった文。竹内さんは
//   「リビングと洋室が独立…ご条件に近いお部屋2部屋」とお客様のこだわりを軸に書いた。
// 線（直近90日の物件ピックアップした 433通・作業員3）:
//   ピックアップの1行の「・」「、」の区切り（条件を並べた数）: 下書き 2.9 → 竹内さんの送った文 1.3（10/09〜・竹内さん 29通）。
//   区切り4つ以上（家賃・駅徒歩・築年数・設備…を並べた行）は下書き 27/70 → 送った文 17/70。
//   条件の希望（エリア・家賃以外）を1行に入れたのは 下書き 41/77・竹内さん 31/77。竹内さんが入れた時は下書きにも同じ軸があった（27/27）。
//   竹内さんの形: 「〈エリア〉周辺全域から〈一番のこだわり1つ（ペット可・広め・敷金礼金なし・犬猫1匹ずつ飼育可能 等）〉のお部屋ピックアップ」
//     または「〇〇さんのご条件に近いお部屋全てピックアップ」。家賃・駅徒歩・築年数は並べない。
// → 足りないのは軸の一言ではなく「1つに絞る」こと。候補（強い順）を渡し、書くのは1つまで（決めるのは書く役）。
// 入れる: PICKUP_FOCUS_ONE=on（既定 off）

export function pickupFocusOneEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PICKUP_FOCUS_ONE ?? "").trim().toLowerCase() === "on";
}

const AXES: Array<{ key: string; label: string; re: RegExp }> = [
  { key: "pet", label: "ペット", re: /ペット|犬|猫|小型犬/ },
  { key: "cost", label: "初期費用・敷金礼金", re: /初期費用|敷金|礼金|敷礼/ },
  { key: "size", label: "広さ", re: /広め|広い|帖以上|畳以上|㎡|ゆとり/ },
  { key: "layout", label: "間取りの形", re: /独立|分かれ|2部屋|二部屋|ロフト/ },
  { key: "equip", label: "設備", re: /独立洗面|洗面所|バス・?トイレ別|風呂トイレ別|トイレ別|オートロック|ガスコンロ|カウンターキッチン|室内洗濯|ウォークイン|浴室乾燥|宅配|追い焚き/ },
  { key: "pair", label: "2人入居・家族", re: /二人|2人|お二人|同棲|家族|子ども|子供/ },
];
const STRONG_RE = /必須|のみ|絶対|必ず|だけは|マスト/;

export type FocusCandidate = { label: string; phrase: string; score: number };

/**
 * 登録の条件（希望・その他・NG の行）と直近のお客様の文から、こだわりの軸の候補を強い順に返す（最大 max）。
 *   強さ: 「必須・のみ・絶対」等が付いた句 +3／直近のお客様の文に出た +2／条件の希望に書いてある +1。家賃・駅徒歩・築年数・エリアは軸にしない。
 *   phrase＝条件の文のその句（お客様の言い方のまま・40字まで）
 */
export function pickupFocusCandidates(conditionsText: string | null | undefined, recentCustomerTexts: ReadonlyArray<string | null | undefined> = [], max = 2): FocusCandidate[] {
  const cond = String(conditionsText ?? "");
  const wishLines = (cond.match(/(?:希望|その他|NG)[:：][^\n]+/g) ?? []).join("、").replace(/^(?:希望|その他|NG)[:：]/gm, "");
  const phrases = wishLines.split(/[、,，・\n]|(?<=[^0-9])\s+/).map((s) => s.replace(/^(?:希望|その他|NG)[:：]\s*/, "").trim()).filter((s) => s.length >= 2);
  const recent = recentCustomerTexts.map((t) => String(t ?? "")).join("\n");
  const out: FocusCandidate[] = [];
  for (const ax of AXES) {
    const ph = phrases.filter((p) => ax.re.test(p));
    const inRecent = ax.re.test(recent);
    if (!ph.length && !inRecent) continue;
    let score = ph.length ? 1 : 0;
    if (inRecent) score += 2;
    if (ph.some((p) => STRONG_RE.test(p)) || (inRecent && STRONG_RE.test(recent.split(/\n/).find((l) => ax.re.test(l)) ?? ""))) score += 3;
    const phrase = Array.from((ph.find((p) => STRONG_RE.test(p)) ?? ph[0] ?? (recent.split(/\n/).find((l) => ax.re.test(l)) ?? ax.label)).replace(/\s+/g, " ")).slice(0, 40).join("");
    out.push({ label: ax.label, phrase, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/** 書く役に渡す1段（候補が無ければ空） */
export function pickupFocusNote(cands: ReadonlyArray<FocusCandidate>): string {
  const list = cands.map((c, i) => `${i + 1}. ${c.phrase}（${c.label}）`).join("\n");
  return [
    "【ピックアップの行のこだわり（竹内さんの形・1つまで）】",
    "②の行に入れる条件は、エリアと、お客様が一番強く言ったこだわり1つまで（家賃・駅徒歩・築年数・設備を並べない。竹内さんの行の区切りは平均 1.3）。",
    cands.length ? `こだわりの候補（強い順・お客様の言い方）:\n${list}\n→ 1つ選ぶか、どれも今回の束に当てはまらない時は「〇〇さんのご条件に近いお部屋」の形にする（合わない事を合うと書かない）` : "→ こだわりが読めない時は「〈エリア〉周辺全域から〇〇さんにオススメできるお部屋」の形にする",
  ].join("\n");
}
