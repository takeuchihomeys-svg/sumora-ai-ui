// app/lib/rent-question.ts
// 2026-10-02 ⑫（竹内さん「相場の知識は物件検索ブレインからもらう形になっているかな？返信の部分が」）:
//   お客様が家賃の相場・予算で出るか（「8.5までの家賃で1dkはやっぱりないですよね💦」「この家賃だと厳しいですか」「相場ってどれくらい」）を聞いた番か。
//   当たる時だけ、物件検索のブレインの1つの元（area-rent-server.customerAreaAndRent）から相場の材料を受けて返信に渡す（数字は材料の物だけ）。
//   線は scripts/audit-rent-question.ts（お客様の発言で当たる文を目で読む）
const RENT_LEVEL_RE = new RegExp([
  String.raw`相場`,
  // 「8.5までの家賃で1dkはやっぱりないですよね」「7万以内だと厳しいですか」「この家賃だと難しい」
  String.raw`(?:[0-9０-９.．]+\s*万?(?:円)?(?:まで|以内|以下|台|前後)?|家賃|予算)[^。\n？?]{0,24}?(?:ない|無い|厳し|難し|出てこ|見つから|ありますか|あるんですか|あります？|ないですか)(?:ですよね|ですか|でしょうか|よね|かな|か)?`,
  String.raw`(?:家賃|予算)[^。\n]{0,10}(?:上げ|あげ)(?:たら|れば|ないと)`,
].join("|"), "i");
/** 物件1件の空きの質問（「ここ空いてますか」）は相場の質問ではない */
const NOT_RENT_RE = /空い|空き|募集|内覧|見積|初期費用|支払|振込|振り込|滞納|日割|請求|確定申告|お安く(?:出来|でき)|交渉|①|【|ご希望|諦め|保証/;
/** 「ない／厳しい／ありますか」の問いの形（言い切りの条件の連絡を外す） */
const ASK_FORM_RE = /(?:ない|無い|厳し|難し|出てこ|見つから|あり)(?:ます)?(?:ですよね|ですかね|ですか|でしょうか|よね|かな|か)?s*[？?💦😭🥲、,]|(?:ない|無い)(?:です)?よね|(?:ない|無い)感じ|相場/;

