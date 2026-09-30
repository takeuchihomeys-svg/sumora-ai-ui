// app/lib/viewing-premature.ts
//
// 2026-09-30 竹内さん（みことさん事例・8a77820b）:
//   「これ内覧確定していないのに内覧のこと自動返信で入れてしまっている。内覧のことについて伝えるのは
//    内覧が確定（AIX の待ち合わせ場所）を行ったうえで行う形となる。場面によって今の文生成のところ変に先走らないようにする。
//    確定して行うって形（内覧時併せて話しするなど）」
//
// 【実物】10/2 13:00〜16:00 を打診しただけ（お客様は「3日はおやすみですよね💦」＝まだ決まっていない）の会話で、
//   お客様「夜職なのですがアリバイ会社使えますか？」への自動返信（予約送信 15:35 に送信済み）
//     「はい！！／お仕事面こちらでサポートさせて頂きます😊！！／ご内覧時に内覧担当から詳しく打ち合わせさせていただきますのでご安心ください😌！！」
//   お客様「初期費用分割は難しいですよね🥲」への自動返信（16:06 送信済み）
//     「…お支払いのタイミングや初期費用を抑える方法について、内覧時に内覧担当より詳しくご案内させて頂きます😌！！」
//
// 【出所（穴:G1 = 確定していない事を確定事実のように渡す／出口に関所が無い）】
//   ① ブレインの reply_direction「…10/2の内覧へ進め」・key_topics「10/2（金）13:00〜16:00の内覧日確定」・future_timeline「10/2（金）内覧希望」が
//      「brain方向性（参考）」「必ず含める内容」として生成に入り、往復文脈の「次工程宣言」と合わさって「ご内覧時に〜」になった。
//   ② 行動台帳は「内覧が決まっている（待ち合わせ案内済み）」時の行はあるが、「まだ決まっていない」時の行が無かった。
//   ③ 出口（実行前提語ゲート）に「内覧が決まっている前提の言い方」が無く、最終チェックも自動送信も素通りした。
//
// 【線（scripts/audit-viewing-premature.ts・実送信365日）】
//   内覧が決まっている＝行動台帳の viewingAppointment（AIX【待ち合わせ場所】か、こちらの本文での待ち合わせの案内。今日以降・内覧後のお礼の前）。
//   決まっている前提の言い方（下の3種類）は、この時だけ書いてよい。
//   ・過去の話（「内覧時にお伝えした」「ご内覧時に説明させていただいた」）は内覧が済んだ後の正しい文なので当てない
//   ・仮定（「よろしければ」「〜の場合は」「〜たら」）は決まった予定として書いていないので当てない
//   ・お客様が今回、決まった内覧を自分から言った時（「明日の内覧の時に〜」）は当てない（電話・来店で決めた内覧）
//
// 【出口の直し方】語だけを外す（文の中身＝質問への答えは残す）。挨拶・楽しみの文は、その節ごと外す。
//   出口は誤削除0でだけ入れる（CLAUDE.md の9手順）→ 監査の結果はすぐ下の VIEWING_PREMATURE_AUDIT。
//
// 【監査の結果 VIEWING_PREMATURE_AUDIT（2026-09-30・scripts/audit-viewing-premature.ts・読み取りのみ）】
//   こちらの実送信 365日 13,379通のうち語が当たる文 24通 → 内覧が決まっている（待ち合わせ・確定の宣言あり）で通す 13通（過半数＝線は「決まってから」でよい）。
//   決まっていないのに書いた 11通を1通ずつ読んだ:
//     ・5月の旧 AI の即時返信 4通（71697d1c・0133b787・d0d9662b・13a701a8。お客様の発言と同じ分に出た長い文）＝ AI の先走りそのもの → 直す
//     ・9/30 みことさんの自動返信 2通 ＝ 今回の実物 → 直す
//     ・スタッフの手書き 5通:
//         be60544e 8/28「お部屋ご内覧の際に簡単にお打ち合わせさせて頂ければと思います」
//         ed7695c5 9/1 「今後の状況についてもご内覧の際等にお聞かせ頂きますと幸いです」
//         3e1f5162 9/20「お打ち合わせをご内覧の際または、お手隙の際にお電話でお伝えさせて頂きます」
//           → 3通とも お願い・希望の形／選択肢の片方で、決まった予定として言い切っていない。最初の版はこれも外していた（誤削除3）
//             → **出口では触らない**（SOFT_AFTER_RE・ALTERNATIVE_RE）。入口（台帳の注記）では「内覧の時に話すと先送りしない」を渡したまま
//         7df53628 5/31「ご内覧当日もどうぞよろしくお願いいたします」（日は未定・お客様が後日連絡すると言った直後）
//         8a77820b 9/30 15:37「ご内覧時に内覧担当より詳しくお話しさせていただきますので」（竹内さんが指摘した会話・言い切り）
//           → この2通は竹内さんの 9/30 の指示が禁じている形そのもの（言い切り・内覧へのよろしく）。誤削除に数えず、直す側に残す
//   結果: 直す 8通（AI 6・スタッフの言い切り 2）／触らない 16通。スタッフの手書きのお願い・希望の形への誤削除 0。
//   AI の下書き 60日 2,087件: 語が当たる 4件はすべて内覧が決まった後＝直す 0件。
//   他の先回り（再度・改めて・お送りした・申込を受け取った）直近30日の実送信: その時点の台帳に実績なしは 0件（既存の関所で足りている）。
//   ※ スタッフが編集・手入力した文は送信時に検査しない（feedback_staff_edit_no_check）。この関所が動くのは AI が文を作る時だけ。

