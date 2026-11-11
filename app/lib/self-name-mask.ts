// app/lib/self-name-mask.ts — お客様が自分で名乗った本名を伏せる（純関数・お客様の発言だけに使う）
//
// 2026-11-11 作業員5（統括役: 文の解剖の 23d3865f で、お客様が名乗った漢字の本名が takeuchi_compose_examples.customer_gist に残り DeepSeek に渡った）。
//   compose-name-mask（表示名・呼び名・こちらの文の頭の「〇〇さん」）は、表示名と違う本名を名乗った通を拾えない。maskPII も漢字の名前は拾わない。
//   → 名乗りの形（「〇〇と申します」「名前は〇〇」「〇〇です（、よろしく）」の短い行）だけを見て、名前の部分を YUMA にする。
//   線: 迷ったら伏せる側（伏せすぎは文の解剖の材料が少し欠けるだけ）。ただし物件名・駅名・区・会社名・よくある言葉（大丈夫です・了解です・学生です）は伏せない。
//   こちら（スタッフ）の文には使わない（「担当させて頂きます鈴木と申します」はスタッフの名前で、お客様の名前ではない）。
//   監査（11/11・roles-r1 の 198通のお客様の要約）: 変わったのは 23d3865f の1通だけ（言葉の行「審査は不安です」「追記です」「〜大丈夫です」は伏せない）。
// テスト: app/lib/__tests__/self-name-mask.test.ts
import { isKnownStation } from "./osaka-geo";

const TO = "YUMA";
const KANJI = "一-龥々〆ヶ";
/** 名前の字（漢字・かな・英字・間の空白） */
const NAME_CH = `[${KANJI}ぁ-んァ-ヶーA-Za-z]`;
const KANJI_NAME_RE = new RegExp(`^[${KANJI}]{2,5}$`);
const KANJI_SEI_MEI_RE = new RegExp(`^[${KANJI}]{1,3} [${KANJI}ぁ-んァ-ヶー]{1,4}$`);
const KANJI_HEAD_RE = new RegExp(`^[${KANJI}]`);
/** よくある言葉・身分・状況（「〇〇です」で名前ではない物） */
const STOP_WORDS = new Set([
  "大丈夫", "了解", "承知", "以上", "本人", "結構", "問題", "無理", "未定", "不安", "希望", "最高", "最悪", "残念", "心配", "安心", "楽しみ", "検討中", "元気", "同じ", "一緒",
  "賃貸", "内覧", "内見", "初期費用", "家賃", "予算", "学生", "大学生", "専門学生", "社会人", "会社員", "主婦", "無職", "夜職", "昼職", "自営業", "個人事業主", "正社員", "派遣", "契約社員",
  "単身", "同棲", "夫婦", "家族", "一人", "二人", "三人", "独身", "女性", "男性", "担当", "紹介", "友達", "別", "他", "今", "今日", "明日", "明後日", "今週", "来週", "今月", "来月",
  "毎日", "平日", "土日", "休み", "仕事", "在宅", "転勤", "就職", "入学", "子供", "子ども", "犬", "猫", "ペット", "了承", "承知致しました", "お願い", "宜しく", "よろしく", "幸い", "可能", "不可",
  "必要", "不要", "大変", "最短", "早め", "急ぎ", "未成年", "成人", "初めて", "初心者", "引越し", "引っ越し", "新築", "築浅", "角部屋", "南向き", "駅近", "空室", "満室", "退去予定", "入居中",
  "追記", "補足", "質問", "確認", "相談", "連絡", "返信", "失礼", "本当", "普通", "大事", "重要", "理想", "条件", "候補", "第一候補", "不明", "同上", "同様", "遠方", "県外", "府外", "関東", "関西", "地方", "実家", "社宅", "寮",
  "はい", "いいえ", "そう", "それ", "これ", "あれ", "どれ", "ここ", "そこ", "ありがとう", "すみません", "了解しました", "わかりました", "分かりました", "かしこまりました",
]);
/** 名前ではない終わり方（駅・区・物件・状態）。村・中・人・名・日 は姓名にもある（木村・田中・隼人・椎名・春日）＝数の言葉の時だけ外す（NUM_TAIL） */
const NOT_NAME_TAIL = /(?:駅|区|市|町|線|号室|号|階|棟|円|万|歳|才|部屋|LDK|DK|K|済|済み|的|様|さん|ちゃん|くん|予定|希望|以上|以下|程度|くらい|ぐらい|ほど|だけ|のみ|まで|から|より|かな|かも|でした|会社|株式会社|不動産|マンション|ハイツ|レジデンス|コーポ|荘|(?:検討|募集|入居|審査|仕事|移動|勉強|妊娠|休職|就活)中)$/;
const NUM_TAIL = /^[一二三四五六七八九十百何数今明毎昨先来再半]+(?:人|名|日|月|時|分|件|階|回|年|週|部屋)$/;

