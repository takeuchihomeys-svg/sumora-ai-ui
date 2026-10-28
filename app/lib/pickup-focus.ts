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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-28 竹内さん（#17 ロト・#39/#40 前田）: AIX【物件ピックアップした】の竹内さんの型と、入れない前置き
//   #17「お客さんが御堂筋沿線で無いですか？と聞いているので御堂筋沿線で答える。駅名を入れたら情報が多く読まなくなる」
//     竹内さんの文「御堂筋線沿線全域からご条件に近いお部屋全てピックアップ…3口ガスコンロのお部屋カウンターキッチンのお部屋では御座いませんが、今回お送りする4部屋すべてペット飼育可能・バス・トイレ別のお部屋となります！！」
//   #39 下書きの文頭「お手数おかけして申し訳ございません！！ご納得頂けるまでしっかりお部屋探しさせて頂きます😊！！」→ 竹内さん「こんな文入れない」。
//     竹内さんの ピックアップさせて頂きました の通（90日 107通）にお詫び・「ご納得」は 0通。出どころはナレッジ（ai_reply_knowledge a4ac395f・e4f47db1＝8/10 の1通の申込キープの場面の締め）。
//   #40 竹内さんの型:「夜分遅くに失礼致します（夜の AIX）→ 何を変えて探したか → どこから（お探しの地域全域）→ 件数 → ご条件に近い → ご案内 → ご査収」
// 入れる PICKUP_SEND_FORM_1028=on（既定 off）。決めるのは書く役（材料）

export function pickupSendForm1028On(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PICKUP_SEND_FORM_1028 ?? "").trim().toLowerCase() === "on";
}

/** お客様の問いの中のエリアの言い方（「御堂筋沿線」「〇〇線沿い」「〇〇周辺」）。無ければ null */
export function customerAreaAsk(recentCustomerTexts: ReadonlyArray<string | null | undefined>): string | null {
  for (let i = recentCustomerTexts.length - 1; i >= 0; i--) {
    const t = String(recentCustomerTexts[i] ?? "").normalize("NFKC");
    const m = t.match(/([^\s、。！!？?「」]{1,10}?(?:線)?(?:沿線|沿い))/) ?? t.match(/([^\s、。！!？?「」]{2,8}(?:周辺|あたり|辺り))(?:で|の|に)/);
    if (m) return m[1];
  }
  return null;
}

export function pickupSendFormNote(o: { recentCustomerTexts: ReadonlyArray<string | null | undefined> }): string {
  const ask = customerAreaAsk(o.recentCustomerTexts);
  const lines = [
    "竹内さんの型の順: （夜の時は挨拶の行のとおり）→ 何を変えて探したか（お客様の言い直し・ご依頼への答え）→ どこから（「〇〇全域から」「〇〇さんお探しの地域全域から」）→ 件数 → 「ご条件に近いお部屋」→ 内覧のご案内 → ご査収",
    ask ? `お客様は「${ask}」の言い方で聞いている → 「${ask.replace(/沿い$/, "沿線")}全域から」のようにその言葉で答える。駅名を並べない` : "エリアは一言（「〇〇全域から」）。駅名を並べない（駅名を入れると読まれない）",
    "ご希望に合わない点がある時は「〇〇のお部屋では御座いませんが、」と正直に先に書き、その後に今回の物件に共通する良い点",
    "お詫び（「お手数おかけして申し訳ございません」）・「ご納得頂けるまで」等の前置きは書かない（竹内さんのピックアップの通 107通中 0通）",
  ];
  return `【竹内さんの物件ピックアップした の型（10/28）】\n${lines.map((l) => `・${l}`).join("\n")}`;
}
