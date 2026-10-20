// app/lib/flash-writer.ts — 下書きを書く役が DeepSeek の flash の時だけ、お客様が書いた一つ一つに答えきらせる（純関数・DB も fetch も持たない）
//
// 2026-10-18 竹内さん「flash の特徴に合わせていないのが原因。特徴に合わせれば質が上がるのでは」:
//   同じ16問・3回ずつで、ブレインの判断は flash も pro と同等以上なのに、下書きの合格は flash 38%・pro 57%。
//   外した型は「お客様が書いた細かい一つ一つに答えきれない」（q032 謝りを受けない・q157 物件ごとの答えを落とす・q164 お礼の受けを落とす・q057 問いへの直接の答えを落とす）。
//   下書きの指示（静的な system だけで約4.3万字）は pro／Claude 向けに育てた物で、小さいモデルは長い指示の真ん中にある「本質の一覧」を最後まで持てない。
//   → flash の時だけ:
//     ① 最後（一番近い所）に「答える項目の一覧」を短くはっきり渡す（ブレインの本質＝turn-contract の依頼ごとの答え方・物件名、無ければ依頼の台帳＋謝り・お礼）
//     ③ 書いた後に、一覧の全部に触れたかを語の重なりで確かめ、抜けていたら1回だけ書き直させる（費用は1回分まで・その後は今まで通りの最終チェック）
//   pro と Claude の時は何も足さない（指示は1文字も変えない）。止める: FLASH_WRITER_ADAPT=off（旧）
// テスト: app/lib/__tests__/flash-writer.test.ts

import type { TurnContract, ContractAsk } from "./turn-contract";
import type { RequestItem } from "./request-ledger";

export type EnvLike = Record<string, string | undefined>;

/** 既定 on・FLASH_WRITER_ADAPT=off で旧（何も足さない） */
export function flashWriterAdaptOn(env: EnvLike = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FLASH_WRITER_ADAPT ?? "").trim().toLowerCase() !== "off";
}
/** 書き直し（③）だけ止める: FLASH_WRITER_RECHECK=off */
export function flashWriterRecheckOn(env: EnvLike = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FLASH_WRITER_RECHECK ?? "").trim().toLowerCase() !== "off";
}
/** DeepSeek の flash 系のモデル名か（deepseek-flash・deepseek-v4-flash 等） */
export function isFlashModel(model: string | null | undefined): boolean {
  return !!model && /flash/i.test(model);
}

export type FlashChecklistItem = {
  /** お客様の言葉（短く） */
  label: string;
  /** どう答えるか（1行） */
  how: string;
  /** 抜けの確かめの語（どれか1つが下書きにあれば触れた） */
  keys: RegExp[];
  /** 下書きに必ず要る物件名（無ければ null） */
  mustProperty: string | null;
  /** 抜けの確かめをしない（AIX の項目・触れないなど＝一覧には出すが書き直しの理由にしない） */
  lenient: boolean;
};

const APOLOGY_RE = /すみません|すいません|申し訳|ごめんなさい|ごめんね|失礼しました|恐縮/;
const THANKS_RE = /ありがと|有難う|有り難う|助かります|感謝/;
const APOLOGY_COVER = /大丈夫|とんでもない|お気になさらず|お気遣い|お気軽|遠慮なく|ご遠慮|いつでも|何時でも|むしろ|嬉しい/;
const WORRY_RE = /不安|心配|難しい(?:かな|なって|ですかね)|迷って|悩んで|💦|思っちゃって|大丈夫(?:でしょうか|ですかね)/;
const WORRY_COVER = /ご不安|ご心配|不安|心配|大丈夫|ご安心|お気持ち|難しい|ですよね|かと思います|ご要望/;
const THANKS_COVER = /^.{0,25}(?:はい|ありがとうございます|こちらこそ|かしこまりました|承知)|恐れ入ります|とんでもない/;
const FEELING_COVER: Record<string, RegExp> = {
  apologetic: APOLOGY_COVER,
  anxious: /ご安心|大丈夫|ご不安|ご心配|心配|不安|最善|全力|お任せ|サポート|ですよね|お気持ち|かと思います|ご要望/,
  hurried: /急ぎ|早急|すぐ|至急|一番|早め|本日中|明日|最善|間に合/,
  disappointed: /残念|申し訳|お力になれず|次|他|改めて|全力|サポート|最善|ですよね|お気持ち/,
  positive: /嬉しい|良かった|よかった|ありがとうございます|ぜひ|是非|はい/,
};
const FEELING_JA: Record<string, string> = { anxious: "不安", apologetic: "恐縮・謝り", hurried: "急ぎ", disappointed: "落胆", positive: "前向き" };