// 2026-10-07（返信の質の1巡目・穴:G1 材料の欠け）: 上の形だけでは、スタッフが相場の事実で答えている質問の多くが当たらず、
//   相場の材料が返信に届いていなかった（下書きは答えずに「ピックアップさせて頂きます」へ逸れた・チンシャン「2LDKだともう少し上がりますか？」／
//   五嶋「家賃をいくらまでにしたら、堺筋本町あたりに物件が出てきますか？」→ スタッフは「相場は13万円から」「11万、12万に広げて頂けますと出てくる」）。
//   ①「厳しいですか／難しいですよね／むずかしいですか」は ASK_FORM_RE が「厳し」の直後に「い」を許さず当たらなかった（「6万以下は厳しいですよね💦」）
//   ② 比べる問い（家賃って上がりますか・平野区とかは家賃高いですか・2LDKだともう少し上がりますか・家賃安めのエリアだとどこら辺）
//   ③ いくらなら出るか・平均（家賃をいくらまでにしたら・1LDKだと平均的に家賃いくらくらい）
//   ④ 予算と間取り・築年の引き換え（家賃8万円くらいに抑えたいのでその場合は1Kになりますよね・家賃5万円代の物件ってやはり築が古くなりますか・6万を切る物件ってどんな感じ）
//   線は scripts/audit-rent-question-1007.ts（365日のお客様の発言の候補 259通を全部読んだ・新しく当たる通も全部読む）。
//   当てない: 物件1件の家賃の確かめ（「家賃81000円ですよね？」「桜川の物件の家賃はいくら」）・支払い・日割・値下げの依頼・条件の言い切り（「家賃をあげるのは厳しいです。」）
const RENT_HARD_ASK_RE = /(?:家賃|予算|相場|[0-9０-９.．]+\s*万(?:円)?(?:台|代)?(?:まで|以内|以下|未満|前後|くらい|ぐらい|程度)?)[^。\n？?]{0,24}?(?:厳し|難し|むずかし)い(?:です)?(?:よね|か|かね|でしょうか)/;
const RENT_COMPARE_RE = new RegExp([
  // 家賃って上がりますか・家賃高いですか・家賃安くなりますか（〜か／〜ですか／〜でしょうか）
  String.raw`(?:家賃|相場)(?:って|は|が|も)?[^。\n？?]{0,8}?(?:上が|下が|高い|高く|安い|安く)(?:り|なり|い)?(?:ます|ません|ません?か|です)?(?:か|よね|かね|でしょうか)`,
  // 2LDKだともう少し上がりますか（間取り・広さの言い換えで家賃が上がるか）
  String.raw`(?:[1-4１-４]\s*(?:S?LDK|DK|K)|ワンルーム|1R)(?:だと|にすると|にしたら|になると|の方が)[^。\n？?]{0,10}?(?:上が|高く|下が|安く)(?:り|なり)?(?:ます|ません)?(?:か|よね|かね|でしょうか)`,
  // 家賃安めのエリアだとどこら辺・家賃が安いのはどの辺
  String.raw`(?:家賃|相場)[^。\n？?]{0,6}(?:安め|安い|高め|高い)[^。\n？?]{0,10}(?:どこ|どの辺|どのあたり|どの辺り)`,
].join("|"));
const RENT_HOW_MUCH_RE = /家賃(?:を|は)?いくら(?:まで|に|くらい|ぐらい)(?:に)?(?:したら|すれば|あげ|上げ|になり|なん)|平均(?:的に|的な)?(?:の)?(?:家賃|相場)|家賃(?:の)?平均/;
const RENT_TRADEOFF_RE = /(?:家賃|予算|[0-9０-９.．]+\s*万(?:円)?(?:台|代)?)[^。\n？?]{0,30}?(?:(?:古く|狭く)(?:なり)?(?:ます)?(?:か|よね)|(?:[1-4１-４]\s*(?:S?LDK|DK|K)|ワンルーム|1R)(?:に|と)?なりますよね|(?:って|は)どんな感じ(?:です)?か)/;
/** 1件の物件の家賃の確かめ・支払いの話（相場の問いではない） */
const RENT_SINGLE_PROP_RE = /(?:の物件|こちら|この物件|この部屋|このお部屋)(?:の)?家賃(?:は|って)?(?:いくら|[0-9])|家賃[0-9０-９,，]{4,}|日割|引き落|振込|振り込|支払|滞納|値下|お安く(?:出来|でき)|交渉|①|【/;

/** 2026-10-07 で足した形だけで当たるか（監査で新しく当たる通を見分ける） */
export function customerAsksRentLevelExtra(turn: string | null | undefined): boolean {
  const t = String(turn ?? "").normalize("NFKC");
  if (!t.trim() || /^\s*\[画像\]/.test(t)) return false;
  if (RENT_SINGLE_PROP_RE.test(t)) return false;
  // 初期費用・前家賃の問い（「初期費用10万位内は厳しいでしょうか」「前家賃等を別の項目で書き換えることは厳しいですか」）は家賃の相場ではない（家賃の語がある時だけ通す）
  if (/初期費用|前家賃/.test(t) && !/(?<!前)家賃/.test(t)) return false;
  // 気に入った1件の家賃を合わせたい相談（「惹かれる物件なんですが、共益費込で10万に納めたい…難しいでしょうか」）は交渉の話
  if (/(?:物件|お部屋)なんですが|(?:この|こちらの)(?:物件|お部屋|部屋)|惹かれる/.test(t)) return false;
  return RENT_HARD_ASK_RE.test(t) || RENT_COMPARE_RE.test(t) || RENT_HOW_MUCH_RE.test(t) || RENT_TRADEOFF_RE.test(t);
}

export function customerAsksRentLevel(turn: string | null | undefined): boolean {
  const t = String(turn ?? "").normalize("NFKC");
  if (!t.trim() || /^\s*\[画像\]/.test(t)) return false;
  if (customerAsksRentLevelExtra(t)) return true;
  if (!RENT_LEVEL_RE.test(t)) return false;
  if (NOT_RENT_RE.test(t) && !/相場/.test(t)) return false;
  if (!ASK_FORM_RE.test(t)) return false;
  return true;
}

