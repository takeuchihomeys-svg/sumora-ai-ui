// app/lib/viewing-flow.ts
// ─────────────────────────────────────────────────────────────────────────────
// 内覧の流れの「今の段階」を実際の出来事から1か所で決める純関数（DB・LLM 依存なし）
//
// 2026-09-30 竹内さん:
//   「AIX の内覧調整で内覧の日にち調整して、日にち決まったら、AIX 待ち合わせで内覧が確定されるまでの流れはしっかり理解できているか。
//    まず内覧調整から候補日入れて内覧日設定して、内覧日決めてから、待ち合わせ場所決める流れ。
//    実際の LINE や成約データから流れをちゃんとできるように、先走らないようにする形で改善する。ブレインもちゃんと機能して判断できるように」
//
// 【穴（G1）】「日にちが決まった（待ち合わせ前）」という状態がどこにも独立して無かった:
//   ・customer-state は受諾を「内覧予定」に入れ（待ち合わせ済みと同じ表示）、台帳・出口は「未確定」に入れた（同じ瞬間に帯と文が食い違う）
//   ・受諾は今回の発言でしか読めず（done-state の customer_accepted）、次のターンで消えた
//   ・ブレインに渡す台帳は「内覧打診を実行」止まりで、候補日・返事待ち・未確定が無かった
//   ・「内覧打診」は会話全体の累積（何週間前の打診でも「候補日のやり取り中」）、viewing-thread は48時間の窓＝線が2つあった
//
// 【段階（実データ 180日・scripts/audit-viewing-flow.ts / audit-viewing-stage.ts）】
//   none        内覧の話なし（または打診が古い・お客様が取りやめた）
//   wished      お客様が内覧を希望・こちらは候補日をまだ出していない            → AIX【内覧調整】
//   proposing   候補日を出した・まだ決まっていない（返事待ち／日だけ返った／聞き返し／保留）
//                 日だけ返った・別日を聞かれた → AIX【内覧調整】をもう1回（その日の時間帯）
//                 別の質問が来た → 質問にだけ答える（段階は進めない。実送信 17通中11通は内覧に触れず）
//   date_agreed 日にち（＋開始時刻）がそろった・待ち合わせ場所は未送信＝**まだ確定ではない** → AIX【待ち合わせ場所】
//                 （日時を決めて返した25回のうち21回は次の一手がそのまま待ち合わせ）
//   confirmed   AIX【待ち合わせ場所】を送った／こちらの確定の宣言（オンライン内覧 等）＝内覧確定。ここから「内覧の時に〜」「当日よろしく」が解禁
//   done        内覧後のお礼を送った／決まっていた内覧日が過ぎた
//
// 【確定の線は1つ】confirmed（boolean）＝台帳の viewingAppointment か viewingDeclared（今日以降・内覧後のお礼の前）。
//   出口の関所 viewing_presumed（action-ledger）・入口の注記（generate-reply）・台帳の注記がこの値を見る。
//   ※ stage は「流れのどこか」、confirmed は「決まった内覧が1つでもあるか」。待ち合わせの後に別のお部屋の内覧調整をした時は
//     stage=proposing・confirmed=true になる（決まった内覧の話は書いてよい・新しい候補日は決まった予定として書かない）
// ─────────────────────────────────────────────────────────────────────────────
import { parseCandidateSlots } from "./viewing-hold";
import { jstParts } from "./jst-date";
import { findStaffViewingDeclaration } from "./viewing-premature";
import { CUSTOMER_VIEWING_WISH_RE, STAFF_VIEWING_DONE_RE, STAFF_VIEWING_PROPOSAL_RE, MEDIA_RE } from "./viewing-thread";

export type ViewingFlowStage = "none" | "wished" | "proposing" | "date_agreed" | "confirmed" | "done";
/** 候補日を出した後（または内覧の希望と一緒）のお客様の日にちの返事の形 */
export type CustomerDateReply =
  | "date_time"   // 日＋開始時刻がそろった（「では14日の16:00でお願いしたいです」「明日の13時でも行けますか？」）
  | "day_pick"    // こちらの候補の日を選んだ・日だけで依頼した（「23日の指定時間行けます」「9/8お願いします」）
  | "ack"         // 日時の語の無い短い了承（候補が1日だけの時だけ決まる）
  | "day_only"    // 日だけを聞いた・提案した（「2日はどうですか？」「土日は可能ですか」）
  | "ask_back"    // 否定の確かめ・都合が合わない（「3日はおやすみですよね」「16時以降は少しきびしいですよね」）
  | "hold"        // 保留（「日程調整してまた連絡させて頂きます」）
  | "cancel"      // 取りやめ
  | "none";       // 日にちの返事ではない（別の質問・お礼 等）＝段階を進めない

export type FlowMsg = { sender: string; text?: string | null; createdAt?: string | null };
export interface ViewingFlowInput {
  /** 古い順 */
  messages: readonly FlowMsg[];
  /** AIX【内覧調整】を送った時刻（aix_usage_logs / sent_facts） */
  inviteAts?: ReadonlyArray<string | null | undefined>;
  /** 待ち合わせの案内（AIX【待ち合わせ場所】・本文の待ち合わせ）の時刻と日時 */
  meetings?: ReadonlyArray<{ at: string | null | undefined; dateMD?: string | null; time?: string | null }>;
  /** 台帳の決まった内覧（今日以降・内覧後のお礼の前）。確定の線はこの2つ */
  appointment?: { dateMD: string | null; time: string | null } | null;
  declared?: { dateMD: string; at: string } | null;
  /** 台帳の「内覧は済んだ」 */
  done?: { thankedAt: string } | null;
  nowMs?: number;
}
export interface ViewingFlow {
  stage: ViewingFlowStage;
  /** 内覧が決まっている（待ち合わせ場所を送った／確定の宣言）。出口の関所・入口の注記と同じ線 */
  confirmed: boolean;
  /** 合意した（date_agreed）・確定した（confirmed）日時「10/2 13:00」。時刻が未定なら日だけ */
  label: string | null;
  /** date_agreed の時、開始時刻まで決まっているか */
  timeFixed: boolean;
  /** 最後にこちらが出した候補（「10/2(金) 13:00〜16:00」） */
  slots: string[];
  proposedAt: string | null;
  /** 候補を出した後のお客様の最後の日にちの返事（none は入れない） */
  lastReply: CustomerDateReply | null;
  /** 今回のお客様の連投（履歴の最後がお客様の時）の日にちの返事。none＝日にちの返事ではない（別の話） */
  currentReply: CustomerDateReply | null;
  /** お客様が日だけ言った・聞いた日（「10/3」）。こちらはまだその日の時間帯を返していない */
  askedDay: string | null;
  /** こちらが「待ち合わせ場所は追ってご連絡」と言った（date_agreed の後のやる事） */
  placePromised: boolean;
  /** 待ち合わせを「いかがでしょうか」で送った（場所つきの打診・お客様の返事待ち） */
  meetingOffered: boolean;
  /** 今回のお客様の連投に内覧の希望がある（候補日は未提示） */
  currentWish: boolean;
  reason: string;
}