/** 語の確かめから外す、どの文にも出る語 */
const STOP_WORDS = new Set([
  "確認", "お客様", "物件", "お部屋", "部屋", "させて", "頂き", "いただき", "ご連絡", "連絡", "お送り", "こちら", "そちら", "返信", "約束", "答える", "伝える",
  "場合", "今回", "以上", "以下", "対応", "可能", "必要", "大丈夫", "ありがとう", "お願い", "よろしく", "本日", "スモラ", "弊社",
]);
function contentWords(s: string): string[] {
  const t = String(s ?? "").normalize("NFKC");
  const out = new Set<string>();
  // 漢字の並び（2字以上）・カタカナの並び（3字以上）・英数（3字以上）
  for (const m of t.matchAll(/[一-鿿々〆ヶ]{2,}|[゠-ヿー]{3,}|[A-Za-z0-9]{3,}/g)) {
    const w = m[0];
    if (STOP_WORDS.has(w)) continue;
    out.add(w.length > 6 ? w.slice(0, 6) : w);
  }
  return [...out];
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function wordsRe(words: string[]): RegExp[] { return words.length ? [new RegExp(words.map(esc).join("|"))] : []; }
/** 物件名の照らし方（全角・半角・空白の揺れ）＝頭の4字以上 */
function propertyKey(name: string): string { return String(name ?? "").normalize("NFKC").replace(/[\s　]/g, "").slice(0, 5); }

function itemFromAsk(a: ContractAsk): FlashChecklistItem | null {
  if (a.route === "none") return null;
  const prop = a.axis?.property ? String(a.axis.property).trim() : "";
  const isFeeling = a.kind === "feeling" || a.kind === "report";
  const ans = a.answer ? String(a.answer).trim() : "";
  const how = a.route === "reply"
    ? (isFeeling ? `受け止める一言${ans ? `（${ans}）` : ""}` : `答える${ans ? `：${ans}` : "（会話・資料・会社の事実から直接答える）"}${a.kind === "question" ? "。結論の後に、その理由・仕組みを上の材料（会社の事実・知識・資料）にある事から一文で添える（材料に無い事は書かない）" : ""}`)
    : a.route === "promise"
      ? `約束の一文${ans ? `：${ans}` : ""}`
      : `受けの一文だけ（結果の中身は書かない${/^(?:property_check_result|estimate_sheet|guarantor_info|acknowledge_check)/.test(a.aixKey ?? "") ? "・「確認／作成しお送りさせて頂きます」の形" : ""}）`;
  const keyWords = [...new Set([...contentWords(ans), ...contentWords(a.quote)])].slice(0, 12);
  const extra: RegExp[] = [];
  if (APOLOGY_RE.test(a.quote)) extra.push(APOLOGY_COVER);
  if (isFeeling && THANKS_RE.test(a.quote)) extra.push(THANKS_COVER);
  return {
    label: String(a.quote).slice(0, 60),
    how: `${how}${prop ? `（物件名「${prop}」を書いて答える）` : ""}`,
    keys: [...extra, ...wordsRe(keyWords)],
    mustProperty: prop && a.route !== "aix" ? prop : null,
    lenient: a.route === "aix" || (keyWords.length === 0 && extra.length === 0),
  };
}

function itemFromLedger(x: RequestItem): FlashChecklistItem {
  const words = contentWords(x.quote).slice(0, 8);
  return {
    label: x.quote.slice(0, 60),
    how: x.route === "reply" ? "答える" : x.route === "promise" ? "答えるか約束の一文" : "受けの一文",
    keys: wordsRe(words),
    mustProperty: null,
    lenient: words.length === 0,
  };
}

/** お客様の今の連投の文（[画像]・URL・申込のフォームを除く）を文に分ける */
function sentencesOf(units: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const u of units) {
    const t = String(u ?? "").normalize("NFKC");
    if (/^\s*\[(?:画像|動画|ファイル|スタンプ)\]/.test(t) || /①|【ご入居の時期】|生年月日|携帯番号|フリガナ/.test(t)) continue;
    for (const s of t.split(/\n+|(?<=[。！!？?])/).map((z) => z.replace(/https?:\/\/\S+/g, "").trim()).filter((z) => z.length >= 2)) out.push(s);
  }
  return out;
}