/**
 * 相場の質問がお客様の登録と別の間取りを聞いている時、その間取り（2026-10-07 返信の質の1巡目）。
 *   「2LDKだともう少し上がりますか？」に登録の先頭の間取り（1LDK）の相場を渡していた＝材料が問いに答えておらず、下書きは問いを飛ばしてピックアップの宣言になった
 *   （YUMA で 2/2・関所は ok＝自動で送れる形）。問いの中で「〇〇だと／にすると／にしたら／の方が／は／って」の形で名指しした間取りだけを返す。
 *   名指しが無い・2つ以上ある時は null（登録の間取りのまま）
 */
export function askedFloorPlan(turn: string | null | undefined): string | null {
  const t = String(turn ?? "").normalize("NFKC").toUpperCase();
  const all = new Set([...t.matchAll(/[1-9]S?(?:LDK|DK|K)|ワンルーム|1R/g)].map((m) => m[0]));
  if (all.size !== 1) return null;
  const found = new Set<string>();
  for (const m of t.matchAll(/([1-9]S?(?:LDK|DK|K)|ワンルーム|1R)(?=\s*(?:だと|にすると|にしたら|になると|の方が|のほう|は|って|でも|で))/g)) found.add(m[1] === "1R" ? "ワンルーム" : m[1]);
  return found.size === 1 ? [...found][0] : null;
}

/**
 * 相場の質問の番で、2段（ピックアップの約束）の方針より先に「問いに答える」を置く（2026-10-07 返信の質の1巡目・穴:G5 ルールのぶつかり）。
 *   「2LDKだともう少し上がりますか？」はブレインが条件の言い直し→物件の AIX→2段（ピックアップの約束）にし、方針が約束だけになった。
 *   相場の材料は届いていても、下書きは問いを飛ばして約束だけを書いた（YUMA 2/2・うち1回は「上がる傾向」の一言だけ）。
 *   スタッフはまず相場の事実で答え、続けて探す宣言をする（「家賃10万円以内ですと…募集に出ておりませんでした！！2LDKの家賃相場は13万円からとなります！！」
 *   ／「家賃8万円ほどですと1Kのお部屋が中心となります！！…引き続きご希望に近いお部屋を探してお届けします！！」）。
 *   材料にお客様へ送れる文（sentences）がある時だけ。無い時は今まで通り（数字を作らない）
 */
export const RENT_ANSWER_FIRST_DIRECTION = "お客様は家賃の相場・予算で出るかを聞いている。最初に【💴 家賃の相場】のお客様に送ってよい文（数字も言い回しもそのまま・1〜2文）で問いに答え、その後に";
export const RENT_ANSWER_KEY_TOPIC = "家賃の相場の問いへの答え（💴 家賃の相場の文をそのまま）";
/** 方針と必須の話題を相場の答えを先にした形にする（材料の文が無い・相場の問いでない時はそのまま） */
export function rentAnswerFirst(direction: string | null, keyTopics: string[], turn: string | null | undefined, rm: { sentences: string[] } | null | undefined): { direction: string | null; keyTopics: string[]; applied: boolean } {
  if (!rm?.sentences?.length || !customerAsksRentLevel(turn)) return { direction, keyTopics, applied: false };
  const q = String(turn ?? "").normalize("NFKC").replace(/\s+/g, "").slice(0, 20);
  // 2段の「お客様の質問「…」への答え」は相場の答えと同じ物なので置き換える（同じ問いを2回数えない）
  const rest = keyTopics.filter((t) => !(t.startsWith("お客様の質問「") && q && t.replace(/\s+/g, "").includes(q.slice(0, 8))));
  // 2段の約束の方針の「物件名・家賃は書かない」は相場の答えとぶつかる（最後の確かめの Claude の回で、答えの数字が材料の文から崩れた）→ 家賃は相場の文の数字だけ
  const rest0 = (direction ?? "必要ならご条件でお部屋をピックアップしてお送りする事を一言添える").replace(/物件名・家賃は書かない/g, "物件名は書かない・家賃の数字は相場の文の物だけ");
  return { direction: `${RENT_ANSWER_FIRST_DIRECTION}${rest0}`, keyTopics: [RENT_ANSWER_KEY_TOPIC, ...rest].slice(0, 3), applied: true };
}