/** 名前として伏せてよいか（strict＝名乗りの合図の無い「〇〇です」だけの行） */
function nameLike(raw: string, strict: boolean): boolean {
  const x = raw.replace(/[\s　]+/g, " ").trim();
  const flat = x.replace(/ /g, "");
  if (!flat || Array.from(flat).length < 2 || Array.from(flat).length > 12) return false;
  if (/\d|[０-９]/.test(flat)) return false;
  if (flat.includes(TO)) return false;
  if (STOP_WORDS.has(flat)) return false;
  if (NOT_NAME_TAIL.test(flat) || NUM_TAIL.test(flat)) return false;
  if (!strict) return true;
  // 駅名は合図の無い「〇〇です」だけの行の時だけ外す（山田・梅田は駅にも姓にもある。名乗りの形なら伏せる側）
  if (isKnownStation(flat)) return false;
  if (/^[A-Za-z]+(?: [A-Za-z]+)?$/.test(x)) return true;
  // 頭が漢字の時は「漢字2〜5字」か「漢字の姓＋空白＋名」だけ（「審査は不安」「なくても大丈夫」のように助詞・かなの入る言葉は名前にしない・11/11 r1 の監査で3通）
  if (KANJI_HEAD_RE.test(flat)) return KANJI_NAME_RE.test(flat) || KANJI_SEI_MEI_RE.test(x);
  // かなだけ・カタカナだけ（物件名・言葉に多い）は、空白で区切った2語の時だけ
  return / /.test(x);
}

const BOUND = String.raw`(^|[\s、。，,．！!？?「『（(:：・]|はじめまして|初めまして|こんにちは|こんばんは|おはようございます)`;
const NAME = String.raw`(${NAME_CH}(?:${NAME_CH}|[\s　](?=${NAME_CH})){1,11})`;
/** ① 「名前は〇〇」「氏名：〇〇」「本名〇〇」 */
const LABEL_RE = new RegExp(String.raw`((?:お?名前|氏名|本名|フルネーム|なまえ)(?:は|が|:|：|＝|=)?[\s　]*)${NAME}(?=$|[\s、。，,！!？?]|と申|といい|と言い)`, "gu");
/** ② 「〇〇と申します」「〇〇といいます」 */
const MOUSU_RE = new RegExp(String.raw`${BOUND}((?:私は|わたしは|僕は|自分は)?[\s　]*)${NAME}(?=(?:[（(][^（）()\n]{1,20}[）)])?[\s　]*(?:と申します|と申す者|といいます|と言います|って言います|っていいます))`, "gu");
/** ②の2 「〇〇（読み・別名）と申します」の括弧の中（11/11 監査: 表示名で伏せた後に「YUMA（カタカナの名前）と申します」が1行残っていた）。括弧の中は名前とみなして伏せる */
const MOUSU_PAREN_RE = /([（(])([^（）()\n]{1,20})([）)])(?=[\s　]*(?:と申します|と申す者|といいます|と言います|って言います|っていいます))/gu;
/** ③ 「〇〇です！」「〇〇です、よろしくお願いします」だけの短い行 */
const DESU_LINE_RE = new RegExp(String.raw`^((?:[\s　]*(?:はじめまして|初めまして|こんにちは|こんばんは)[、。！!\s　]*)?(?:私は|わたしは|僕は|自分は)?[\s　]*)${NAME}([\s　]*(?:です|でーす|になります)(?:[、。！!～〜\s　😊🙇‍♀️🙏]*|[、。！!\s　]*(?:よろしく|宜しく)[^\n]*)?)$`, "u");
const CUE_RE = /はじめまして|初めまして|私は|わたしは|僕は|自分は|よろしく|宜しく/;

