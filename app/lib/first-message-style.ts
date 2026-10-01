// app/lib/first-message-style.ts
// AIX【物件オススメ】の1通目（🌟物件名 …）の「言い回し」の検査・文末の揃え・手本の選別（純関数・DB 依存なし）。
//
// 2026-10-01 竹内（YUMA に届いた1通目を見て・2通目と同じやり方で直す）:
//   「…家具付き・角部屋・宅配BOX完備と使いやすい設備が揃っております！！浴室乾燥機や室内洗濯機置場も備わっており、暮らしやすい作りとなっております！！」
//   「…とかなり条件の良いお部屋で…」「…収納面もしっかり確保されております！！」「…室内も綺麗な22.56㎡のお部屋です。」「…梅田へもすぐの立地です！！」
//
// ■ 実送信の数え方（scripts/audit-first-message-phrasing.ts・365日・YUMA と申込以降を除く）
//   1通目の実送信 559通のうち、スタッフが自分で書いた物は 33通だけ（AI の下書きをほぼそのまま送った 515・直した 11）。
//   ⚠ 「実送信にある」を AI の下書きのまま送った通で数えると、AI の言い回しを「実送信にある」と数えてしまう。
//     線は「スタッフが書いた 33通」＋「直した時に自分で足した文」＋「スタッフの文全体（AI の印が付く前の 5/30〜6/05 と
//     印が付いてからの is_aix_generated=false・4,427通）」で引く。
//   スタッフの1通目: 中央値146字・2段落・5文・1文20字・「。」で終わる文 0%・絵文字あり73%・本文の文で設備を4つ以上並べた 0/94文。
//   AI の下書きのまま: 371字・6段落・11文・絵文字あり18%。
//
// ■ 出口（exit=true）にしたのは、スタッフの文全体 4,427通で 0通 かつ スタッフの1通目 33通・直した時に足した文 11通でも 0 の語だけ。
//   exit=false は数えるだけ（スタッフも書いている・AI だけとは言えない）:
//     「設備が揃って」（スタッフ3通「ご希望の設備も揃っております」）・「室内も綺麗」（12通「リノベーション済みで室内綺麗なお部屋」）・
//     「条件の良いお部屋」（7通「新着でかなり条件のいいお部屋」）・「収納面」（1通）・「しっかり確保」（3通）・「好立地」（15通）・
//     「アクセスも良好」（4通）・「快適」「使い勝手」「魅力的」（スタッフにもある）
//   ＝竹内さんが挙げた語のうち「揃っております」「室内も綺麗」「かなり条件の良い」「収納面もしっかり確保」は出口で止めない（誤って作り直しになる）。
//     入口（手本に出さない・本文の形を渡す）で減らす。

export type FirstPhraseRule = { key: string; re: RegExp; exit: boolean; example?: boolean };

/**
 * exit=true … 出口（作り直し1回）。example=true … 入口で、この語を含む手本（過去の送信文）を見せない（入口は厳しくてよい）。
 * 数はスタッフの文全体（4,427通）／AI の1通目の送信（618通・is_aix_generated）。
 */
export const FIRST_PHRASE_RULES: FirstPhraseRule[] = [
  { key: "使いやすい設備", re: /使いやすい設備/, exit: true, example: true },                 // 0 ／ 1
  { key: "暮らしやすい作り", re: /暮らしやすい(?:作り|造り|お部屋)/, exit: true, example: true }, // 0 ／ 2
  { key: "作りとなって", re: /(?:作り|造り)(?:と|に)なって/, exit: true, example: true },       // 0 ／ 8
  { key: "へもすぐ", re: /へも(?:すぐ|出やすい)|すぐの立地|出やすい立地/, exit: true, example: true }, // 0 ／ 1
  { key: "安心の作り", re: /安心の(?:作り|造り|お部屋)/, exit: true, example: true },          // 0 ／ 4
  { key: "新生活のスタート", re: /新生活のスタート/, exit: true, example: true },               // 0 ／ 0
  { key: "強み", re: /強み/, exit: true, example: true },                                     // 0 ／ 1
  { key: "ならでは", re: /ならでは/, exit: true, example: true },                             // 0 ／ 14
  { key: "これ以上ない", re: /これ以上ない/, exit: true, example: true },                       // 0 ／ 0
  // ↓ 数えるだけ（スタッフも書く）。手本からは外す（AI の下書きのまま送った通で多い＝手本に出すと AI の癖が増える）
  { key: "設備が揃って", re: /(?:設備|もの)[がも](?:揃|そろ)って/, exit: false, example: true },   // 3 ／ 4
  { key: "収納面", re: /収納面/, exit: false, example: true },                                 // 1 ／ 9
  { key: "しっかり確保", re: /しっかり(?:と)?確保/, exit: false, example: true },                // 3 ／ 28
  { key: "使い勝手", re: /使い勝手/, exit: false, example: true },                             // 11 ／ 128
  { key: "魅力", re: /魅力/, exit: false, example: true },                                     // 4 ／ 7
  { key: "毎月の費用をしっかり", re: /毎月の費用をしっかり/, exit: false, example: true },          // 1 ／ 18
  { key: "室内も綺麗", re: /室内(?:も|が)?(?:綺麗|きれい)/, exit: false },                        // 12 ／ -
  { key: "条件の良いお部屋", re: /条件の(?:良|よ|いい)い?お部屋|かなり条件の(?:良|よ)い/, exit: false }, // 7 ／ -
  { key: "好立地", re: /好立地/, exit: false },                                                // 15 ／ 54
  { key: "快適", re: /快適/, exit: false },
];