const DAY = 86_400_000;
/** 候補を出した／希望を言った後、内覧の話が何も動かなければ「流れは続いていない」とする日数（打診→待ち合わせは 75% が 26時間以内・最長でも数日） */
export const VIEWING_FLOW_STALE_DAYS = 7;
const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC");
const ms = (iso: string | null | undefined): number => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : NaN; };

// ── お客様の日にちの返事 ──
const MD_RE = /([0-9]{1,2})\s*[\/月]\s*([0-9]{1,2})/;
const D_ONLY_RE = /(?<![0-9\/月:.])([0-9]{1,2})\s*日(?!間|程|中|以内)/;
const D_BARE_NO_RE = /(?<![0-9\/月:.])([0-9]{1,2})の(?=\s*[0-9]{1,2}\s*(?:時|:))/; // 「18の16時から」
const REL_DAY_RE = /明後日|あさって|明日|あした|本日|今日/;
const WEEKDAY_RE = /([月火水木金土日])曜/;
const VAGUE_DAY_RE = /土日|平日|週末|来週|今週|再来週|[0-9]{1,2}(?:日|時)以降|午前|午後|夕方|(?:夜|朝|昼)(?:なら|は|だと|が|に|頃|ごろ|以降|から)/;
/** 別の日・空きを聞く（「それ以外だと何日になりますか？」「内見いける時間ありますか？」「内覧いついけますか？」） */
const ALT_DAY_Q_RE = /それ以外|(?:他|ほか|別)の(?:日|お日にち|日程|時間)|別日|何日|いつ(?:なら|が|頃|ごろ|から|いけ|行け)|何時(?:から|頃|ごろ|なら|辺り)|(?:内覧|内見|見学)[^\n]{0,12}(?:いつ|時間|日程|空い|可能|むり|無理|行け|いけ)[^\n]{0,10}(?:[?？]|ですか|ますか|でしょうか)/;
/** 内覧したいの形（候補日のやり取り中・内覧の後は「内覧」の語だけでは希望にしない） */
const WISH_FORM_RE = /(?:内覧|内見|見学)[^\n]{0,8}(?:したい|行きたい|いきたい|お願い|希望|させて)|見(?:に|て)(?:い|行)(?:きたい|けますか)|み(?:に|て)(?:い|行)(?:きたい|けますか)|見てみたい|^いきたいです/m;
const WISH_NEGATE_RE = /まだ|考えてない|考えていません|後で|いったん|一旦|しません|大丈夫なので|先日|この前|(?:内覧|内見|見学)した(?!い)|(?:内覧|内見)(?:の時|時に|の際|後)|今日の(?:内覧|内見)/;
/** お客様の内覧の希望（viewing-thread と同じ語＋ひらがなの形。過去の内覧の話・取りやめは除く） */
export function customerWishes(text: string): boolean {
  return nfkc(text).split(/\n|(?<=[。！!？?])/).some((x) => (CUSTOMER_VIEWING_WISH_RE.test(x) || WISH_FORM_RE.test(x)) && !WISH_NEGATE_RE.test(x) && !CANCEL_RE.test(x));
}
/** 申込の書式・物件情報の貼り付け（生年月日・入居希望日の日付を内覧の日にちと読まない） */
const FORM_TEXT_RE = /記入欄|生年月日|フォーマット|【賃貸|築[0-9]+年|管理費/;
/** 開始時刻（「16:00」「16時」「12.00〜」「10時30」）。「18時以降」「2時間」は時刻の指定ではない */
//   2026-09-30 見直し（監査 d3f7f5f3「平日18時半以降か今週土曜日なら16時以降です。」が 18:30 の指定に読まれ date_agreed になっていた）: 「半・分」を挟んだ「以降・まで」も外す
const TIME_RE = /(?<![0-9])([0-9]{1,2})\s*(?::|\.)\s*([0-9]{2})(?!\s*[\/月日])(?!\s*(?:以降|まで))|(?<![0-9])([0-9]{1,2})\s*時(?!間|(?:半|\s*[0-9]{1,2}分?)?\s*(?:以降|まで)|頃まで)(半|\s*[0-9]{1,2}分?)?/;
/** 「27日以降」「9/27以降」「月曜日以降」＝その日に決めたのではなく範囲（監査 9b9b81ba「27日以降で18時頃って可能でしょうか？」が 9/27 18:00 の指定に読まれていた。スタッフは 28・29日の候補を返した） */
const RANGE_DAY_RE = /(?:(?<![:.0-9時])[0-9]{1,2}\s*日?|曜日?)\s*以降/;
/** 候補の日の語はあるが、その日を選んでいない（監査: ad97cd40「今日はありがとうございました！」・60e6d3ab「今日の内見の部屋の件なんですが」＝内覧の後・当日の話） */
const DAY_MENTION_NOT_PICK_RE = /ありがとう|(?:今日|本日|明日|[0-9]{1,2}日)の(?:ご)?(?:内覧|内見|見学)/;
/** 候補の日を打ち消した（監査 c7ca2f04「今日ではなくていいのですが」） */
const DAY_NEGATED_RE = /(?:では|じゃ|で)な(?:く|い)/;
const ACCEPT_RE = /お願い|おねがい|大丈夫|行けます|いけます|伺い|向かい|可能です|希望|がいい|が良い|にします|空いてます|空いています/;
const QUESTION_RE = /[?？]|ですか|ますか|でしょうか|かな[ぁ〜]?(?:$|\n)/;
const NEG_RE = /ですよね|ますよね|難し|厳し|きびし|無理|おやすみ|お休み|休み|行けな|いけな|合わな|空いてな|予定(?:が)?(?:あ|入|詰ま)|埋ま|仕事(?:で|な|が)/;
const HOLD_RE = /また(?:ご)?連絡|改めて(?:ご)?連絡|(?:わか|分か)り次第|確認して(?:み|から|また)|確認します|シフト|まだ(?:わから|分から|決ま|未定)|未定|調整して|考え(?:ます|させて)|検討/;
const CANCEL_RE = /キャンセル|中止|(?:内覧|内見|見学)[^\n]{0,8}(?:やめ|辞め|見送)|行けなく|延期|また今度|(?:内覧|内見)は(?:大丈夫|結構|不要)/;
/** 内覧ではない日にち（入居・契約・引越・支払・退去・審査の日） */
const NON_VIEWING_DATE_RE = /入居|契約|引っ?越|退去|振込|支払|入金|審査|初期費用|家賃|更新|給料|勤務/;
const SHORT_ACK_RE = /^(?:はい[、。！!\s]*)?(?:大丈夫です|お願いします|お願い致します|お願いいたします|よろしくお願い(?:します|致します|いたします)|了解です|了解しました|わかりました|分かりました|承知(?:しました|です)|かしこまりました|それでお願いします|可能です|行けます|いけます|OK(?:です)?|おっけーです)[^\n]{0,8}$/i;