/**
 * 答える項目の一覧。ブレインの本質（source=brain）があればその依頼ごとの答え方、無ければ依頼の台帳。
 * 本質・台帳が拾わない「謝り」「お礼」は今の連投の文から足す（q032・q164 の型）。気持ちを受ける番は1行足す。
 */
export function buildFlashChecklist(input: {
  contract: TurnContract | null | undefined;
  ledgerItems: ReadonlyArray<RequestItem>;
  customerUnits: ReadonlyArray<string>;
}): FlashChecklistItem[] {
  const items: FlashChecklistItem[] = [];
  const c = input.contract ?? null;
  if (c && c.source === "brain") {
    for (const a of c.asks) { const it = itemFromAsk(a); if (it) items.push(it); }
  } else {
    for (const x of input.ledgerItems) items.push(itemFromLedger(x));
  }
  // 2026-10-18 受け止める事（お礼・謝り・気遣い・不安の一言）は、答える事とは別の行で必ず並べる（flash の外れの多くは答えではなく受け止めの抜け: q164・q172・q032）
  const sents = sentencesOf(input.customerUnits);
  const apology = sents.find((s) => APOLOGY_RE.test(s));
  if (apology) items.push({ label: apology.slice(0, 60), how: "【受け止め】謝りを受ける一言（「全然大丈夫です」「お気になさらず」の形・いつでも言ってほしいと添える）", keys: [APOLOGY_COVER], mustProperty: null, lenient: false });
  const thanks = sents.find((s) => THANKS_RE.test(s) && !APOLOGY_RE.test(s));
  if (thanks) items.push({ label: thanks.slice(0, 60), how: "【受け止め】お礼・了承を受ける一言（「はい😊！！」の形で始める）", keys: [THANKS_COVER], mustProperty: null, lenient: false });
  const worry = sents.find((s) => WORRY_RE.test(s) && s !== apology && s !== thanks);
  if (worry) items.push({ label: worry.slice(0, 60), how: "【受け止め】お気持ち（不安・心配）を一言で受ける（お客様の言葉に触れる）", keys: [WORRY_COVER], mustProperty: null, lenient: false });
  if (c?.feeling?.acknowledge && c.feeling.kind && !items.some((it) => FEELING_COVER[c.feeling.kind!] && it.keys.includes(FEELING_COVER[c.feeling.kind!]))) {
    const k = c.feeling.kind;
    items.push({ label: `お客様の気持ち（${FEELING_JA[k] ?? k}）`, how: "本題の前に一言で受ける（お客様が書いた言葉に触れる）", keys: FEELING_COVER[k] ? [FEELING_COVER[k]] : [], mustProperty: null, lenient: !FEELING_COVER[k] });
  }
  return items.slice(0, 8);
}

/** 生成の一番最後に足す短い一覧（項目が無ければ空） */
/**
 * 2026-10-18 flash の癖②: 頼まれていない内覧・申込の誘い（「お気に召されましたら実際にお部屋ご案内させて頂きます」）を足す（q164 は flash 3回中2〜3回）。
 *   ブレインの本質（source=brain）に内覧・申込の提案も依頼も無い番は、誘いを書かせない（本質の「一覧に無い提案は書かない」と同じ線を、flash には最後にはっきり）。
 */