/** 内覧を表す語（「ご案内」単独は手続きの案内もあるので入れない） */
const VIEW = "(?:ご内覧|内覧|ご内見|内見|ご見学|見学)";
const DAY = "(?:本日|明日|明後日|当日|[0-9０-９]{1,2}[/／月][0-9０-９]{1,2}日?|[0-9０-９]{1,2}日|[月火水木金土日]曜日?)";
const NX = "[^\\n。！!？?]";

/**
 * ① 内覧の時に〜（先送り・予告）: 「ご内覧時に内覧担当から」「内覧の際に」「10/2のご内覧時に」「ご内覧当日に」
 *   語の部分（日付＋内覧＋時＋担当より）だけを外すための正規表現
 */
//   監査で直した: 助詞を必須にする（「内覧時期」「内覧時間」「内覧当日の集合場所」を当てない）・「ご内覧の際等に」の「等」・
//   「ご内覧の際または、お手隙の際にお電話で」（または、ごと外す）・「本日オンライン内見の際に」（オンライン・現地も語に含める）
const AT_VIEWING_RE = new RegExp(
  `(?:${DAY}(?:の)?)?(?:お部屋)?(?:オンライン|現地)?${VIEW}(?:時|の際|当日)(?:等|など)?(?:(?:には|にて|に|は)[、,]?|(?:または|もしくは)?[、,])(?:(?:内覧)?担当(?:者|スタッフ)?(?:より|から)[、,]?)?`,
);
/** ② 内覧への挨拶: 「10/2日のご内覧もよろしくお願いします」「本日ご内覧よろしくお願い致します」 */
const VIEWING_GREETING_RE = new RegExp(`${VIEW}(?:も|の程|のほど|の方|当日)?${NX}{0,4}(?:何卒|どうぞ)?(?:よろしく|宜しく)お願い`);
/** ③ 楽しみ・お待ち: 「当日お会い出来るのを楽しみにしております」「ご内覧お待ちしております」 */
const LOOKING_FORWARD_RE = new RegExp(`(?:${VIEW}|お会い(?:でき|出来))${NX}{0,8}(?:楽しみに(?:して|しており)|お待ちして(?:おり|い))`);