export type RentMarketForReply = { area: string | null; facts: string[]; sentences: string[]; budgetSentence?: string | null; ageTendency?: "old" | "new" | null };

// 2026-10-02 竹内さん「この場合要約したら築年数古めとなるってことをちゃんとお客さんに伝えるようにする」:
//   予算の中で築年数古めの時に添える次の一手は、スタッフの実際の送信の文だけ（手打ちの送信から・言い回しを作らない）
export const RENT_OLD_NEXT_STEP_STAFF_LINES = [
  "家賃帯やご希望のエリア広げていただけましたらご紹介可能なお部屋増える形となります！！",
  "希望エリアを広げること可能でしたら再度オススメ出来るお部屋ピックアップ可能です！！",
] as const;

/**
 * 返信の生成に渡す相場の材料（generate-reply の【📍 場面と返信方針】の中）。
 *   お客様に書いてよい数字は sentences（スタッフの実際の型・件数が足りる時だけ・⑯ area-rent-explain が作る）の文の物だけ。
 *   facts（区ごとの件数・築年や面積の中央値 等）は方向を決める材料で、数字をお客様に書かない
 *   （予算と築年・面積の関係を言うスタッフの実際の文の型が無い＝作らない。2026-10-02 実送信 697通で 0）。
 */
export function buildRentMarketNote(rm: RentMarketForReply | null | undefined): string {
  if (!rm || (!rm.sentences.length && !rm.facts.length && !rm.budgetSentence)) return "";
  const lines = ["- 💴 家賃の相場（物件検索のブレインの材料・弊社の検索で見つかったお部屋から。お客様が相場・予算で出るかを聞いている）:"];
  if (rm.budgetSentence) {
    // 予算の中の目安（築年は10年刻み・広さは5㎡刻み・古め／浅めの要約）は必ず伝える（竹内さん 10/02）
    lines.push(`  ・必ずこの文をそのまま入れる（予算の中の目安・数字も言い回しも変えない）: 「${rm.budgetSentence}」`);
    if (rm.ageTendency === "old") lines.push(`  ・築年数古めの時は、続けて次の一手をスタッフの実際の文から1つだけそのまま: ${RENT_OLD_NEXT_STEP_STAFF_LINES.map((x) => `「${x}」`).join(" ／ ")}`);
  }
  const others = rm.sentences.filter((x) => x !== rm.budgetSentence);
  if (others.length) lines.push(`  ・お客様に送ってよい相場の文（数字も言い回しもそのまま・1文まで）: ${others.map((x) => `「${x}」`).join(" ／ ")}`);
  if (rm.facts.length) lines.push(`  ・事実（返信の方向を決める材料。ここの数字はお客様に書かない）: ${rm.facts.join(" ／ ")}`);
  lines.push("  ・上の文に無い相場・家賃の幅・築年数・広さの数字は書かない（作らない）。相場の文が無い時は数字を出さず、ご条件を広げたピックアップの提案など方向だけを書く");
  return lines.join("\n");
}

/**
 * 2026-10-02 竹内さん「要約したら築年数古めとなるってことをちゃんとお客さんに伝える」の出口の確かめ。
 *   予算の中の目安の文は一字一句でなくてよい（Claude の下書きは「ペット可・家賃8.5万円以内の1DKですと、築年数は古めの…が目安となりますが、」と前後とつないだ＝中身は同じ）。
 *   要の語（古め／浅め・「築◯年程」・「◯〜◯㎡程」）が下書きに残っているかだけを見る。欠けていれば自動では送らない（本文は変えない）
 */
export function budgetSentenceKept(draft: string | null | undefined, budgetSentence: string | null | undefined): boolean {
  const b = String(budgetSentence ?? "");
  if (!b) return true;
  const d = String(draft ?? "").normalize("NFKC");
  const keys = [b.match(/築年数は(古め|浅め)/)?.[1], b.match(/築[0-9]+年(?:程|以内)/)?.[0], b.match(/[0-9]+(?:〜[0-9]+)?㎡程/)?.[0]].filter((x): x is string => !!x).map((x) => x.normalize("NFKC"));
  return keys.every((k) => d.includes(k));
}