export const INVITE_RE = /(?:お部屋)?ご案内(?:させて|致し|いたし|可能|出来|でき)|ご内覧(?:頂|いただ|可能|出来|でき|の際)|内見(?:頂|いただ|可能|出来|でき)|お申込(?:み)?(?:し|頂|いただ)[^。！!\n]{0,10}(?:抑え|押さえ)|お部屋(?:抑え|押さえ)させて/;
export function contractForbidsInvite(c: TurnContract | null | undefined): boolean {
  if (!c || c.source !== "brain") return false;
  const hay = [...c.proposals, ...c.asks.map((a) => `${a.quote} ${a.answer ?? ""} ${a.aixKey ?? ""}`)].join(" ");
  if (/内覧|内見|案内|申込|抑え|押さえ|viewing|application/.test(hay)) return false;
  return !c.asks.some((a) => a.topic === "viewing");
}
export function renderFlashChecklistNote(items: ReadonlyArray<FlashChecklistItem>, o: { closeOnly?: boolean; noInvite?: boolean } = {}): string {
  if (!items.length && !o.noInvite) return "";
  const L = [
    "【✅ 最後に確かめる：答える項目の一覧（全部に一言ずつ）】",
    "上の指示はそのまま守る。そのうえで、お客様が書いた次の一つ一つに、下書きの中で必ず触れること（1つも落とさない・まとめて流さない）。",
    ...items.map((it, i) => `${i + 1}. 「${it.label}」→ ${it.how}`),
    "- お客様の言葉・物件名はそのまま使って答える（「その件」「こちら」でぼかさない）。",
    "- 一覧に無い約束・提案・説明は足さない。",
  ];
  if (o.closeOnly) L.push("- 返事の要らない番なので、各項目は短い一言で受けて閉じる。");
  if (o.noInvite) L.push("- この番は内覧・申込の誘いを書かない（お客様が頼んでいない・ブレインの提案に無い）。✕「お気に召されましたら実際にお部屋ご案内させて頂きます」／○「気になる点出てきましたら何時でもお気軽にご連絡ください」");
  // 2026-10-18 (b) 同じ外れの型には悪い例と良い例の対（竹内さんの実送信の形・名前と物件は伏せた）
  const pairs: string[] = [];
  if (items.some((it) => APOLOGY_RE.test(it.label))) pairs.push("✕ 「かしこまりました！！その条件でお探しさせて頂きます！！」（謝りに触れない）／○ 「全然大丈夫です😊！！ご要望はいつでもお気軽にお申し付けください！！その条件でお探しさせて頂きます！！」");
  if (items.some((it) => it.mustProperty)) pairs.push("✕ 「お送り頂いた物件、確認させて頂きます！！」（物件ごとに答えない）／○ 「〇〇（物件名）の代理契約につきましては管理会社に交渉させて頂きます！！お送り頂きました△△（物件名）の募集状況も確認させて頂きます！！」");
  if (items.some((it) => THANKS_RE.test(it.label))) pairs.push(o.closeOnly ? "✕ お礼に新しい約束・内覧の誘いを足す／○ 「はい😊！！気になる点出てきましたら何時でもお気軽にご連絡ください！！」" : "✕ お礼に触れずにいきなり本題／○ 「はい😊！！（または ご要望お聞かせ頂きありがとうございます😊！！）」で受けてから本題");
  if (items.some((it) => WORRY_RE.test(it.label))) pairs.push("✕ 不安の一言を飛ばして約束だけ／○ 「〇〇だと△△が難しいですよね。」「ご不安ですよね。」のようにお客様の言葉で一言受けてから約束");
  if (pairs.length) L.push("- 例:", ...pairs.map((p) => `  ${p}`));
  L.push("仕事（言い直し）: 上の一覧の全部に一言ずつ触れた、スモラらしい返信本文を1つだけ書く。");
  return L.join("\n");
}

/** 下書きが触れていない項目（③の書き直しの理由）。lenient の項目は数えない */
export function missingFlashItems(items: ReadonlyArray<FlashChecklistItem>, draft: string): FlashChecklistItem[] {
  const t = String(draft ?? "").normalize("NFKC").replace(/[\s　]/g, "");
  return items.filter((it) => {
    if (it.lenient) return false;
    if (it.mustProperty && !t.includes(propertyKey(it.mustProperty))) return true;
    if (!it.keys.length) return false;
    return !it.keys.some((re) => re.test(t));
  });
}

/** ③ 書き直しの依頼（1回だけ）。invite＝頼まれていない誘いが入っていた */
export function buildFlashRewriteFeedback(missing: ReadonlyArray<FlashChecklistItem>, o: { invite?: string | null } = {}): string {
  return [
    "【書き直しの依頼】",
    ...(missing.length ? ["直前の返信の下書きは、お客様が書いた次の項目に触れていません。", ...missing.map((it, i) => `${i + 1}. 「${it.label}」→ ${it.how}`)] : []),
    ...(o.invite ? [`頼まれていない内覧・申込の誘い「${o.invite}」が入っています。この番は誘いを書かない（気になる点はいつでもご連絡ください、の形で閉じる）。`] : []),
    "直した返信を、これまでと同じ指示・同じ条件で最初から書き直してください。",
    "- 触れていた部分の内容・トーンは保つ。一覧に無い約束・提案・説明は足さない。",
    "- 返信本文のみを出力すること（説明・前置きは書かない）。",
  ].join("\n");
}