/** 語の直後が過去（「お伝えした」「説明させていただいた」「お伺いした」）＝内覧が済んだ後の話 */
const PAST_AFTER_RE = new RegExp(`^${NX}{0,25}?(?:した|いた|った)(?!だ)`);
/** 語の前が仮定（「よろしければ」「写真が無い場合は」「お気に召されましたら」） */
const CONDITIONAL_BEFORE_RE = /(?:場合|ければ|れば|たら|なら|際は|でしたら)/;
/**
 * 語の後ろがお願い・希望の形（「〜させて頂ければと思います」「お聞かせ頂きますと幸いです」）、または語が選択肢の片方（「ご内覧の際または、お手隙の際にお電話で」）。
 *   決まった予定として言い切っていない。監査（VIEWING_PREMATURE_AUDIT）でスタッフの手書きの実送信3通がこの形だったので、出口では触らない
 */
const SOFT_AFTER_RE = /(?:頂|いただ)(?:ければ|けますと|きますと|けると)|幸いです/;
const ALTERNATIVE_RE = /または|もしくは/;
/**
 * 2026-09-30 見直し: 挨拶・お待ちの語の中に「希望・日程・日時・候補・予約・連絡・都合」がある時は、内覧そのものへの挨拶ではなく
 *   日程のお返事を待つ文（内覧調整中の正しい返事）なので当てない。実送信365日にこの形は無い（念のための線・外す側にだけ狭める）
 */
const SCHEDULE_REQUEST_RE = /希望|日程|日時|日にち|候補|予約|連絡|都合|調整/;
/** お客様が今回、決まった内覧を自分から言った（「明日の内覧の時に」「10/2の内見って何時からでしたっけ」）。可否・空きを聞く形は除く */
const CUSTOMER_FIXED_VIEWING_RE = new RegExp(`(?:${DAY}|今日)の?${VIEW}(?!${NX}{0,10}(?:可能|できますか|出来ますか|空いて|どうですか|大丈夫ですか))`);

export type PrematureViewingKind = "at_viewing" | "viewing_greeting" | "looking_forward";
export interface PrematureViewingHit {
  kind: PrematureViewingKind;
  /** 当たった文（。！!？?改行で区切った1文） */
  sentence: string;
  evidence: string;
  /** 直した文（"" は文ごと外す） */
  fixed: string;
}

