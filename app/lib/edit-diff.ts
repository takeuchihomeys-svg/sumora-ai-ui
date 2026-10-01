// app/lib/edit-diff.ts
// 「生成された文（AI の下書き・AIX の生成文）」と「スタッフが実際に送った文」の差を、量と型に分ける（純関数・DB も fetch も持たない）。
// 2026-09-27 竹内「テスト繰り返して質上げていくために足りない部分等見つけていく／そうすれば完全自動化できるから」
//   → 自動化の度合いの表（app/lib/automation-readiness.ts・scripts/automation-readiness.ts）で
//     「手直しなしで送れた率」と「手直しの型の上位（次に直す候補）」を出すための物差し。
//
// 量（amount）は save-reply-example の was_ai_used / was_ai_modified と同じ線（bigram 類似度 0.9 / 0.3）に合わせる
// （同じ事実を2つの物差しで数えない）。絵文字と空白だけの違いは「tiny」＋型 emoji。
//
// 型（kinds・重なる）:
//   delete   … 下書きの文（行）を消した
//   add      … 下書きに無い文（行）を足した
//   rephrase … 下書きの文を言い換えた（似た行はあるが同じでない）
//   opening  … 冒頭の受け（はい／かしこまりました／承知しました 等）を替えた
//   name     … 呼びかけの名前（〇〇さん・お客様）を替えた・足した・消した
//   property … 物件名・号室を替えた
//   money    … 金額を替えた
//   datetime … 日付・時刻・本日/明日 等を替えた
//   emoji    … 絵文字だけ・絵文字も替えた
//   length   … 長さが3割以上変わった
//   dropped  … 生成文を送らず別の文を送った（AIX の送信の窓に生成文と似た文が無い・類似度 0.3 未満。見積書送るのカバーレター等）
// テスト: app/lib/__tests__/edit-diff.test.ts（本番の実物の対で固定）

export type EditAmount = "none" | "tiny" | "small" | "large" | "rewrite";
export type EditKind = "delete" | "add" | "rephrase" | "opening" | "name" | "property" | "money" | "datetime" | "emoji" | "length" | "dropped";

export const EDIT_AMOUNT_JA: Record<EditAmount, string> = {
  none: "そのまま", tiny: "ごく少し", small: "少し", large: "大きく", rewrite: "書き直し",
};
export const EDIT_KIND_JA: Record<EditKind, string> = {
  delete: "文を消した", add: "文を足した", rephrase: "言い換え", opening: "冒頭の受け", name: "名前",
  property: "物件・号室", money: "金額", datetime: "日時", emoji: "絵文字", length: "長さ（3割以上）", dropped: "生成文を使わず",
};

export type EditDiff = {
  amount: EditAmount;
  /** 全体の類似度（bigram・save-reply-example の textSimilarity と同じ式・絵文字と空白を除く前の文で） */
  sim: number;
  kinds: EditKind[];
  /** 下書きの行のうち消えた数・言い換えた数・送った文で足した行の数 */
  deleted: number;
  rephrased: number;
  added: number;
};

// 絵文字（記号の絵文字・異体字セレクタ・ZWJ を含む）
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]/gu;

function bigrams(text: string): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) s.add(text.slice(i, i + 2));
  return s;
}
/** save-reply-example（knowledge-utils.textSimilarity）と同じ式。ここは依存を持たないので同じ式を置く */
export function bigramSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

const nfkc = (s: string) => s.normalize("NFKC");
/** 比べる時の形: 絵文字・空白・感嘆符の数・句読点の揺れを落とす */
function core(s: string): string {
  return nfkc(s).replace(EMOJI_RE, "").replace(/\s+/g, "").replace(/[!！]+/g, "!").replace(/[。．]/g, "");
}
function emojiSig(s: string): string {
  return (s.match(EMOJI_RE) ?? []).filter((c) => c !== "\uFE0F" && c !== "\u200D").join("");
}

/** 行（＝1文の単位）に分ける。空行は捨てる。1行に「！！」で続く長い行は文で切る */
function units(s: string): string[] {
  const out: string[] = [];
  for (const line of s.split(/\n+/)) {
    const parts = line.split(/(?<=[!！]{2}|。)(?=[^!！。\s])/u);
    for (const p of parts) { const c = core(p); if (c.length >= 2) out.push(c); }
  }
  return out;
}