/** お客様の発言の中の、自分で名乗った名前を YUMA にする。行ごとに見る */
export function maskSelfIntroducedNames(text: string | null | undefined): string {
  const src = String(text ?? "");
  if (!src) return src;
  return src.split("\n").map((line) => {
    let r = line.replace(LABEL_RE, (all, pre: string, name0: string) => {
      // 名前の字にかなが入るので「鈴木一郎です」まで取る → 終わりの「です・でーす・になります」は名前の外に戻す
      const tail = name0.match(/(?:です|でーす|になります|でございます)$/)?.[0] ?? "";
      const name = tail ? name0.slice(0, -tail.length) : name0;
      return nameLike(name, false) ? `${pre}${TO}${tail}` : all;
    });
    r = r.replace(MOUSU_PAREN_RE, (all, o: string, inner: string, c: string) => (inner.includes(TO) ? all : `${o}${TO}${c}`));
    r = r.replace(MOUSU_RE, (all, b: string, pre: string, name: string) => (nameLike(name, false) ? `${b}${pre}${TO}` : all));
    if (r === line && Array.from(r).length <= 40) {
      const m = r.match(DESU_LINE_RE);
      if (m) {
        const [, pre, name, post] = m;
        const cue = CUE_RE.test(r);
        const kanaOnly = /^[ぁ-んァ-ヶー]+$/.test(name.replace(/[\s　]+/g, ""));
        if (nameLike(name, !cue) && (!kanaOnly || cue)) r = `${pre}${TO}${post}`;
      }
    }
    return r;
  }).join("\n");
}

/** 名乗った名前が残っていそうか（数えるだけ・監査用）。伏せる前後で変わるなら残っていた */
export function hasSelfIntroducedName(text: string | null | undefined): boolean {
  const s = String(text ?? "");
  return !!s && maskSelfIntroducedNames(s) !== s;
}

/** 名乗った名前そのもの（こちらの文で「〇〇さん」と呼んでいる所も伏せるため）。2文字以上・YUMA は除く */
export function selfIntroducedNames(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const line of String(text ?? "").split("\n")) {
    const masked = maskSelfIntroducedNames(line);
    if (masked === line) continue;
    // 伏せる前後の違う所＝名前（YUMA に置き換わった所の元の字）
    let i = 0;
    while (i < line.length && line[i] === masked[i]) i++;
    let j = line.length - 1, k = masked.length - 1;
    while (j >= i && k >= i && line[j] === masked[k]) { j--; k--; }
    const name = line.slice(i, j + 1).trim();
    if (name && name !== TO) { out.add(name); out.add(name.replace(/[\s　]+/g, "")); for (const p of name.split(/[\s　]+/)) if (Array.from(p).length >= 2) out.add(p); }
  }
  return [...out].filter((n) => Array.from(n).length >= 2).sort((a, b) => Array.from(b).length - Array.from(a).length);
}

/** 既定 on（伏せを強める安全の線）。止める SELF_NAME_MASK=off */
export function selfNameMaskOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SELF_NAME_MASK ?? "").trim().toLowerCase() !== "off";
}

/** 外の LLM の直前: お客様の発言の名乗りを伏せ、その名前をこちらの文からも伏せる（どちらも既に伏せ済みの物に重ねる） */
export function maskSelfNamesPair(customer: string | null | undefined, staff: string | null | undefined, env?: Record<string, string | undefined>): { customer: string | null; staff: string } {
  const c = customer == null ? null : String(customer);
  const s = String(staff ?? "");
  if (!selfNameMaskOn(env)) return { customer: c, staff: s };
  const names = selfIntroducedNames(c);
  let st = s;
  for (const n of names) st = st.split(n).join(TO);
  return { customer: c == null ? null : maskSelfIntroducedNames(c), staff: st };
}