export type FirstPhraseHit = { key: string; match: string };

/** 出口の検査（exit=true の語だけ）。無ければ空 */
export function findFirstAiPhrases(text: string | null | undefined): FirstPhraseHit[] {
  const t = String(text ?? "");
  const hits: FirstPhraseHit[] = [];
  for (const r of FIRST_PHRASE_RULES) {
    if (!r.exit) continue;
    const m = t.match(r.re);
    if (m) hits.push({ key: r.key, match: m[0] });
  }
  return hits;
}

/**
 * 入口: 過去の送信文を手本に見せてよいか。AI だけの語・AI の下書きで多い語（example=true）を含む物は見せない。
 * 入口は厳しくてよい（見せないだけで本文は変わらない）。
 */
export function isCleanFirstExample(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  return !FIRST_PHRASE_RULES.some((r) => r.example && r.re.test(t));
}

/** 物件オススメの1通目の形か（🌟物件名で始まる段落があり、オススメの文がある。見積書の行は除く）。監査と入口の選別で使う */
export function isFirstRecommendation(t: string | null | undefined): boolean {
  const s = String(t ?? "");
  const head = s.split("\n").slice(0, 4).join("\n");
  return /(?:^|\n)\s*🌟\s*\S/.test(head) && /オススメ|おすすめ/.test(s) && !/御見積書|見積書/.test(head);
}

// ─────────────────────────────────────────────────────────────────────────────
// 出口: 文末を「！！」に揃える
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 「。」で終わる文と「！！」で終わる文が同じ通に混ざっている時だけ、文末の「。」を「！！」にする（語は1文字も消さない）。
 * スタッフの1通目 33通で「。」で終わる文 0・混ざる通 0（＝変える実送信は0）。AI の下書きのまま送った 515通では混ざる通 3.3%。
 * ・全部「。」の通（スタッフが「。」で書く人の文）は触らない。
 * ・URL の行・「・」始まりの行（箇条書き）・（ ）の中の「。」は触らない。文の途中の「。」（次の文が同じ行に続く）も「！！」にする。
 */
export function unifyBangEnding(text: string): { text: string; changed: number } {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const isSkip = (l: string) => /https?:\/\//.test(l) || /^\s*[・･]/.test(l);
  // 括弧（（）・()・「」）の外の「。」だけを「！！」にする
  const convert = (l: string): { s: string; n: number } => {
    let depth = 0, res = "", n = 0;
    for (const c of l) {
      if (c === "（" || c === "(" || c === "「") depth++;
      else if ((c === "）" || c === ")" || c === "」") && depth > 0) depth--;
      if (c === "。" && depth === 0) { res += "！！"; n++; continue; }
      res += c;
    }
    return { s: res, n };
  };
  const body = lines.filter((l) => !isSkip(l));
  const maru = body.reduce((k, l) => k + convert(l).n, 0);
  const bang = body.some((l) => /[！!]/.test(l));
  if (maru === 0 || !bang) return { text: src, changed: 0 };
  let changed = 0;
  const out = lines.map((l) => {
    if (isSkip(l)) return l;
    const r = convert(l);
    changed += r.n;
    return r.s;
  });
  return { text: out.join("\n"), changed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 出口: 形容詞の連用形（浅く・広く…）の後を「・」でつながない
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-01 竹内さん（YUMA に届いた2通目「…703号室が2020年1月築で築年数浅く・バス・トイレ別・独立洗面台付きで、YUMAさんに…」）:「上の『浅く・』を直す」
//   実送信（scripts/tmp-audit-ku-dot2.ts・スタッフの文 全期間 13,152通・YUMA 除く）:
//     「〜く・」24通 = 「築年数浅く・」23通（AIX の下書きのまま 22・is_aix_generated でない 1）＋「スーパー近く・ペット可」1通（近く＝名詞「そば」＝当てない）
//     「浅く、」152通（is_aix_generated でない 26）・「浅く＋次の語」63通 ＝ スタッフのつなぎ方は「浅く、」
//     AIX の生成ログ（aix_generate_log 1,965行）の「く・」21 はすべて「築年数浅く・」
//   → 形容詞の連用形（浅く・広く・良く・安く・新しく・明るく・大きく・高く・低く・長く）の直後の「・」だけを「、」に替える（語は1文字も消さない）。
//     近く・遠く・多く（名詞にもなる）は当てない。監査: スタッフの文で替わるのは「築年数浅く・家賃管理費込…」の1通だけ（→ スタッフの多数の形「浅く、」）。
const ADJ_KU_DOT_RE = /(浅|広|良|安|新し|明る|大き|高|低|長)く・/g;

export function fixAdjectiveNakaguro(text: string): { text: string; changed: number } {
  const src = String(text ?? "");
  let changed = 0;
  const out = src.replace(ADJ_KU_DOT_RE, (_m, stem: string) => { changed++; return `${stem}く、`; });
  return { text: out, changed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 場面（監査用）: 新着／送った中から1件／1件だけ
// ─────────────────────────────────────────────────────────────────────────────
export type FirstScene = "new" | "compare" | "single";

export function firstSceneOf(i: { text: string; priorStaffTexts?: string[]; newPicker?: boolean }): FirstScene {
  if (i.newPicker || /新着/.test(i.text.split("\n").slice(0, 5).join("\n"))) return "new";
  const prior = (i.priorStaffTexts ?? []).join("\n");
  if (/ピックアップ|お送りさせて頂きました|お送りさせていただきました|🌟/.test(prior) || /中でも特に|お送りさせて頂(?:きました|いた)お部屋の中/.test(i.text)) return "compare";
  return "single";
}