const OPENING_RE = /^(?:はい|かしこまりました|承知(?:致し|いたし|し)?ました|了解(?:です|しました)|ありがとうございます|ご連絡(?:頂き|いただき)ありがとうございます|お世話になっております|そうなんですね|大丈夫です)/u;
function opening(s: string): string {
  const first = core(s.split(/\n/).find((l) => core(l).length > 0) ?? "");
  // 呼びかけの名前を先に外す（「〇〇さん」「〇〇さん、」）
  const noName = first.replace(/^[^、,!]{1,12}さん[、,]?/u, "");
  return noName.match(OPENING_RE)?.[0] ?? "";
}

function tokenSet(s: string, res: RegExp[]): Set<string> {
  const t = nfkc(s).replace(/\s+/g, "");
  const out = new Set<string>();
  for (const re of res) for (const m of t.matchAll(re)) out.add(m[0].replace(/[,，]/g, ""));
  return out;
}
const MONEY_RES = [/[0-9][0-9,.]*(?:万円|万|円)/g];
const DATETIME_RES = [
  /[0-9]{1,2}[/月][0-9]{1,2}日?/g,
  /[0-9]{1,2}[:時][0-9]{0,2}分?/g,
  /(?:本日|今日|明日|明後日|あした|今週|来週|今月|来月|月末|月初)/g,
  /[(（][月火水木金土日][)）]/g,
];
// 物件名: 号室・【】の中・カタカナ/英字の4文字以上の語（設備・仕組みの一般語は除く＝本番の送信で多くの会話に出る語から作った一覧）
const GENERIC_KATAKANA = new Set((
  "ピックアップ オススメ オススメポイント サポート インターネット ネット オートロック エアコン インターホン フォーマット ボックス モニター リビング " +
  "マイナンバーカード システムキッチン ペット バストイレ バス トイレ シューズボックス ガスコンロ ウォークインクローゼット シューズインクローゼット スペース " +
  "コンクリート エントランス クローゼット キャンセル キャンペーン クリーニング カウンターキッチン キッチン フリーレント マンション アパート エレベーター " +
  "フリガナ メールアドレス アドレス アクセス ワンルーム エリア フローリング コンパクト ポイント リノベーション リフォーム セキュリティ タイミング イメージ " +
  "イエヤス スモラ LINE https http クレジットカード カード バルコニー ベランダ セーフティ スタート TVモニター LDK ロフト メゾネット デザイナーズ " +
  "オーナー スケジュール ブラックリスト ブラック ボタン サイト ページ ホームページ メッセージ スタッフ サービス プラン チェック リスト データ ファイル " +
  "アプリ スクショ スクリーンショット パスポート アルバイト パート フリーランス コンビニ スーパー ドラッグストア ファミリー カップル ルームシェア " +
  "テレワーク ユニットバス ウォシュレット シャワー プロパン ウォーターサーバー オプション セット プレゼント ギフト ポスト ハガキ コース ルーム タイプ " +
  "ゴミ ガス デザイン カウンター スムーズ シンプル ゆったり ゆとり ランキング ランク レベル バランス エステ"
).split(/\s+/).filter(Boolean));
function propertyTokens(s: string): Set<string> {
  const t = nfkc(s).replace(/\s+/g, "");
  const out = new Set<string>();
  for (const m of t.matchAll(/[0-9]{2,4}号室/g)) out.add(m[0]);
  for (const m of t.matchAll(/【([^】]{2,40})】/g)) out.add(m[1]);
  for (const m of t.matchAll(/[ァ-ヴーA-Za-zⅠ-Ⅻ][ァ-ヴー・A-Za-zⅠ-Ⅻ]{3,}/g)) {
    // 呼びかけの名前（「Hinaさん」「YUYA様」）は物件名にしない（名前の型で数える）
    const after = t.slice((m.index ?? 0) + m[0].length);
    if (/^(?:さん|様|ちゃん|くん)/.test(after)) continue;
    const parts = m[0].split("・").filter(Boolean);
    if (parts.every((x) => GENERIC_KATAKANA.has(x) || x.length < 4)) continue;
    out.add(m[0]);
  }
  return out;
}
// 呼びかけの名前は行頭の「〇〇さん」と「お客様」だけ（本文の「管理会社さん」等を拾わない）
function names(s: string): Set<string> {
  const out = new Set<string>();
  for (const line of nfkc(s).split(/\n/)) {
    const m = line.trim().match(/^([^、,!\s]{1,12})さん/u);
    if (m) out.add(m[1].replace(EMOJI_RE, ""));
    if (/^お客様/.test(line.trim())) out.add("お客様");
  }
  return out;
}
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** 事実の語（金額・日時・物件・呼びかけの名前）。classifyEdit の money/datetime/property/name と同じ物差し（見張りの判定 line-watch-judge.ts が使う） */
export type FactKind = "money" | "datetime" | "property" | "name";
export function factTokensOf(text: string): Record<FactKind, Set<string>> {
  const t = String(text ?? "");
  return { money: tokenSet(t, MONEY_RES), datetime: tokenSet(t, DATETIME_RES), property: propertyTokens(t), name: names(t) };
}
/** 比べる時の形（絵文字・空白・感嘆符の数・句点の揺れを落とす）。classifyEdit の「tiny＝同じ中身」と同じ */
export function editCore(s: string): string {
  return core(String(s ?? ""));
}