/**
 * 2026-10-18 追加（竹内さん「どうにかして flash で質も改善できるように」）: どの手当てを入れるか（flash の時だけ・比べるための切り替え）。
 *   list     … ①④ 答える項目の一覧を一番最後に置く
 *   examples … ④ 竹内さんの実物の送った文の例（今の材料の手本の上位2つ）を一覧の前・一番最後に置く
 *   recheck  … ③ 書いた後に一覧の全部に触れたか確かめ、抜けていたら1回だけ書き直す
 *   plan     … ⑤ 2段に分ける（まず何に・どの形で答えるかだけを短く決めさせ、その決めた物だけを見て文を書く）
 *   FLASH_WRITER_PARTS="list,recheck" のように書く。無ければ既定（DEFAULT_FLASH_WRITER_PARTS）
 */
export type FlashWriterPart = "list" | "examples" | "recheck" | "plan";
export const DEFAULT_FLASH_WRITER_PARTS: ReadonlyArray<FlashWriterPart> = ["list", "recheck"];
export function flashWriterParts(env: EnvLike = typeof process !== "undefined" ? process.env : {}): Set<FlashWriterPart> {
  const raw = (env.FLASH_WRITER_PARTS ?? "").trim();
  if (!raw) return new Set(DEFAULT_FLASH_WRITER_PARTS);
  const ok = new Set<FlashWriterPart>(["list", "examples", "recheck", "plan"]);
  return new Set(raw.split(",").map((x) => x.trim() as FlashWriterPart).filter((x) => ok.has(x)));
}

/** 手本の文（【⭐ スモラの実際の返信例】の [例N]）の上位 n 件をそのまま切り出す（無ければ空） */
export function topExamples(examples: string, n = 2): string {
  const s = String(examples ?? "");
  const parts = s.split(/\n\n(?=\[例\d+)/).filter((p) => /^\[例\d+/.test(p));
  return parts.slice(0, n).join("\n\n");
}
export function renderFlashExamplesNote(examples: string, n = 2): string {
  const ex = topExamples(examples, n);
  return ex ? `【⭐ 書き方の手本（竹内さん・スモラが実際に送った文・上の手本の上位${Math.min(n, ex.split(/\n\n(?=\[例)/).length)}つ）】文体・テンポ・受け方だけを真似る（中身・金額・物件名は写さない）。\n${ex}` : "";
}

/** ⑤ 1段目: 何に・どの形で答えるかだけを決めさせる（本文は書かせない・短い出力） */
export function buildFlashPlanRequest(items: ReadonlyArray<FlashChecklistItem>): string {
  return [
    "【1段目：まだ返信の本文は書かない】",
    "この番の返信で答える項目を決めるだけ。お客様が書いた一つ一つ（謝り・お礼・気持ち・質問・依頼・報告）について、1行ずつ「お客様の言葉 → 返信で答える／約束する／AIX で受ける／受けの一言 → 本文に書く要点（物件名・数字はそのまま）」を書く。",
    items.length ? `参考（ブレインの判断・依頼の一覧）:\n${items.map((it, i) => `${i + 1}. 「${it.label}」→ ${it.how}`).join("\n")}` : "",
    "上の指示（本質・言わない事・安全の線）に従う。一覧に無い約束・提案は足さない。8行まで。箇条書きだけを出力する。",
  ].filter(Boolean).join("\n");
}
/** ⑤ 2段目: 決めた物だけを見て文を書く */
export function buildFlashWriteRequest(): string {
  return "【2段目】いま決めた項目だけを、全部・一言ずつ入れて、返信本文を書いてください。上の指示（挨拶・禁止ワード・形・言わない事）はそのまま守る。決めた項目に無い約束・提案・説明は足さない。返信本文のみを出力する（箇条書き・説明・前置きは書かない）。";
}