function mdOfOffset(baseMs: number, addDays: number): string { const p = jstParts(baseMs + addDays * DAY); return `${p.m}/${p.d}`; }
/** お客様の発言から日（M/D）を読む。曜日は発言の日より後で一番近いその曜日 */
export function parseCustomerDay(text: string, atMs: number): string | null {
  const t = nfkc(text);
  const md = t.match(MD_RE);
  if (md) { const m = Number(md[1]), d = Number(md[2]); if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${m}/${d}`; }
  const base = Number.isFinite(atMs) ? atMs : Date.now();
  const rel = t.match(REL_DAY_RE)?.[0];
  if (rel) return mdOfOffset(base, /明後日|あさって/.test(rel) ? 2 : /明日|あした/.test(rel) ? 1 : 0);
  const dOnly = t.match(D_ONLY_RE) ?? t.match(D_BARE_NO_RE);
  if (dOnly) {
    const d = Number(dOnly[1]); const p = jstParts(base);
    if (d >= 1 && d <= 31) return `${d >= p.d ? p.m : p.m === 12 ? 1 : p.m + 1}/${d}`;
  }
  const wd = t.match(WEEKDAY_RE)?.[1];
  if (wd) {
    const want = "日月火水木金土".indexOf(wd); const p = jstParts(base);
    let add = ((want - p.dow + 7) % 7) || 7;
    // 「来週の土曜日」: 次の月曜から始まる週のその曜日（7/13(月) の「来週の土曜」は 7/25）
    if (/来週/.test(t)) { const toNextMon = ((1 - p.dow + 7) % 7) || 7; add = toNextMon + ((want + 6) % 7); }
    return mdOfOffset(base, add);
  }
  return null;
}
export function parseCustomerTime(text: string): string | null {
  const m = nfkc(text).match(TIME_RE);
  if (!m) return null;
  const h = Number(m[1] ?? m[3]);
  if (!(h >= 7 && h <= 22)) return null;
  const min = m[2] ?? (m[4] ? (/半/.test(m[4]) ? "30" : String(Number(m[4].replace(/[^0-9]/g, "")) || 0).padStart(2, "0")) : "00");
  return `${h}:${min}`;
}

export type DateReplyCtx = {
  atMs: number;
  /** こちらが出している候補の日（M/D）。1つだけなら「大丈夫です」で決まる */
  offeredDays: readonly string[];
  /** 候補の日ごとの開始時刻（「10/2」→「13:00」） */
  offeredStart?: Readonly<Record<string, string>>;
  /** 前の往復でお客様が言った日（時刻だけ返った時に使う） */
  knownDay?: string | null;
  /** 候補日のやり取り中（候補を出した後・お客様が内覧を希望した後）。日の無い開始時刻の依頼を日にちの返事として読む */
  inFlow?: boolean;
};
export type DateReplyVerdict = { kind: CustomerDateReply; day: string | null; time: string | null };

/** 候補日を出した後のお客様の1通を読む（純関数）。日にちの返事でなければ none＝段階を進めない */
export function classifyCustomerDateReply(text: string | null | undefined, ctx: DateReplyCtx): DateReplyVerdict {
  const t = nfkc(text).replace(/\[スタンプ\]/g, "").trim();
  const no: DateReplyVerdict = { kind: "none", day: null, time: null };
  if (!t || MEDIA_RE.test(t)) return no;
  if (CANCEL_RE.test(t)) return { kind: "cancel", day: null, time: null };
  if (FORM_TEXT_RE.test(t) || (/https?:\/\//.test(t) && t.length > 200)) return no;
  // 日にちの語を含む行だけで見る（「入居は11月でお願いします」「初期費用の支払いは25日で」は内覧の日にちではない）
  const lines = t.split(/\n|(?<=[。！!？?])/).map((x) => x.trim()).filter(Boolean);
  const dateLines = lines.filter((l) => !/https?:\/\//.test(l) && (!NON_VIEWING_DATE_RE.test(l) || /内覧|内見|見学/.test(l)));
  const scope = dateLines.join("\n");
  // 「27日以降」「月曜日以降」は日を決めていない（範囲）→ 日・開始時刻の指定に読まない
  const rangeDay = RANGE_DAY_RE.test(scope);
  const day = rangeDay ? null : parseCustomerDay(scope, ctx.atMs);
  const time = rangeDay ? null : parseCustomerTime(scope);
  const vague = VAGUE_DAY_RE.test(scope);
  const neg = NEG_RE.test(scope);
  const hold = HOLD_RE.test(scope);
  const accept = ACCEPT_RE.test(scope);
  const singleDay = ctx.offeredDays.length === 1 ? ctx.offeredDays[0] : null;
  if (time && !neg && !hold) {
    const d = day ?? ctx.knownDay ?? singleDay;
    // 「もしくは」で2つの日を並べた時は決まっていない（「10/2の午前中も空きございますか？もしくは10/4の13時半で」）
    const twoOptions = /もしくは|または|あるいは/.test(scope);
    if (d && twoOptions) return { kind: "day_only", day: d, time: null };
    if (d) return { kind: "date_time", day: d, time };
    // 日は言っていないが、候補を出した後に開始時刻で頼んだ（「14時からでおねがいしてもいいですか？」「15:15ぐらいからでしたら大丈夫」）
    if (ctx.inFlow && accept) return { kind: "date_time", day: null, time };
  }
  if (hold) return { kind: "hold", day, time: null };
  if (rangeDay && !NON_VIEWING_DATE_RE.test(scope)) return { kind: neg ? "ask_back" : "day_only", day: null, time: null };
  if (day && neg) return { kind: "ask_back", day, time: null };
  if (day) {
    // 2026-09-30 見直し（監査で date_agreed に誤って進んだ実物）: 候補の日の語があっても、その行がお礼・当日の内覧の話だけ（依頼の語なし）なら
    //   日にちの返事ではない／その日を打ち消していれば聞き返し。「決まっていないのに日にち決定にしない」側にだけ狭める
    const dayLine = dateLines.find((l) => parseCustomerDay(l, ctx.atMs) === day) ?? scope;
    if (DAY_NEGATED_RE.test(dayLine)) return { kind: "ask_back", day, time: null };
    if (DAY_MENTION_NOT_PICK_RE.test(dayLine) && !ACCEPT_RE.test(dayLine) && !QUESTION_RE.test(dayLine)) return no;
    // こちらの候補にある日を選んだ（「23日の指定時間行けます」「28日はいけますか？」）＝その日の枠で決まる。
    //   候補に無い日（「2日はどうですか？」「明日大丈夫です」）は、その日の時間帯をまだ返していない＝AIX【内覧調整】をもう1回
    if (ctx.offeredDays.includes(day)) return { kind: "day_pick", day, time: ctx.offeredStart?.[day] ?? null };
    return { kind: "day_only", day, time: null };
  }
  if ((vague || time) && neg) return { kind: "ask_back", day: null, time: null };
  if (neg && ctx.inFlow && /日|週|月|予定|時/.test(scope) && !NON_VIEWING_DATE_RE.test(scope)) return { kind: "ask_back", day: null, time: null };
  if (!NON_VIEWING_DATE_RE.test(scope) && ((vague && (QUESTION_RE.test(scope) || accept)) || ALT_DAY_Q_RE.test(scope))) return { kind: "day_only", day: null, time: null };
  const core = t.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, "").trim();
  if (core.length <= 30 && core.split("\n").every((l) => SHORT_ACK_RE.test(l.trim()))) return { kind: "ack", day: singleDay, time: singleDay ? ctx.offeredStart?.[singleDay] ?? null : null };
  return no;
}

// ── こちらの発言 ──
/** 候補の日を出して都合を聞いた続き（「10/3日は終日予定が…10/2日のご予定はいかがでしょうか」） */
const STAFF_DAY_ASK_RE = /(?:[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}|[0-9]{1,2}日|明日|明後日|本日)[^\n]{0,24}(?:いかが|如何|ご都合|ご予定)/;
/** どの物件にも付く定型の締め（「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます」）は候補日の打診ではない */
const SOFT_INVITE_RE = /お気に召され|よろしければ|ご希望(?:の場合|でしたら|ございましたら)|気になる(?:お部屋|物件)/;
const STAFF_ASK_FORM_RE = /いかが|如何|ご都合|ご予定|可能です|出来ます|できます|お聞かせ|教えて/;
const PLACE_LATER_RE = /待ち合わせ(?:場所)?[^\n]{0,12}(?:追って|改めて|後ほど|決まり次第)|待ち合わせしやすい場所/;
const MEETING_ASK_LINE_RE = /(?:待ち合わせ|現地(?:エントランス|集合))[^\n]{0,30}(?:いかが|如何|でしょうか)/;
const ROOM_ASK_RE = /ご内覧希望のお部屋|どちらのお部屋|どのお部屋/;

const label = (day: string | null, time: string | null) => (day ? `${day}${time ? ` ${time}` : ""}` : null);
const slotDay = (l: string) => l.match(/^([0-9]{1,2}\/[0-9]{1,2})/)?.[1] ?? null;
const slotStart = (l: string) => l.match(/\s([0-9]{1,2}:[0-9]{2})/)?.[1]?.replace(/^0/, "") ?? null;

/**
 * 内覧の流れの段階を決める（純関数）。行動台帳・ブレインの材料・下書きの材料・画面の帯・出口の関所が同じ値を見る。
 */
export function resolveViewingFlow(input: ViewingFlowInput): ViewingFlow {
  const now = input.nowMs ?? Date.now();
  const inviteT = (input.inviteAts ?? []).map((x) => ms(x)).filter(Number.isFinite);
  const meetings = (input.meetings ?? []).map((m) => ({ t: ms(m.at), dateMD: m.dateMD ?? null, time: m.time ?? null })).filter((m) => Number.isFinite(m.t));
  const nearAny = (t: number, xs: number[]) => xs.some((x) => Math.abs(x - t) <= 3 * 60_000);

  type St = { stage: ViewingFlowStage; label: string | null; timeFixed: boolean; slots: string[]; proposedAt: number | null; lastReply: CustomerDateReply | null; askedDay: string | null; knownDay: string | null; placePromised: boolean; meetingOffered: boolean; lastEventAt: number | null; wishIdx: number; reason: string };
  const st: St = { wishIdx: -1, stage: "none", label: null, timeFixed: false, slots: [], proposedAt: null, lastReply: null, askedDay: null, knownDay: null, placePromised: false, meetingOffered: false, lastEventAt: null, reason: "no_viewing_flow" };
  const set = (stage: ViewingFlowStage, reason: string, t: number) => { st.stage = stage; st.reason = reason; if (Number.isFinite(t)) st.lastEventAt = t; };
  const offered = () => [...new Set(st.slots.map(slotDay).filter((x): x is string => !!x))];
  const offeredStart = () => Object.fromEntries(st.slots.map((l) => [slotDay(l), slotStart(l)]).filter((x): x is [string, string] => !!x[0] && !!x[1]));
  const propose = (text: string, t: number, reason: string) => {
    const slots = parseCandidateSlots(text, Number.isFinite(t) ? t : now).map((s) => s.label);
    st.slots = slots; st.proposedAt = Number.isFinite(t) ? t : null; st.lastReply = null; st.askedDay = null; st.label = null; st.timeFixed = false; st.placePromised = false; st.meetingOffered = false;
    set("proposing", reason, t);
  };

  const staleReason = (at: number): string => {
    const lastAt = st.lastEventAt ?? st.proposedAt;
    if (st.stage === "date_agreed" && st.label && /^[0-9]{1,2}\//.test(st.label) && dayEndMs(st.label.split(" ")[0], "23:59", lastAt ?? at) < at) return "agreed_date_passed";
    // ※ 候補の枠が過ぎただけでは切らない（みことさん: 9/28・9/29 の候補の後、9/29 22:29 に「2日はどうですか？」＝過ぎた候補への返事も流れの続き）。
    //   過ぎた枠は「こちらの候補」から外すだけ（下の liveSlots）
    if (lastAt != null && at - lastAt > VIEWING_FLOW_STALE_DAYS * DAY) return "stale";
    return "";
  };
  const isStale = (at: number) => staleReason(at) !== "";

  // 時刻の無い履歴（check-reply 経路）では AIX の行を本文に結べないので、AIX の行は最後にまとめて当てる
  const msgs = input.messages.filter((m) => (m.sender === "staff" || m.sender === "customer") && nfkc(m.text).trim() && !MEDIA_RE.test(nfkc(m.text).trim()));
  const meetingUsed = new Set<number>();
  // 短い了承（「よろしくお願いします」）が候補日への返事と言えるのは、こちらの最後の発言がその打診の時だけ。
  //   2026-09-30 見直し（監査: f5afb8c2「お願いします」「承知しました」＝申込の案内への了承・d3f7f5f3「よろしくお願いいたします」＝見積の約束への了承 が
  //   候補1日への了承と読まれ「日にち決定」に進んでいた。合っていたのは打診の直後の d3a56a97「はい！大丈夫です！」）
  let lastStaffIdx = -1, offerIdx = -1;
  for (let mi = 0; mi < msgs.length; mi++) {
    const m = msgs[mi];
    const t = ms(m.createdAt);
    const text = nfkc(m.text).trim();
    // 鮮度: 合意した日が過ぎた・候補の枠が全部過ぎて返事も無い・内覧の話が7日動いていない → 流れは続いていない（この後の希望は新しい流れ）
    if (Number.isFinite(t) && (st.stage === "proposing" || st.stage === "date_agreed" || st.stage === "wished") && isStale(t)) {
      const why = staleReason(t);
      st.slots = []; st.label = null; st.lastReply = null; st.askedDay = null; st.knownDay = null; st.proposedAt = null; st.placePromised = false; st.meetingOffered = false; st.stage = "none"; st.reason = why;
    }
    // 決まっていた内覧の日が過ぎた（内覧後のお礼は未送信）→ 内覧後。この後の「内覧いついけますか？」は新しい内覧の希望として読む
    if (st.stage === "confirmed" && st.label && Number.isFinite(t) && dayEndMs(st.label.split(" ")[0], "23:59", st.lastEventAt ?? t) < t) {
      st.slots = []; st.label = null; st.lastReply = null; st.askedDay = null; st.knownDay = null; st.stage = "done"; st.reason = "confirmed_date_passed";
    }
    if (m.sender === "staff") {
      lastStaffIdx = mi;
      if (STAFF_VIEWING_DONE_RE.test(text)) { st.slots = []; st.label = null; st.lastReply = null; st.askedDay = null; st.knownDay = null; st.placePromised = false; set("done", "viewing_thanks", t); continue; }
      const meeting = meetings.find((x) => Math.abs(x.t - t) <= 3 * 60_000);
      if (meeting) {
        meetingUsed.add(meeting.t);
        const asked = text.split("\n").some((l) => MEETING_ASK_LINE_RE.test(l));
        st.label = label(meeting.dateMD, meeting.time); st.timeFixed = !!meeting.time; st.askedDay = null; st.placePromised = false;
        if (asked) { st.meetingOffered = true; st.lastReply = null; set("proposing", "meeting_place_offered", t); }
        else { st.meetingOffered = false; set("confirmed", "meeting_place_sent", t); }
        continue;
      }
      const declared = findStaffViewingDeclaration(text, t);
      // 待ち合わせの後の「本日16:00よりお部屋ご案内させていただきます」は当日の挨拶（確定のまま）
      if (declared) {
        if (st.stage !== "confirmed") {
          const tm = parseCustomerTime(text);
          st.label = label(declared, tm); st.timeFixed = !!tm; st.askedDay = null; st.slots = [];
          if (PLACE_LATER_RE.test(text) || ROOM_ASK_RE.test(text)) { st.placePromised = PLACE_LATER_RE.test(text); set("date_agreed", "staff_declared_place_later", t); }
          else set("confirmed", "staff_declared", t);
        }
        continue;   // 「本日12:00よりお部屋ご案内させていただきます」（当日の挨拶）を新しい候補日の打診と読まない
      }
      if (PLACE_LATER_RE.test(text) && (st.stage === "proposing" || st.stage === "date_agreed")) {
        st.placePromised = true;
        const d = parseCustomerDay(text, t); const tm = parseCustomerTime(text);
        if (d && st.stage === "proposing") { st.label = label(d, tm); st.timeFixed = !!tm; set("date_agreed", "staff_place_later", t); }
        continue;
      }
      const isAixInvite = nearAny(t, inviteT);
      const hasSlots = parseCandidateSlots(text, Number.isFinite(t) ? t : now).length > 0;
      // 手書きの打診: 都合を聞く形（いかが・ご都合・可能です・お聞かせ）がある時だけ。どの物件にも付く定型の締めは候補の日時がある時だけ
      if (isAixInvite || (STAFF_VIEWING_PROPOSAL_RE.test(text) && STAFF_ASK_FORM_RE.test(text) && (hasSlots || !SOFT_INVITE_RE.test(text)))) {
        propose(text, t, isAixInvite ? "aix_viewing_invite" : "staff_proposed"); offerIdx = mi;
        continue;
      }
      // 候補日のやり取り中の続き（別の日を打診）。段階は proposing のまま、聞いた日を候補に足す
      if ((st.stage === "proposing" || st.stage === "date_agreed") && STAFF_DAY_ASK_RE.test(text)) {
        const d = parseCustomerDay(text.split("\n").filter((l) => STAFF_DAY_ASK_RE.test(l)).join("\n"), t);
        if (d) { st.knownDay = null; st.askedDay = null; st.lastReply = null; st.label = null; st.timeFixed = false; if (!offered().includes(d)) st.slots = [...st.slots.filter((l) => slotDay(l) !== d), d]; set("proposing", "staff_asked_day", t); offerIdx = mi; }
      }
      continue;
    }
    // ── お客様 ──
    if (st.stage === "proposing" || st.stage === "date_agreed") {
      // 候補日のやり取り中に、別のお部屋も見たい・やっぱり見たい と言われた（段階は変えない・次の一手は内覧調整）
      if (WISH_FORM_RE.test(text) && !CANCEL_RE.test(text)) st.wishIdx = mi;
      const v = classifyCustomerDateReply(text, { atMs: t, offeredDays: offered(), offeredStart: offeredStart(), knownDay: st.knownDay, inFlow: true });
      if (v.kind === "none") continue;
      st.lastReply = v.kind;
      if (v.kind === "cancel") { st.slots = []; st.label = null; st.askedDay = null; st.knownDay = null; set("none", "customer_cancelled", t); continue; }
      if (st.meetingOffered && (v.kind === "ack" || v.kind === "date_time" || v.kind === "day_pick")) { st.meetingOffered = false; set("confirmed", "meeting_offer_accepted", t); continue; }
      if (v.kind === "date_time") { st.label = v.day ? label(v.day, v.time) : v.time; st.timeFixed = true; st.askedDay = null; st.knownDay = v.day ?? st.knownDay; set("date_agreed", "customer_date_time", t); continue; }
      // 候補の日を選んだ: 開始時刻は候補の枠の中（待ち合わせ場所で入れる）＝時刻は未定として持つ
      if (v.kind === "day_pick") { st.label = label(v.day, null); st.timeFixed = false; st.askedDay = null; st.knownDay = v.day; set("date_agreed", "customer_day_pick", t); continue; }
      if (v.kind === "ack") {
        if (st.stage === "date_agreed") continue;   // 合意の後の了承は合意のまま
        if (v.day && offerIdx === lastStaffIdx) { st.label = label(v.day, v.time); st.timeFixed = !!v.time; set("date_agreed", "customer_ack_single_day", t); }
        continue;   // 候補が複数の「了解です」・別の話への了承は決まらない
      }
      // day_only / ask_back / hold: まだ決まっていない（合意していた時は打診に戻す）
      if (v.kind === "day_only" || v.kind === "ask_back") { st.askedDay = v.day; st.knownDay = v.kind === "day_only" ? v.day : null; }
      st.label = null; st.timeFixed = false;
      set("proposing", `customer_${v.kind}`, t);
      continue;
    }
    if (st.stage === "confirmed") {
      if (CANCEL_RE.test(text) && !parseCustomerDay(text, t)) { st.lastReply = "cancel"; set("none", "customer_cancelled_after_confirm", t); continue; }
      // 確定の後の変更（「30日の方が助かるんですけど変更お願いしても」「8月4日の12時過ぎなら大丈夫です」）:
      //   日＋時刻がそろえば待ち合わせを送り直す・日だけなら内覧調整をもう1回（実送信: cdf07418・0133b787）
      const v = classifyCustomerDateReply(text.replace(CANCEL_RE, ""), { atMs: t, offeredDays: [], knownDay: null });
      const curDay = st.label?.split(" ")[0] ?? null; const curTime = st.label?.split(" ")[1] ?? null;
      const explicitDay = !!parseCustomerDay(text, t);
      if (v.kind === "date_time" && explicitDay && (v.day !== curDay || v.time !== curTime)) { st.lastReply = v.kind; st.label = label(v.day, v.time); st.timeFixed = true; st.knownDay = v.day; st.slots = []; set("date_agreed", "change_after_confirm", t); }
      else if ((v.kind === "day_only" || v.kind === "ask_back") && v.day && v.day !== curDay && /変更|別日|別の日|ずらし|内覧|内見|キャンセル|延期|難し|厳し|行けな/.test(text)) { st.lastReply = v.kind; st.askedDay = v.day; st.knownDay = v.kind === "day_only" ? v.day : null; st.label = null; st.slots = []; set("proposing", "change_after_confirm_day", t); }
      continue;
    }
    // none / wished / done: お客様の内覧の希望
    const wishes = customerWishes(text);
    const reschedule = (st.stage === "done" || st.stage === "none") && /別日|別の日|日付(?:を)?(?:勘違い|間違)|寝坊|(?:内覧|内見)[^\n]{0,10}(?:変更|別)/.test(text);
    if (wishes || reschedule || st.stage === "wished") {
      const v = classifyCustomerDateReply(text, { atMs: t, offeredDays: [], knownDay: st.knownDay, inFlow: true });
      if ((wishes || reschedule) && st.stage !== "wished") { st.slots = []; st.proposedAt = null; st.lastReply = null; st.label = null; st.askedDay = null; st.knownDay = null; set("wished", "customer_wish", t); }
      if (wishes || reschedule) st.wishIdx = mi;
      // 候補日を待たずにお客様が日時を指定した（「23日に内覧…時間12時からお願いできますか？」→ スタッフはそのまま待ち合わせ。9会話）
      if (v.kind === "date_time") { st.lastReply = v.kind; st.label = v.day ? label(v.day, v.time) : v.time; st.timeFixed = true; st.knownDay = v.day ?? st.knownDay; set("date_agreed", "customer_date_time_no_proposal", t); }
      else if (v.kind === "day_pick" || v.kind === "day_only") { st.lastReply = v.kind; st.askedDay = v.day; st.knownDay = v.day; if (Number.isFinite(t)) st.lastEventAt = t; }
      else if (v.kind === "cancel") { set("none", "customer_cancelled", t); }
    }
  }
  // 時刻で本文に結べなかった AIX の行（本文が取得範囲の外・時刻の無い履歴）
  const looseMeeting = meetings.filter((x) => !meetingUsed.has(x.t)).sort((a, b) => b.t - a.t)[0];
  if (looseMeeting && (st.lastEventAt == null || looseMeeting.t > st.lastEventAt)) {
    st.label = label(looseMeeting.dateMD, looseMeeting.time); st.timeFixed = !!looseMeeting.time; set("confirmed", "meeting_place_sent_loose", looseMeeting.t);
  }
  const looseInvite = inviteT.filter((x) => !msgs.some((m) => m.sender === "staff" && Math.abs(ms(m.createdAt) - x) <= 3 * 60_000)).sort((a, b) => b - a)[0];
  if (looseInvite != null && (st.lastEventAt == null || looseInvite > st.lastEventAt) && st.stage !== "confirmed") {
    st.slots = []; st.proposedAt = looseInvite; st.lastReply = null; st.label = null; set("proposing", "aix_viewing_invite_loose", looseInvite);
  }

  // ── 台帳の事実と合わせる（確定の線は台帳）──
  const confirmed = !!input.appointment || !!input.declared;
  if (input.done && (st.lastEventAt == null || st.lastEventAt <= ms(input.done.thankedAt) || st.stage === "confirmed")) { st.stage = "done"; st.reason = "viewing_done"; }
  if (st.stage === "confirmed" && !confirmed && !input.done) {
    // 待ち合わせを案内したが日付が過ぎた（内覧後のお礼は未送信）＝内覧後（実施は未確認）
    st.stage = "done"; st.reason = "confirmed_date_passed";
  }
  if (confirmed && (st.stage === "none" || st.stage === "wished" || st.stage === "done") && !/cancelled/.test(st.reason)) {
    st.stage = "confirmed"; st.reason = "ledger_confirmed";
    st.label = input.appointment ? label(input.appointment.dateMD, input.appointment.time) : label(input.declared!.dateMD, null);
    st.timeFixed = !!input.appointment?.time;
  }

  // ── 鮮度（線を1つに）: 候補の枠が全部過ぎた・合意した日が過ぎた・内覧の話が7日動いていない → 流れは続いていない ──
  if (st.stage === "proposing" || st.stage === "wished" || st.stage === "date_agreed") {
    const why = staleReason(now);
    if (why) { st.stage = "none"; st.reason = why; }
  }

  // まだ過ぎていない候補だけを「こちらの候補」として渡す
  const liveSlots = st.slots.filter((l) => { const d = slotDay(l); if (!d) return false; const e = l.match(/〜([0-9]{1,2}:[0-9]{2})/)?.[1] ?? "23:59"; return dayEndMs(d, e, st.proposedAt ?? now) >= now; });

  // 今回のお客様の連投（履歴の最後がお客様）の日にちの返事
  let currentReply: CustomerDateReply | null = null;
  let currentWish = false;
  const lastIdx = msgs.length - 1;
  if (lastIdx >= 0 && msgs[lastIdx].sender === "customer" && (st.stage === "proposing" || st.stage === "date_agreed" || st.stage === "wished" || st.stage === "none")) {
    let i = lastIdx; while (i - 1 >= 0 && msgs[i - 1].sender === "customer") i--;
    currentWish = (st.stage === "wished" || st.stage === "proposing" || st.stage === "date_agreed") && st.wishIdx >= i;
    // 今回の連投より前の状態は持っていないので、連投の中で一番「日にちの返事」らしい形を採る
    const order: CustomerDateReply[] = ["cancel", "date_time", "day_pick", "day_only", "ask_back", "hold", "ack"];
    const kinds = msgs.slice(i).map((m) => classifyCustomerDateReply(m.text, { atMs: ms(m.createdAt), offeredDays: offered(), offeredStart: offeredStart(), knownDay: st.knownDay, inFlow: st.stage !== "none" }).kind);
    currentReply = order.find((k) => kinds.includes(k)) ?? "none";
    // 候補が複数ある時の「了解です」、候補を出していない時の了承は日にちの返事ではない
    if (currentReply === "ack" && st.stage !== "date_agreed") currentReply = "none";
    if (st.stage === "none" && st.reason !== "customer_cancelled" && st.reason !== "customer_cancelled_after_confirm") currentReply = currentReply === "cancel" ? "cancel" : "none";
  }

  return {
    stage: st.stage, confirmed,
    label: st.stage === "date_agreed" || st.stage === "confirmed" || (st.stage === "proposing" && st.meetingOffered) ? st.label : null,
    timeFixed: st.timeFixed, slots: st.stage === "proposing" ? liveSlots : [],
    proposedAt: st.proposedAt != null && (st.stage === "proposing" || st.stage === "date_agreed") ? new Date(st.proposedAt).toISOString() : null,
    lastReply: st.lastReply, currentReply,
    askedDay: st.stage === "proposing" || st.stage === "wished" || st.stage === "date_agreed" ? st.askedDay : null,
    placePromised: st.stage === "date_agreed" && st.placePromised, meetingOffered: st.stage === "proposing" && st.meetingOffered,
    currentWish, reason: st.reason,
  };
}

/** M/D と時刻 → その日のその時刻（JST）の ms。年は基準の時刻から（半年より前の月は翌年） */
function dayEndMs(md: string, hm: string, baseMs: number): number {
  const [m, d] = md.split("/").map(Number); const [h, mi] = hm.split(":").map(Number);
  if (!m || !d) return NaN;
  const p = jstParts(baseMs);
  const y = m < p.m - 6 ? p.y + 1 : m > p.m + 6 ? p.y - 1 : p.y;
  return Date.UTC(y, m - 1, d, (h || 0) - 9, mi || 0);
}

export const EMPTY_VIEWING_FLOW: ViewingFlow = { stage: "none", confirmed: false, label: null, timeFixed: false, slots: [], proposedAt: null, lastReply: null, currentReply: null, askedDay: null, placePromised: false, meetingOffered: false, currentWish: false, reason: "no_viewing_flow" };

export const VIEWING_FLOW_STAGE_JA: Record<ViewingFlowStage, string> = {
  none: "内覧の話なし", wished: "お客様が内覧を希望（候補日は未提示）", proposing: "候補日を提示中（まだ決まっていない）",
  date_agreed: "日にちは決まった（待ち合わせ場所は未送信＝まだ確定ではない）", confirmed: "内覧確定（待ち合わせ場所を送信済み）", done: "内覧後",
};
const REPLY_JA: Record<CustomerDateReply, string> = {
  date_time: "日と開始時刻を指定した", day_pick: "候補の日を選んだ", ack: "短い了承", day_only: "日だけを聞いた・提案した（時刻は未定）",
  ask_back: "都合が合わない・聞き返し", hold: "保留（また連絡する）", cancel: "取りやめ", none: "日にちの返事ではない（別の話）",
};

/**
 * 段階から見た次の AIX の候補（監査と、ブレインへの材料の1行に使う。決めるのはブレイン）。
 *   null＝段階からは何も言わない（別の質問・保留・確定の後）
 */
export function viewingFlowNextAix(f: ViewingFlow): "viewing_invite" | "meeting_place" | null {
  if (f.currentReply === "cancel" || f.currentReply === "hold") return null;
  if (f.stage === "date_agreed") return f.currentReply && f.currentReply !== "none" ? "meeting_place" : null;
  if (f.stage === "proposing") return f.currentReply === "day_only" || f.currentReply === "ask_back" || (f.currentWish && f.currentReply === "none") ? "viewing_invite" : null;
  if (f.stage === "wished") return f.currentWish || f.currentReply === "day_only" || f.currentReply === "day_pick" ? "viewing_invite" : null;
  return null;
}

/**
 * ブレインに渡す1段（毎回変わる側＝user 側に置く。前置きのキャッシュは変えない）。
 *   none・done は何も足さない（内覧後は customer-state の段が持つ）
 */
export function buildViewingFlowBrainText(f: ViewingFlow): string {
  if (f.stage === "none" || f.stage === "done") return "";
  const head = "\n【内覧の流れ（今の段階・確定事実。流れ: AIX【内覧調整】で候補日 → お客様が日にち・開始時刻を返す → AIX【待ち合わせ場所】＝ここで初めて内覧確定）】";
  const lines: string[] = [`・段階: ${VIEWING_FLOW_STAGE_JA[f.stage]}${f.label ? `（${f.label}${f.stage === "date_agreed" && !f.timeFixed ? "・開始時刻は未定" : ""}）` : ""}`];
  if (f.stage === "proposing") {
    if (f.slots.length) lines.push(`・こちらの候補: ${f.slots.slice(0, 4).join(" / ")}${f.meetingOffered ? "（待ち合わせの打診・お返事待ち）" : ""}`);
    lines.push(`・候補を出した後のお客様の日にちの返事: ${f.lastReply ? REPLY_JA[f.lastReply] : "まだ無い"}${f.askedDay ? `（${f.askedDay}）` : ""}`);
  }
  if (f.currentReply) lines.push(`・今回のお客様の発言: ${REPLY_JA[f.currentReply]}`);
  // 待ち合わせを「いかがでしょうか」で送った時は、台帳の待ち合わせ案内はその打診そのもの（「別に1つある」ではない）
  if (f.confirmed && f.stage !== "confirmed" && !f.meetingOffered) lines.push("・これとは別に、待ち合わせ場所を送った（確定した）内覧が1つある（台帳の待ち合わせ案内）");
  const rule: string[] = [];
  if (f.stage === "wished") {
    rule.push("候補日はまだ出していない → viewing_invite（候補日は AIX で送る。本文で日時を作らない）");
  } else if (f.stage === "proposing" && f.meetingOffered) {
    rule.push("待ち合わせ場所は送ってあり、お客様の返事待ち。meeting_place をもう一度提案しない（日時・場所の変更を頼まれた時だけ）。今回の発言が別の質問なら、その質問にだけ答える");
  } else if (f.stage === "proposing") {
    rule.push("内覧は**まだ決まっていない**。内覧日を確定した前提で進めない（meeting_place は日と開始時刻がそろってから）");
    if (f.currentReply === "none" || f.currentReply == null) {
      rule.push("今回の発言は日にちの返事ではない → その質問・用件にだけ答える。reply_direction・key_topics・next_steps に「内覧日の確定」「内覧へ進める」「〇/〇の内覧」「内覧希望日の回答確認」を入れない（日にちの返事はお客様から来るのを待つ。ルール④の催促の対象にしない）。AIX は今回の発言だけで決める");
    } else if (f.currentReply === "day_only" || f.currentReply === "ask_back") {
      rule.push("日だけ・別の日・都合が合わない → viewing_invite（その日の空き時間は AIX【内覧調整】で返す）。こちらの空き・休みは予定表でしか分からないので「〇日は休み」「〇日は空いている」を事実として reply_direction に書かない");
    } else if (f.currentReply === "hold") {
      rule.push("お客様は保留（また連絡する）→ 日程を催促しない。AIX なしで受ける");
    }
  } else if (f.stage === "date_agreed") {
    rule.push(`日にちは決まったが、待ち合わせ場所は未送信＝まだ確定ではない。次の一手は meeting_place（AIX【待ち合わせ場所】${f.timeFixed ? "" : "・開始時刻はピッカーで入れる"}）`);
    if (f.currentReply === "none" || f.currentReply == null) rule.push("今回の発言が別の質問なら、その質問に答える（内覧の時に話す・当日よろしく は書かせない）。待ち合わせ場所の送信がまだ残っている事は next_steps に残す");
    if (f.placePromised) rule.push("こちらは「待ち合わせ場所は追ってご連絡」と伝えてある（未履行のやる事）");
  } else if (f.stage === "confirmed") {
    rule.push("内覧は確定。meeting_place をもう一度提案しない（日時・場所・お部屋の変更を頼まれた時だけ: 日時がそろえば meeting_place を送り直す・日だけなら viewing_invite）。内覧当日の話（内覧時に併せて 等）は書いてよい");
  }
  return `${head}\n${lines.join("\n")}\n→ ${rule.join("。")}。`;
}

/**
 * 返信生成の台帳の注記の1行（本文を引用しない＝種類の名前だけ）。confirmed・done・none は空（既存の行が持つ）
 */
export function buildViewingFlowLedgerLine(f: ViewingFlow): string {
  const NOT_YET = "内覧を決まった予定として書かない（内覧の時に話す・説明すると先送りする／内覧へのよろしく・楽しみにしている）。内覧が決まるのは AIX【待ち合わせ場所】を送った時。お客様の質問には今わかる事で答える。";
  if (f.confirmed && f.stage !== "proposing" && f.stage !== "date_agreed") return "";
  // 待ち合わせを「いかがでしょうか」で送った＝台帳の「待ち合わせを案内済み・この内覧は決まっている」の行と同じ内覧。
  //   ここで「まだ決まっていない」「別に決まった内覧がある」を足すと同じ注記の中で食い違う（2026-09-30 見直し）→ 既存の行に任せる
  if (f.confirmed && f.meetingOffered) return "";
  const also = f.confirmed ? "（別に、待ち合わせを案内済みの内覧は決まっている。ここで言うのは新しい候補日の方）" : "";
  if (f.stage === "proposing") {
    const wait = f.meetingOffered ? "待ち合わせを打診中・お客様の返事待ち" : f.lastReply === "hold" ? "お客様は日程を保留中" : f.askedDay ? `お客様が${f.askedDay}を聞いた・その日の時間帯はまだ返していない` : "候補日のやり取り中・待ち合わせ場所は未案内";
    // 2026-09-30 YUMA（S11「その次の日はどうですか？」）: 下書きが「翌日もご内覧可能です！！」と空きを作った（予定表は AIX【内覧調整】でしか分からない）。
    //   お客様が日・時間帯を聞いた／都合が合わないと言った番は、その日が空いているかを本文で答えさせない（入口だけ・出口は実送信の監査をしていないので入れない）
    const asked = f.currentReply === "day_only" || f.currentReply === "ask_back" || f.lastReply === "day_only" || f.lastReply === "ask_back"
      ? "お客様が聞いた日・時間帯が空いているか（その日も可能・その日は難しい）はこちらでは分からない＝本文で答えない（受けるだけにする）。"
      : "";
    return `→ 内覧は**まだ決まっていない**（${wait}）${also}。内覧の日時を言い切らない。日程の返事を催促しない（候補の日時・空き・休みは AIX【内覧調整】で送る。本文で新しい日時・「〇日は休み」を作らない）。${asked}${NOT_YET}`;
  }
  if (f.stage === "date_agreed") {
    return `→ 内覧の日にちは決まった${f.label ? `（${f.label}${f.timeFixed ? "" : "・開始時刻は未定"}）` : ""}が、**待ち合わせ場所は未案内＝まだ確定ではない**${also}。待ち合わせの場所・集合は書かない（AIX【待ち合わせ場所】で送る）。今回の発言が日にちの返事の時だけ、その日時を受ける一言はよい。${NOT_YET}`;
  }
  if (f.stage === "wished") return `→ お客様は内覧を希望しているが、候補日はまだ出していない${also}。本文で日時を作らない（候補日は AIX【内覧調整】で送る）。${NOT_YET}`;
  return "";
}

/** 画面の帯（customer-state の「内覧調整中」の一言） */
export function viewingFlowStageDetail(f: ViewingFlow): string | null {
  if (f.stage === "wished") return "内覧希望・候補日は未提示";
  if (f.stage === "proposing") return f.meetingOffered ? "待ち合わせを打診中・お返事待ち" : f.lastReply === "hold" ? "候補日を提示・お客様は保留" : f.askedDay ? `お客様が${f.askedDay}を希望・時間帯は未回答` : f.lastReply ? "候補日を提示・調整中" : "候補日を提示・お返事待ち";
  if (f.stage === "date_agreed") return `日にち決定${f.label ? ` ${f.label}` : ""}・待ち合わせ場所は未送信`;
  return null;
}