/**
 * 生成された文と送った文の差（純関数）。
 * @param generated AI の下書き・AIX の生成文（空なら呼ばない＝手打ち）
 * @param sent スタッフが実際に送った文
 */
export function classifyEdit(generated: string, sent: string): EditDiff {
  const g = String(generated ?? "").trim();
  const s = String(sent ?? "").trim();
  const sim = bigramSim(g, s);
  if (g === s) return { amount: "none", sim: 1, kinds: [], deleted: 0, rephrased: 0, added: 0 };

  const kinds = new Set<EditKind>();
  if (emojiSig(g) !== emojiSig(s)) kinds.add("emoji");
  const gc = core(g), sc = core(s);
  if (gc === sc) {
    // 絵文字・空白・感嘆符の数だけの違い
    if (!kinds.has("emoji")) kinds.add("rephrase");
    return { amount: "tiny", sim, kinds: [...kinds], deleted: 0, rephrased: 0, added: 0 };
  }

  // 行の対応（下書きの行 → 送った文の一番近い行）
  const gu = units(g), su = units(s);
  let deleted = 0, rephrased = 0, added = 0;
  const usedS = new Set<number>();
  for (const x of gu) {
    let best = -1, bestSim = 0;
    su.forEach((y, j) => { const v = x === y ? 1 : bigramSim(x, y); if (v > bestSim) { bestSim = v; best = j; } });
    // 送った文の行が下書きの行を含む（行をつなげた）も「残した」
    const contained = su.some((y) => y.includes(x));
    if (bestSim >= 0.999 || contained) { if (best >= 0) usedS.add(best); continue; }
    if (bestSim >= 0.4) { rephrased++; usedS.add(best); } else deleted++;
  }
  su.forEach((y, j) => {
    if (usedS.has(j)) return;
    const near = gu.some((x) => x === y || x.includes(y) || bigramSim(x, y) >= 0.4);
    if (!near) added++;
  });
  if (deleted > 0) kinds.add("delete");
  if (added > 0) kinds.add("add");
  if (rephrased > 0) kinds.add("rephrase");

  const og = opening(g), os = opening(s);
  if (og !== os) kinds.add("opening");
  if (!sameSet(names(g), names(s))) kinds.add("name");
  if (!sameSet(tokenSet(g, MONEY_RES), tokenSet(s, MONEY_RES))) kinds.add("money");
  if (!sameSet(tokenSet(g, DATETIME_RES), tokenSet(s, DATETIME_RES))) kinds.add("datetime");
  if (!sameSet(propertyTokens(g), propertyTokens(s))) kinds.add("property");
  const lg = gc.length, ls = sc.length;
  if (lg > 0 && Math.abs(ls - lg) / lg >= 0.3) kinds.add("length");

  const amount: EditAmount = sim >= 0.9 ? "tiny" : sim >= 0.6 ? "small" : sim >= 0.3 ? "large" : "rewrite";
  // 表示の順を固定する（型の上位を数える時にぶれない）
  const order: EditKind[] = ["opening", "name", "property", "money", "datetime", "delete", "add", "rephrase", "emoji", "length"];
  return { amount, sim, kinds: order.filter((k) => kinds.has(k)), deleted, rephrased, added };
}

/** 生成文を送らなかった（別の文を送った）時の差。型は dropped だけ（中身の型を数えると別の文との比べになり型の上位を汚す） */
export function droppedEdit(sim: number): EditDiff {
  return { amount: "rewrite", sim, kinds: ["dropped"], deleted: 0, rephrased: 0, added: 0 };
}

/** 手直しなし（そのまま送った）か。絵文字・空白だけの違いも手直しに数える（スタッフが触った事実） */
export function isUntouched(d: EditDiff | null | undefined): boolean {
  return !!d && d.amount === "none";
}
