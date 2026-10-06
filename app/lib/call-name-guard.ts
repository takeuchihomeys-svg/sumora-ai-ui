// app/lib/call-name-guard.ts — お客様の呼び名を1つに固定し、文の中の別の名前の呼びかけを出口で直す（純関数・画面からも読む）
//
// 2026-10-06 ⑫ 竹内「名前間違えているの絶対にいれない。原因みつけてかいぜんする。こんかい あさんやのになぜこうなったのか。
//   お客さん毎に名前決まったら固定していたらこんなミス起きないのじゃないか」
//   あ（スモラ）10/06 16:29 の下書き「…森本様のご都合よろしいお日にちにてお申し付けください！！」。「森本」は会話・手本・ナレッジ・物件の資料の
//   どこにも無い（DB 全体で この下書き1件だけ）＝返信の LLM（DeepSeek）が作った名前。
//   原因: 呼び名の決定（validate-reply.resolveAddressName）は名前の形（ひらがな2〜8字・漢字1〜4字…）で本物かを決め、
//   1文字の「あ」を名前として採らず「呼び名なし」で生成した → LLM が呼びかけを作った。最終チェックは NAME_MISMATCH（block）を出したが
//   出口のゲートが影の運用（shadow）で、下書きは画面にそのまま出た。
//   直し: ① 呼び名はスタッフが冒頭で2回以上呼んだ名前（形を問わない・aix-staff-called-name）を採り、会話に固定（conversations.call_name）。
//         ② 出口（下書きの保存・AIX）で、呼びかけの形（行頭の「〇〇さん」・「〇〇様のご都合」「〇〇さんにオススメ」等）の名前が
//            固定の呼び名でも、会話・登録名・表示名に出てくる名前でもない時だけ、固定の呼び名に置き換える（無ければ呼びかけごと外す）。
//            会話に出てくる名前（連名者・保証人・紹介者・管理会社の担当）は触らない

/** 名前でない語（お客様・管理会社・お疲れ様…）。aix-staff-called-name・validate-reply と同じ向き */
const NOT_A_NAME_RE = /^(?:お客|皆|みな|各位|管理|オーナー|大家|貸主|借主|業者|元付|担当|スタッフ|弊社|御社|貴社|会社|不動産|保証|ご家族|ご両親|お母|お父|旦那|奥|彼女|彼氏|友人|お子|ご主人|お嬢|息子|娘|婚約者|パートナー|社長|代表|先方|相手|自分|ご本人|本人|名義|入居者|申込者|契約者|連帯|同居|緊急|勤務|ご友人|ご紹介|紹介者|ご近所|お隣|他の|別の|その他|他社|先輩|後輩|ご親戚|親戚|ご兄弟|兄弟|姉妹|お兄|お姉|弟|妹|お疲れ|ご苦労|お世話|お待た|ご馳走|お互い|お大事|ご愁傷|おかげ|お陰|みんな)|(?:屋|社|店|会|局|所|課|部)$/;
/** 名前の字（記号・絵文字も呼び名に使われる＝「⟡.·さん」「❤︎さん」）。区切りの字・助詞の混ざる長い塊は名前にしない */
const NAME_CHARS = "[^\\s、。！!？?「」『』（）()【】・\\n]";
/** 呼びかけの形: ① 行頭 ② 「〜の(ご|お)」「〜に(オススメ|ご案内|お送り|ご提案|合)」「〜が(ご|お)」「、」「！」が続く */
const HEAD_RE = new RegExp(`(^|\\n)([ \\t　「]*)(${NAME_CHARS}{1,10}?)(様|さん|さま)(?=$|\\n|[ 　、,！!。]|お世話|お待た|ご連絡|いつも|こんにちは)`, "g");
const COLLOC_RE = new RegExp(`(^|[\\s、。！!？?「（(])(${NAME_CHARS}{1,10}?)(様|さん|さま)(?=の(?:ご|お)|に(?:は|も)?(?:オススメ|おすすめ|ご案内|お送り|ご提案|合|ピッタリ|ぴったり)|が(?:ご|お)|、|！)`, "g");

const norm = (s: string) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** 名前らしい塊か（漢字＋ひらがなの文の切れ端「新着で〇〇」「引越し準備の」は名前にしない。ひらがなだけ・カタカナ・英字・記号・漢字だけは名前） */
function looksLikeName(x: string): boolean {
  if (NOT_A_NAME_RE.test(x)) return false;
  if (/[一-鿿々]/.test(x) && /[ぁ-ん]/.test(x)) return false; // 漢字とひらがなの混ざり＝文の切れ端
  if (x.length > 8) return false;
  return true;
}

export type CallNameFix = { text: string; replaced: string[] };

/**
 * 文の中の呼びかけの「X様／Xさん」で、X が固定の呼び名・許す名前（登録名・表示名・別名）・会話に出てくる名前のどれでもない物を直す。
 *   callName あり → 「{callName}さん」（スタッフの実送信は「〇〇さん」）／ 無し → 呼びかけごと外す
 */
export function enforceCallName(
  text: string | null | undefined,
  callName: string | null | undefined,
  contextTexts: ReadonlyArray<string | null | undefined> = [],
  allowedNames: ReadonlyArray<string | null | undefined> = [],
): CallNameFix {
  const src = String(text ?? "");
  const name = String(callName ?? "").trim();
  const ctx = norm(contextTexts.map((x) => String(x ?? "")).join("\n"));
  const allowed = [name, ...allowedNames.map((x) => String(x ?? "").trim())].filter(Boolean).map(norm);
  const replaced: string[] = [];
  const ok = (x: string) => {
    if (!looksLikeName(x)) return true;
    const n = norm(x);
    if (!n) return true;
    if (allowed.some((a) => a === n || a.includes(n) || n.includes(a))) return true;
    if (ctx.includes(n)) return true;
    return false;
  };
  let out = src.replace(HEAD_RE, (m, br: string, lead: string, x: string, hon: string) => {
    if (ok(x)) return m;
    replaced.push(`${x}${hon}`);
    return name ? `${br}${lead}${name}さん` : `${br}${lead}`;
  });
  out = out.replace(COLLOC_RE, (m, pre: string, x: string, hon: string) => {
    if (ok(x)) return m;
    replaced.push(`${x}${hon}`);
    return name ? `${pre}${name}さん` : pre;
  });
  if (!replaced.length) return { text: src, replaced };
  // 呼びかけを外した時に残る「のご都合」「、」の頭を整える（「森本様のご都合」→「ご都合」）・空になった行は落とす
  if (!name) out = out.replace(/(^|[\s、。！!？?「（(\n])(?:の|に|が|、|,)(?=[^\s])/g, "$1").replace(/\n[ \t　]*\n(?=[ \t　]*\n)/g, "\n");
  return { text: out, replaced };
}

/**
 * 会話の固定の呼び名を決める（保存した呼び名 → スタッフが冒頭で2回以上呼んだ名前 → 確定の呼び名（resolveAddressName）の順）。
 *   保存した呼び名はスタッフが画面で直せる。無ければ ""（呼びかけを書かない）
 */
export function lockedCallName(i: { stored?: string | null; staffCalled?: string | null; resolved?: string | null }): { name: string; source: "stored" | "staff_called" | "resolved" | "none" } {
  const s = String(i.stored ?? "").trim();
  if (s) return { name: s, source: "stored" };
  const st = String(i.staffCalled ?? "").trim();
  if (st) return { name: st, source: "staff_called" };
  const r = String(i.resolved ?? "").trim();
  if (r) return { name: r, source: "resolved" };
  return { name: "", source: "none" };
}