function splitSentences(text: string): string[] {
  // 「！！」「？！」は1つの区切りとして後ろに付ける（1文字ずつ切ると「！」だけの文が残る）
  return ((text ?? "").match(/[^。！!？?\n]*(?:[。！!？?]+|\n|$)/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** 節（読点の後ろ）ごと外す。前に中身が無ければ文ごと外す（""） */
function cutClause(sentence: string, idx: number): string {
  const head = sentence.slice(0, idx);
  const cut = Math.max(head.lastIndexOf("、"), head.lastIndexOf(","));
  if (cut < 0) return "";
  const kept = head.slice(0, cut).trim();
  if (!/[぀-ヿ一-鿿A-Za-z0-9]{4,}/.test(kept)) return "";
  const tail = (sentence.match(/[😊😌🙇‍♀️✨]*[！!。]*$/u)?.[0] ?? "") || "！！";
  return `${kept}${tail}`;
}

/** 語を外した後の文を整える（先頭の読点・二重の読点・「について、」の後ろの空白） */
function tidy(s: string): string {
  return s.replace(/^[、,\s]+/, "").replace(/[、,]{2,}/g, "、").replace(/\s{2,}/g, " ").trim();
}

/** 外した後に文の中身が残るか（絵文字・！・読点だけなら残らない） */
function hasBody(s: string): boolean {
  return /[぀-ヿ一-鿿A-Za-z0-9]{3,}/.test(s.replace(/[\p{Extended_Pictographic}‍️]/gu, ""));
}

/**
 * 内覧が決まっている前提の言い方を探す（純関数）。内覧が決まっているかは呼び出し側（台帳）で見る。
 *   - 過去の話・仮定の文は当てない
 *   - 1文につき最初の1つだけ
 */
export function findPrematureViewing(text: string): PrematureViewingHit[] {
  const out: PrematureViewingHit[] = [];
  for (const s of splitSentences(text)) {
    const at = s.match(AT_VIEWING_RE);
    if (at && at.index != null) {
      const after = s.slice(at.index + at[0].length);
      const before = s.slice(0, at.index);
      if (!PAST_AFTER_RE.test(after) && !CONDITIONAL_BEFORE_RE.test(before) && !SOFT_AFTER_RE.test(after) && !ALTERNATIVE_RE.test(at[0])) {
        const removed = tidy(`${before}${after}`);
        out.push({ kind: "at_viewing", sentence: s, evidence: at[0], fixed: hasBody(removed) ? removed : "" });
        continue;
      }
    }
    for (const [kind, re] of [["viewing_greeting", VIEWING_GREETING_RE], ["looking_forward", LOOKING_FORWARD_RE]] as const) {
      const m = s.match(re);
      if (!m || m.index == null) continue;
      if (CONDITIONAL_BEFORE_RE.test(s.slice(0, m.index))) continue;
      if (SCHEDULE_REQUEST_RE.test(m[0])) continue;
      // 日付の語から節を切る（「ご安心くださいませ、10/2日のご内覧もよろしく」→ 前半だけ残す）
      const dayM = s.slice(0, m.index).match(new RegExp(`${DAY}${NX}{0,6}$`));
      const start = dayM && dayM.index != null ? dayM.index : m.index;
      out.push({ kind, sentence: s, evidence: m[0], fixed: cutClause(s, start) });
      break;
    }
  }
  return out;
}

/** お客様が今回、決まった内覧を自分から言ったか（電話・来店で決めた内覧。台帳に待ち合わせが無くても決まっている） */
export function customerMentionsFixedViewing(customerText: string | null | undefined): boolean {
  return CUSTOMER_FIXED_VIEWING_RE.test((customerText ?? "").normalize("NFKC"));
}

/**
 * 直す（純関数）。決まっている時（confirmed）・お客様が決まった内覧を言った時は何もしない。
 * 戻り値の applied はログ用（「種類:語→直した文の頭」）
 */
export function stripPrematureViewing(text: string, opts: { confirmed: boolean; customerText?: string | null }): { text: string; applied: string[] } {
  if (opts.confirmed || !text || customerMentionsFixedViewing(opts.customerText)) return { text, applied: [] };
  let cur = text;
  const applied: string[] = [];
  for (const h of findPrematureViewing(text)) {
    if (!cur.includes(h.sentence)) continue;
    cur = cur.replace(h.sentence, h.fixed);
    applied.push(`${h.kind}:「${h.evidence}」→「${h.fixed.slice(0, 40) || "（文ごと削除）"}」`);
  }
  if (!applied.length) return { text, applied };
  return { text: cur.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), applied };
}

/**
 * 入口: ブレインの方向・話題に内覧の日時・確定の語がある時、生成に渡す前に「まだ決まっていない」を添える。
 *   ブレインの判断（内覧を確定へ進める）は正しいので消さない。生成がそれを「決まった予定」と読まないようにだけする。
 */
const BRAIN_VIEWING_PUSH_RE = new RegExp(`${VIEW}|ご案内`);
export const UNCONFIRMED_VIEWING_SUFFIX = "（※内覧はまだ決まっていない＝待ち合わせ場所は未案内。この返信では内覧を決まった予定として書かない）";
export function annotateUnconfirmedViewing(text: string | null | undefined, confirmed: boolean): string | null {
  if (text == null) return null;
  if (confirmed || !BRAIN_VIEWING_PUSH_RE.test(text) || text.includes(UNCONFIRMED_VIEWING_SUFFIX)) return text;
  return `${text}${UNCONFIRMED_VIEWING_SUFFIX}`;
}

/**
 * こちら（スタッフ）の本文での内覧の確定の宣言（待ち合わせの語が無い形）。
 *   実物: 「かしこまりました！！／明日 9/7 16:00〜よりオンライン内見させて頂きます！！」（d3a56a97・オンライン内覧＝待ち合わせ場所が無い）
 *        「かしこまりました！！／7月2日（木）14:30よりプレサンス心斎橋レヨン 601号室ご案内させていただきます😊！！」（595b1cd4・お客様が日時を決めた返事）
 *   監査（scripts/audit-viewing-premature.ts）で、台帳の待ち合わせだけを確定の印にすると、この2通の後のこちらの実送信
 *   「本日オンライン内見の際に審査通過に関しましても…」「本日ご内覧よろしくお願い致します！！」を落としてしまった（誤削除2）。
 *   打診（ご都合・いかが・でしょうか・可能です）・仮定は含めない（その行だけで見る）。日付は必須。戻り値は日付（M/D）
 */
//   「23日の17:00でのご内見、確定させていただきますね」（13a701a8）の確定・お手配も宣言に数える（日だけの日付は案内した日から月を決める）
const DECL_DATE_RE = /(本日|今日|明日|明後日|([0-9]{1,2})\s*[\/月]\s*([0-9]{1,2})日?|(?<![0-9\/月])([0-9]{1,2})日(?!間))/;
//   「かしこまりました！！／6/16日お部屋ご案内させていただきます😊！！／6/16日16:00にビエラ江戸堀現地エントランス前待ち合わせいかがでしょうか😌！！」（60d5b1e9）も
//   日付の確定（待ち合わせの場所だけを聞いている）。打診の語は**その行だけ**で見る
const DECL_RE = /(?:本日|今日|明日|明後日|[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}日?|(?<![0-9\/月])[0-9]{1,2}日(?!間))[^\n。！!？?]{0,50}?(?:(?:ご案内|ご内覧|内覧|ご内見|内見)(?:を)?させて(?:頂|いただ)きます|(?:ご内覧|内覧|ご内見|内見)[^\n。！!？?]{0,12}(?:確定|お手配)させて(?:頂|いただ)きます)/;
const DECL_NOT_RE = /ご都合|いかが|如何|でしょうか|可能|ございますか|難しい|もし|でしたら|れば|たら/;
export function findStaffViewingDeclaration(text: string | null | undefined, sentAtMs: number): string | null {
  const t = (text ?? "").normalize("NFKC");
  const line = t.split("\n").find((l) => DECL_RE.test(l) && !DECL_NOT_RE.test(l));
  const m = line?.match(DECL_RE);
  if (!m) return null;
  const d = m[0].match(DECL_DATE_RE);
  if (!d || !Number.isFinite(sentAtMs)) return null;
  if (d[2]) return `${Number(d[2])}/${Number(d[3])}`;
  if (d[4]) {
    // 日だけ: 案内した日（JST）より前の日なら翌月
    const p = new Date(sentAtMs + 9 * 3600_000);
    const day = Number(d[4]); const m0 = p.getUTCMonth() + 1;
    if (day < 1 || day > 31) return null;
    return `${day >= p.getUTCDate() ? m0 : m0 === 12 ? 1 : m0 + 1}/${day}`;
  }
  const add = /明後日/.test(d[1]) ? 2 : /明日/.test(d[1]) ? 1 : 0;
  const p = new Date(sentAtMs + 9 * 3600_000 + add * 86_400_000);
  return `${p.getUTCMonth() + 1}/${p.getUTCDate()}`;
}

/** ブレインの話題（key_topics）が「内覧の日時・確定」か（「10/2（金）13:00〜16:00の内覧日確定」「内覧日程の確定」）。未確定の時は生成の必須から外す */
const VIEWING_FIX_TOPIC_RE = new RegExp(`${VIEW}[^\\n]{0,12}(?:確定|決定|日程|日時)|(?:[0-9０-９]{1,2}[/／月][0-9０-９]{1,2}|[0-9０-９]{1,2}日)[^\\n]{0,20}${VIEW}`);
export function isViewingFixTopic(topic: string | null | undefined): boolean {
  return VIEWING_FIX_TOPIC_RE.test(topic ?? "");
}

/** 台帳の注記の1行（内覧の話は出ているが、まだ決まっていない時）。本文を引用しない＝種類の名前だけ（設計知見「本文を引用して渡すと写す」） */
export const UNCONFIRMED_VIEWING_LEDGER_LINE =
  "→ 内覧は**まだ決まっていない**（候補日のやり取り中・待ち合わせ場所は未案内）。内覧を決まった予定として書かない（内覧の日時を言い切る／内覧の時に話す・説明すると先送りする／内覧へのよろしく・楽しみにしている）。内覧が決まるのは AIX【待ち合わせ場所】を送った時。お客様の質問には今わかる事で答える。";
