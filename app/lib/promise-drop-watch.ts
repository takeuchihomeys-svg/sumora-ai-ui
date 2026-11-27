// app/lib/promise-drop-watch.ts — 約束の取りこぼしの見張り（純関数・DB も LINE も持たない）
//
// 2026-11-21 作業員L（統括役の頼み・誘導の穴 #414 の掘りで見つけた本当の取りこぼし3件）:
//   ピックアップ・確認を約束した後、物件の AIX も送付も無いまま 15〜29日お客様を待たせていた（会話 6e77895d・83391dda・44fd59ab）。
//   約束の見張りはどれも「何かが起きた時」にしか動かない（promise-queue＝送った時だけ・7日／ブレイン＝お客様の発言の時だけ／
//   AIX_OVERDUE_REMIND＝pending の要対応の 24〜48時間だけ）ので、約束の後にお客様が黙った・お礼が1回来て黙った・要対応を取り下げた会話は
//   どこにも出なかった（外れの原因の ①材料・仕組みが届いていない）。
//   → 1日1回、約束から 72時間を過ぎて果たしていない会話を並べる。形は売上番長グループの決まり（「〇〇さん → AIX【ボタン】」・feedback_group_aix_only）。
// 切替 PROMISE_DROP_WATCH: 既定（未設定）は記録だけ（shadow: cron_run_logs に何件・誰が出るはずだったかを残す・LINE に出さない）／
//   on＝売上番長グループに送る（竹内さんの OK の後）／off＝何もしない。
// テスト: app/lib/__tests__/promise-drop-watch.test.ts
import { aixButtonText } from "./aix-action-text";
import { promiseDueDay } from "./promise-due";

type Env = Record<string, string | undefined>;
export type PromiseDropMode = "off" | "shadow" | "on";
export function promiseDropWatchMode(env: Env = typeof process !== "undefined" ? process.env : {}): PromiseDropMode {
  const v = (env.PROMISE_DROP_WATCH ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "off" ? "off" : "shadow";
}

export const PROMISE_DROP_MIN_H = 72;
export const PROMISE_DROP_MAX_DAYS = 30;
export const PROMISE_DROP_KEY = "promise_drop_watch_last_at";
export const PROMISE_DROP_TEXT_KEY = "promise_drop_watch_text";

export type PdMsg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };
export type PdAix = { aix_type: string | null; sent_at: string | null; created_at: string };
export type PdSent = { sent_at: string | null };
export type PdItem = { action: string; status: string; created_at: string };
export type PdPick = { created_at: string; status?: string | null; sent_at?: string | null; expired_at?: string | null };
export type PdInput = { conversationId: string; customerName: string | null; status: string | null; msgs: ReadonlyArray<PdMsg>; aix: ReadonlyArray<PdAix>; sent: ReadonlyArray<PdSent>; items: ReadonlyArray<PdItem>; picks: ReadonlyArray<PdPick> };

/** 約束の種類（こちらの手打ちの文の言葉で・作らない）。新着を随時は期日が無いので見張らない */
export type PdKind = "pickup" | "check";
/**
 * 約束を読む前に、約束でない節を落とす（2026-11-21 作業員N の B1 の確かめで見つかった穴）:
 *   穴1 過去形の報告（「御見積書をお送りさせて頂きました」「確認させて頂きましたところ」）は約束でない
 *   穴2 条件つき（「ご条件お送り頂きますと、ピックアップさせて頂きます」）は、お客様が条件を送るまで期限が始まらない＝約束に数えない
 *   穴4（2026-11-23 作業員L・#638）: 時期の条件つき（「12月中旬ごろになりましたら本格的にお部屋探し再開させていただきます」）もその時期まで始まらない
 *   節は 。！!？?・改行 で切る（同じ節の中に条件の言葉があれば、その節だけ落とす）
 */
export function promiseClausesOf(text: string): string {
  const t = String(text ?? "").normalize("NFKC");
  // 条件ヒアリングの用紙を送った直後の「ご条件に合ったお部屋ピックアップさせて頂きます！！お手隙の際にご入力ください」も条件つき（お客様の入力待ち・dfa8a68f）
  if (/ご入力(?:ください|下さい|の程|をお願い|頂けますと)/.test(t)) return "";
  return t.split(/(?<=[。！!？?\n])/).filter((c) =>
    // 2026-11-23 作業員L（#655 の続きの確かめ・fecda03f）: 「管理会社に交渉させて頂きましたが…とのご返事でした」も過去の報告（「ましたが」「ましたけれど」）
    !/(?:頂き|いただき|致し|いたし)ました(?:[！!。？?\n]|ところ|が|けれど|けど|$)/.test(c) &&
    !/(?:頂き|いただき)ますと|(?:頂|いただ)ければ|(?:頂|いただ)けましたら|(?:頂|いただ)けますと|(?:下さ|くださ)いましたら|(?:に|ごろに|頃に)?なりましたら/.test(c) &&
    // 穴6（2026-11-23 作業員L・#655 の続きの確かめ・331b0338）: 「1ヶ月以降のご入居をご希望の場合は管理会社に交渉させていただきます」
    //   「お気に召されましたお部屋〇〇でのご入居可能か交渉させていただきます」はお客様の希望・選び待ちの条件つき
    !/ご希望の場合は|の場合は(?:管理会社|こちら|私)|お気に召され(?:ましたら|ました(?:お部屋|物件))/.test(c) &&
    // 穴5（2026-11-23 作業員L・#638 の続き 36bb96d9）: 「お気に召されたお部屋の募集状況も確認させていただきますので、気になるお部屋もお気軽にお送り下さい」は
    //   お客様が物件を送ったら確認するという案内（お客様の送付待ち）＝約束に数えない
    !/(?:お気に召され|気になる|気に入られ)[^。！!？?\n]*(?:お部屋|物件)[^。！!？?\n]*(?:お送り|ご連絡)(?:下さい|ください)/.test(c),
  ).join("");
}
// ─── 2026-11-23 作業員L（竹内さん 11/23 P0「約束の部分もぬけや足りない土台がないか細部まで」・scripts/audit-promise-kinds.ts の14日）───
//   約束の形の節 333 のうち 47% が種類の網（見張り・行動台帳・連絡日・待ち合わせ）のどれにも入らなかった。中身は申込以降・説明・内覧当日・気持ちの言葉が大半で、
//   種類の網の候補は 28 節: 「（大きめの・広めの）お部屋（を）探させて頂きます」「追加でお部屋お送りさせて頂きます」（探す 11）・
//   「募集状况（况の字）確認」「内覧可能なお部屋も確認」「〜か交渉させて頂きます」「管理会社にご連絡／お伝えさせて頂きます」「分かり次第ご連絡させて」（確認 10）・
//   「お電話かけさせて頂きます」「再度〇時ごろにご連絡させて頂きます」（電話 6）・「（ご内覧）時間調整させて頂きます」（内覧 2）。
//   探すの候補は記録（sent_facts）もカレンダーも無く、331b0338 は 11/10 の約束のあと13日物件が出ていない（見張りにも統括の材料にも出ない本当の抜け）。
//   PROMISE_KIND_WIDE（既定 off・=on で使う）: 見張り（promiseDropOf・overduePromisesOf＝統括の材料）と B1 の種類の網にこの型を足す。
//   行動台帳・カレンダーの【必ず】（スタッフの画面）には足さない（竹内さんに確認する案）。テスト: app/lib/__tests__/promise-kind-wide.test.ts
export const promiseKindWideOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.PROMISE_KIND_WIDE ?? "").trim().toLowerCase() === "on";
export type PromiseWideKind = "pickup" | "check" | "callback" | "viewing_slot";
/** 種類の網の候補（今の網が拾わない言い回し）。節（promiseClausesOf の後）で読む。null は候補なし */
export function promiseWideKindOf(clause: string): PromiseWideKind | null {
  const t = String(clause ?? "").normalize("NFKC").replace(/况/g, "況");
  if (/(?:お部屋|物件)[^。！!？?\n]{0,4}?(?:を|も)?(?:含めて)?(?:お?探させて|お探しさせて)(?:頂|いただ)きます|(?:追加で|中心に)[^。！!？?\n]{0,10}(?:お部屋|物件)?(?:を)?お送りさせて(?:頂|いただ)きます/.test(t)) return "pickup";
  if (/(?:募集状況|空き状況|空室状況)[^。！!？?\n]{0,12}?(?:確認|お調べ)させて(?:頂|いただ)|内覧可能[^。！!？?\n]{0,12}確認させて(?:頂|いただ)|か(?:を)?交渉させて(?:頂|いただ)|(?:よう|ように)交渉させて(?:頂|いただ)|管理会[^。！!？?\n]{0,6}(?:に|へ)?(?:ご連絡|お伝え|交渉)させて(?:頂|いただ)|(?:分かり|わかり|繋がり|つながり)次第[^。！!？?\n]{0,16}ご連絡させて/.test(t)) return "check";
  if (/お電話(?:を)?(?:かけ|にて)[^。！!？?\n]{0,12}させて(?:頂|いただ)|再度[^。！!？?\n]{0,12}(?:ご連絡|お電話)させて(?:頂|いただ)/.test(t)) return "callback";
  if (/(?:ご内覧|内覧|ご案内)(?:の)?(?:お?時間|日程|日時)(?:を)?調整させて(?:頂|いただ)|時間調整させて(?:頂|いただ)/.test(t)) return "viewing_slot";
  return null;
}
// ─── 2026-11-25 作業員L（台帳 #664 の①・統括役の了承）: 「その他」の残り 142 の言い回しから、種類が決まる物だけ足す網（PROMISE_KIND_WIDE2・既定 off）───
//   探す: 「（ご入居可能な・初期費用抑えられる）お部屋（も）お送りさせて頂きます」「お部屋…出次第／随時お送りさせて」（お送り 24 の大半）
//   確認: 「最終確認をさせて頂きます」「募集状況確認 翌営業日に…させていただきます」（間に語が入る形）・「（礼金の）減額交渉をさせて頂きます」
//   見積: 「（最大限割引して）御見積書をご用意いたします」
//   足さない: 「初期費用を最大限割引させて頂きます」だけの節（竹内さん本人 60日 77回のうち 68% が通の締めの位置・72時間以内に見積の AIX は 19%＝決まり文句）・ご連絡・共有（果たした判定が無い種類）
export const promiseKindWide2On = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.PROMISE_KIND_WIDE2 ?? "").trim().toLowerCase() !== "off"; // 2026-11-26 統括役の決め: 既定 on（B1 60日で約束 +12＝取りこぼしの減り・記録だけ）。止める =off
export function promiseWide2KindOf(clause: string): "pickup" | "check" | "estimate" | null {
  const t = String(clause ?? "").normalize("NFKC");
  if (/御?見積(?:書|もり|り)?(?:を)?ご用意(?:いた|致|させて)/.test(t)) return "estimate";
  if (/(?:最終確認|募集状況確認|空室確認)(?:を)?[^。！!？?\n]{0,16}?させて(?:頂|いただ)き|減額交渉(?:を)?させて(?:頂|いただ)き/.test(t)) return "check";
  if (/(?:お部屋|物件)(?:も|を)?[^。！!？?\n]{0,16}?(?:次第|随時)?[^。！!？?\n]{0,6}?お送り(?:させて|さ)(?:頂|いただ)/.test(t) && !/(?:写真|動画|見積|資料|書類|QR)/.test(t)) return "pickup";
  return null;
}
export function promiseDropKindOf(text: string, env?: Env): PdKind | null {
  const t = promiseClausesOf(text);
  if (/新着/.test(t) && !/ピックアップ/.test(t)) return null;
  // 2026-11-23 作業員L（台帳 #638・行動台帳の本当に未履行8件のうち3件が見張りに出なかった）: ひらがなの「させていただき」・
  //   「ピックアップしお送り」（「して」でなく「し」）・「お部屋探し再開させて頂きます」も約束（7ec16043・a59bedf9・ac34b364 の形）
  if (/ピックアップ(?:させて(?:頂|いただ)|し(?:て)?(?:お送り|送らせ)|出来次第お送り|でき次第お送り)|お部屋(?:を)?(?:新たに)?(?:探|お探し)して(?:お送り|送らせ)|お部屋探し(?:を)?再開させて(?:頂|いただ)/.test(t)) return "pickup";
  //   ひらがなの確認は「…させていただきます」か「…させていただき、…次第／ご連絡」だけ（「管理会社に確認させていただき〇〇が採用されており」は結果の報告・ac34b364 の 11/18 の通）
  // 2026-11-23 作業員L（#638 の続き・作業員N2 の見つけ 82c4d3e8）: 「募集状況と初期費用確認させて頂きます」のように対象と動きの間に短い語（12字まで・節の中）が入る形も確認の約束
  if (/(?:募集状況|空き状況|空室状況)[^。！!？?\n]{0,12}?(?:確認|お調べ)させて頂|管理会社(?:に|へ)(?:確認|交渉)させて頂/.test(t)) return "check";
  if (/(?:(?:募集状況|空き状況|空室状況)[^。！!？?\n]{0,12}?(?:確認|お調べ)|管理会社(?:に|へ)(?:確認|交渉))させていただ(?:きます|き[、,]?[^。！!？?\n]*(?:次第|ご連絡|お送り|ご報告))/.test(t)) return "check";
  if (promiseKindWideOn(env)) { const w = promiseWideKindOf(t); if (w === "pickup" || w === "check") return w; }
  if (promiseKindWide2On(env)) { const w2 = promiseWide2KindOf(t); if (w2 === "pickup" || w2 === "check") return w2; }
  return null;
}
/** 約束を果たした印（物件・確認の結果・見積の AIX か、物件の送付） */
const FULFIL_AIX = /property|recommend|check_result|estimate|pickup/;
/** お客様が探すのを止めた・他で決めた（見張らない） */
// 2026-11-21 本番の試しで直した: お客様の「部屋決まった」・こちらの締め（「無事お部屋決まりよかったです」「またお引越しの機会」）も止めた印
// 確認の約束は、こちらの手打ちの文で結果を伝えて果たす事もある（「管理会社より…」「確認させて頂きましたところ」）
const CHECK_ANSWERED_RE = /確認(?:させて頂き|致し|いたし|し)ましたところ|管理会社(?:より|から|様より)|募集(?:中|終了|が終了|停止)|(?:申込|お申込み?)(?:が)?(?:入って|入り)/;
const STAFF_CLOSED_RE = /お部屋(?:が)?決まり(?:よかった|良かった|おめでとう)|またお引越しの機会/;
const STOPPED_RE = /部屋(?:が|は)?決ま(?:った|りました|りまし)|他(?:社|の(?:所|ところ|不動産))?で(?:決ま|決め)|決まりました|見送|(?:もう|一旦|いったん)(?:大丈夫|結構|探すのをやめ)|探すのをやめ|キャンセル(?:で|します)|今回は(?:やめて|見送|辞退|お断り)/; // 2026-11-23 作業員L: 「こちらの都合で別の家探すことになったので今回はやめておきます」（fecda03f）
const STOP_STATUS = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost", "closed", "cancelled", "lost", "dropped", "won"]);

// ─── 2026-11-21 作業員N（信頼の土台 B1・約束を期限内に果たした割合）と線をそろえた共有の決まり ───
/** 約束の種類の名前（B1 と #435 で同じ文字列）。果たした判定ができるのは pickup・check・estimate だけ */
export const PROMISE_KIND_NAMES = ["pickup", "check", "estimate", "viewing_slot", "callback", "other", "contact", "negotiate"] as const;
export type PromiseKindName = typeof PROMISE_KIND_NAMES[number];
export const PROMISE_KIND_JUDGEABLE: ReadonlySet<PromiseKindName> = new Set<PromiseKindName>(["pickup", "check", "estimate"]);
/** こちらの手打ちの文の約束の種類（約束でなければ null）。新着を随時は期日が無いので null */
export function promiseKindNameOf(text: string, env?: Env): PromiseKindName | null {
  const k = promiseDropKindOf(text, env);
  if (k) return k;
  const t = promiseClausesOf(text);
  if (/新着/.test(t) && !/ピックアップ/.test(t)) return null;
  // 2026-11-23 作業員L（#638 の続き・82c4d3e8）: 「…初期費用の御見積書とあわせてご連絡させて頂きます」も見積の約束
  if (/御?見積(?:書)?(?:を)?(?:作成|お作り)(?:して|させて頂)|御?見積(?:書)?(?:を)?お送りさせて頂|御?見積(?:書)?(?:と|も)?(?:あわせて|併せて|合わせて)[^。！!？?\n]{0,6}?(?:ご連絡|お送り)させて(?:頂|いただ)/.test(t)) return "estimate";
  if (/内覧(?:の)?(?:候補日?|日程|ご日程|お日にち)(?:を)?(?:確認|お調べ|お送り)させて頂|ご案内(?:可能な)?(?:日時|お時間)(?:を)?確認させて頂/.test(t)) return "viewing_slot";
  if (/(?:折り返し|改めて)(?:お電話|ご連絡のお電話)させて頂|お電話させて頂/.test(t)) return "callback";
  if (promiseKindWideOn(env)) { const w = promiseWideKindOf(t); if (w) return w; }
  if (promiseKindWide2On(env)) { const w2 = promiseWide2KindOf(t); if (w2) return w2; }
  if (promiseContactKindOn(env)) { const c = promiseContactKindOf(t); if (c) return c; }
  if (/させて頂きます/.test(t) && /(?:確認|お調べ|お送り|ご連絡)/.test(t)) return "other";
  return null;
}
/**
 * 1通の中の約束の文（節）だけ（2026-11-23 作業員L・台帳 #639）: 通の全文から期日を読むと、同じ通の別の文の日付の言葉（入居時期など）を
 *   期日に取る（e4bb495d: 11/18 の「お探しさせて頂きます」の期日を 12/17 と読み、見張りに出なかった）。行動台帳（約束の文だけで読む）と同じ読み方にする。
 *   約束の言葉のある節が無ければ全文（今と同じ）
 */
export function promiseSentenceOf(text: string): string {
  const cs = promiseClausesOf(text).split(/(?<=[。！!？?\n])/).filter((c) => promiseKindNameOf(c));
  return cs.length ? cs.join("") : String(text ?? "");
}
/** 期限: 約束の文の期限の言葉（promise-due.promiseDueDay・「明日」「本日中」「週明け」「〇日までに」）ならその日の終わり（JST 24時）、無ければ 72時間 */
/**
 * 2026-11-25 作業員L（台帳 #664 の②・統括役の頼み「72時間が竹内さんの感覚に合っているか」）: 期限の言葉が無い約束の期限を種類ごとに（PROMISE_DUE_BY_KIND・既定 off）。
 *   竹内さん本人の約束が実際に果たされた時間（B1 60日・scripts/audit-promise-hours.ts）: 確認 30件 中央 1.0時間・8割 15.8時間・72時間超え0／
 *   ピックアップ 65件 中央 11.3時間・8割 42.2時間・72時間超え8／見積 2件（数が小さい）。確認の 72時間は竹内さんの感覚より長すぎる＝期日超えに気づくのが2日遅い。
 *   案: 確認 24時間・ピックアップ 48時間（8割の時間に少し余裕）・見積と他は 72時間のまま。by は今まで通り default72h（読む側を変えない）
 */
export const promiseDueByKindOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.PROMISE_DUE_BY_KIND ?? "").trim().toLowerCase() === "on";
export const PROMISE_DUE_HOURS_BY_KIND: Readonly<Partial<Record<PromiseKindName, number>>> = { check: 24, pickup: 48 };
export function promiseDeadlineMs(text: string, atMs: number, kind?: PromiseKindName | null, env?: Env): { ms: number; by: "words" | "default72h" } {
  const t = String(text ?? "").normalize("NFKC");
  // 「出来次第」「確認出来次第」は期限の言葉にしない（作業員N と決めた）。挨拶の「本日はお時間…」も期限にしない
  const scrubbed = t.replace(/(?:確認)?(?:出来|でき)次第/g, "").replace(/本日は(?:お時間|ご内覧|お電話|ありがとう)[^。！\n]*/g, "");
  const d = promiseDueDay(scrubbed, atMs);
  const h = kind && promiseDueByKindOn(env) ? PROMISE_DUE_HOURS_BY_KIND[kind] ?? PROMISE_DROP_MIN_H : PROMISE_DROP_MIN_H;
  return d != null ? { ms: d + 86_400_000 - 9 * 3_600_000, by: "words" } : { ms: atMs + h * 3_600_000, by: "default72h" };
}
/**
 * 2026-11-23 作業員L（台帳 #660）: 「新着で募集で次第お送り」「新着が出次第」は期日の無い約束（外の出来事待ち）。行動台帳の --wide-close（promise-ledger-metrics）と同じ決め方で、
 *   見張り（promiseDropOf・overduePromisesOf＝統括の材料）と B1 も期日超えに数えない。「ピックアップ出来次第」「確認出来次第」は期日の言葉が無いだけで、期日は72時間のまま
 */
export const PROMISE_OPEN_ENDED_RE = /(?:新着|募集)[^。！!？?\n]{0,8}(?:出|で)次第/;
export function promiseOpenEnded(text: string | null | undefined): boolean {
  return PROMISE_OPEN_ENDED_RE.test(promiseClausesOf(String(text ?? "")));
}
const PICKUP_SENT_RE = /新着で出(?:た|ました)?|オススメ出来るお部屋(?:と|に)なります|お部屋(?:を)?お送りさせて頂きました|(?:こちらの)?お部屋如何でしょうか/;
const ESTIMATE_SENT_RE = /(?:御見積書|お見積(?:もり|り)?書?)(?:と)?(?:なります|になります|お送りさせて頂きました|お送り致しました|送らせて頂きました|添付)/;
export type PromiseEvidence = { msgs: ReadonlyArray<PdMsg>; aix: ReadonlyArray<PdAix>; sent: ReadonlyArray<PdSent> };
/**
 * 果たした印（約束の後の最初の物）。pickup・check・estimate だけ判定し、他は "n/a"（判定なし）。果たしていなければ null。
 *   AIX（物件・確認の結果・見積・ピックアップ。estimate は見積だけ）／お客様に届いた物件の送付（line_group は呼ぶ側で外す）／
 *   check はこちらの手打ちの文で結果を伝えた時も
 */
// ─── 2026-11-23 作業員L（台帳 #655 の続き・統括役の決め）───
//   確認の約束は、物件の AIX・物件の送付・「管理会社より…」の手打ちの文なら要件を問わず果たした扱いだった（7f73dc32「保証会社の確認」が物件の送付で閉じた）。
//   PROMISE_DROP_CHECK_OBJECT（既定 on・止める =off・2026-11-23 統括役の決め）の時は、カレンダー（promise-calendar.planPromiseCompletion）と同じ照らしに寄せる:
//   ・約束の要件（呼ぶ側が渡す checkObjectOf＝action-ledger.confirmObjectOf）が募集状況・空室・番手・相手だけ（管理会社 等）・要件なしなら今まで通り
//   ・ほかの要件（保証会社・入居時期・ペット・退去・駐車場・初期費用 …）は、その要件に答えたこちらの文（AIX でも手打ちでも・要件が合う・約束の言い直しでない）でだけ果たした。
//     初期費用・割引の確認は御見積書（AIX・手打ちの送付）でも果たした。物件の送付・物件の AIX では閉じない
export const promiseDropCheckObjectOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.PROMISE_DROP_CHECK_OBJECT ?? "").trim().toLowerCase() !== "off"; // 2026-11-23 統括役の決め: 既定 on（14日で悪化0・守り）。止める =off
export type CheckObjectOf = (text: string) => string | null;
const VACANCY_OBJ_RE = /募集状況|空室|空き|番手/;
const PARTY_OBJ_RE = /^(?:管理会社|オーナー|大家|確認事項|確認結果)/;
const OBJ_SYNONYMS: ReadonlyArray<ReadonlyArray<string>> = [["保証会社", "審査"]];
const objMatch = (a: string, b: string) => a.includes(b) || b.includes(a) || OBJ_SYNONYMS.some((g) => g.some((x) => a.includes(x)) && g.some((x) => b.includes(x)));
/** 要件で絞る確認の約束か（絞らないなら null） */
export function narrowCheckObject(promiseText: string | null | undefined, checkObjectOf: CheckObjectOf | undefined): string | null {
  if (!checkObjectOf || !promiseText) return null;
  const obj = checkObjectOf(promiseText);
  if (!obj || VACANCY_OBJ_RE.test(obj) || PARTY_OBJ_RE.test(obj)) return null;
  return obj;
}
export function promiseFulfilledBy(promise: { at: string; kind: PromiseKindName; text?: string | null }, ev: PromiseEvidence, o: { checkObjectOf?: CheckObjectOf; env?: Env } = {}): { by: string; at: string } | null | "n/a" {
  if (promise.kind === "contact" || promise.kind === "negotiate") return promiseContactKindOn(o.env) ? promiseContactFulfilledBy({ at: promise.at, kind: promise.kind }, ev) : "n/a";
  if (!PROMISE_KIND_JUDGEABLE.has(promise.kind)) return "n/a";
  const t0 = Date.parse(promise.at);
  const after = (iso: string | null | undefined) => !!iso && Date.parse(iso) > t0;
  const narrowObj = promise.kind === "check" ? narrowCheckObject(promise.text, o.checkObjectOf) : null;
  if (narrowObj) {
    const cands: Array<{ by: string; at: string }> = [];
    const costObj = /初期費用|割引|見積/.test(narrowObj);
    for (const m of ev.msgs) {
      if (m.sender !== "staff" || !after(m.created_at)) continue;
      const t = String(m.text ?? "").normalize("NFKC");
      const reObj = o.checkObjectOf!(t);
      const answered = !!reObj && objMatch(narrowObj, reObj) && (CHECK_ANSWERED_RE.test(t) || !/させて(?:頂|いただ)きます/.test(t));
      if (answered) cands.push({ by: m.is_aix_generated ? "aix_text:object" : "staff_text:object", at: m.created_at });
      else if (costObj && (ESTIMATE_SENT_RE.test(t) || (m.is_aix_generated && /御見積書|お見積(?:もり|り)?書?/.test(t)))) cands.push({ by: "estimate_text", at: m.created_at });
    }
    if (costObj) for (const a of ev.aix) { const at = a.sent_at ?? a.created_at; if (after(at) && /estimate/.test(String(a.aix_type ?? ""))) cands.push({ by: `aix:${a.aix_type}`, at }); }
    return cands.sort((x, y) => x.at.localeCompare(y.at))[0] ?? null;
  }
  const re = promise.kind === "estimate" ? /estimate/ : FULFIL_AIX;
  const cands: Array<{ by: string; at: string }> = [];
  for (const a of ev.aix) { const at = a.sent_at ?? a.created_at; if (after(at) && re.test(String(a.aix_type ?? ""))) cands.push({ by: `aix:${a.aix_type}`, at }); }
  if (promise.kind !== "estimate") for (const s of ev.sent) if (after(s.sent_at)) cands.push({ by: "sent_properties", at: s.sent_at as string });
  if (promise.kind === "check") for (const m of ev.msgs) if (m.sender === "staff" && !m.is_aix_generated && after(m.created_at) && CHECK_ANSWERED_RE.test(String(m.text ?? "").normalize("NFKC"))) cands.push({ by: "staff_text", at: m.created_at });
  // 2026-11-21 作業員N の B1 の数え（見積の約束2つが AIX 無しで「果たしていない」）: こちらの手打ちの文で御見積書を送った番も果たした
  //   （「御見積書となります」「お見積りお送りさせて頂きました」。「作成させて頂きます」は約束なので数えない。画像だけの送付は中身が分からないので数えない）
  if (promise.kind === "estimate") for (const m of ev.msgs) if (m.sender === "staff" && !m.is_aix_generated && after(m.created_at) && ESTIMATE_SENT_RE.test(String(m.text ?? "").normalize("NFKC"))) cands.push({ by: "staff_text", at: m.created_at });
  // 2026-11-21 作業員N の確かめ（a260169b）: グループに出た物件を、竹内さんが LINE で手で送った番（AIX も送付の記録も無い）。
  //   こちらの手打ちの文に「新着で出」「オススメ出来るお部屋となります」「こちらのお部屋如何でしょうか」等があれば果たした（画像だけは数えない）
  if (promise.kind === "pickup") for (const m of ev.msgs) if (m.sender === "staff" && !m.is_aix_generated && after(m.created_at) && PICKUP_SENT_RE.test(String(m.text ?? "").normalize("NFKC"))) cands.push({ by: "staff_text", at: m.created_at });
  // 穴3（作業員N）: 見積を確認の結果の AIX（物件確認した）に同封した番＝こちらの AIX の文に「御見積書」「初期費用」があれば果たした
  if (promise.kind === "estimate") for (const m of ev.msgs) if (m.sender === "staff" && m.is_aix_generated && after(m.created_at) && /御見積書|お見積(?:もり|り)?書?|初期費用/.test(String(m.text ?? "").normalize("NFKC"))) cands.push({ by: "aix_text", at: m.created_at });
  return cands.sort((x, y) => x.at.localeCompare(y.at))[0] ?? null;
}
// ─── 2026-11-25 作業員L（台帳 #726・統括役の割り振り）: 連絡・交渉の約束の種類と果たした印（PROMISE_CONTACT_KIND・既定 off）───
//   今は「ご連絡させて頂きます」「お伝えさせて頂きます」「交渉させて頂きます」が other（果たした判定なし）か、確認（check・WIDE の網）に混ざる。
//   種類: contact＝相手（お客様・管理会社）へ後で知らせる約束（ご連絡・ご共有・お伝え・ご報告）／negotiate＝管理会社・大家への交渉（減額・値下げ・条件）。
//     ほかの網（pickup・check・estimate・viewing_slot・callback）が先・ここは other に落ちる物だけ
//   果たした印（決定論・こちらの通だけ・約束の後）:
//     contact … こちらの通（手打ち・AIX）のうち、知らせた形の文（〜となります・〜でした・〜との事・ご連絡頂き・確認取れ・お伝えしました 等）か、
//               結果を運ぶ AIX（確認の結果・物件・見積）
//     negotiate … 交渉の結果の文（交渉の結果・減額／値下げ／割引 頂け・できました・難しい・不可・了承）か、見積の AIX（交渉の後の御見積書）
//   on で: promiseKindNameOf がこの2つを返し、promiseFulfilledBy が判定する（B1・約束の一生・見張りの数え）。スタッフの画面・LINE には出さない（記録だけ）
export const promiseContactKindOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.PROMISE_CONTACT_KIND ?? "").trim().toLowerCase() !== "off"; // 2026-11-26 統括役の決め: 果たした扱いの確かめ（9件中 果たしていないのに果たした 0・網を2回絞った）の後に既定 on。止める =off
export function promiseContactKindOf(clause: string): "contact" | "negotiate" | null {
  const t = String(clause ?? "").normalize("NFKC");
  if (/交渉(?:を)?(?:して(?:みます|参ります)|させて(?:頂|いただ)|致します|いたします)/.test(t)) return "negotiate";
  // 2026-11-26 作業員L（#726 の確かめ・B1 の果たした 6件を読んだ）: 説明の文（「お申込み後の流れ」）・ずっと続く知らせ（「審査の進捗状況等もご連絡」「随時」「何かあれば」）は期日のある約束ではない
  if (/流れ|進捗|随時|何か(?:あれば|ございましたら)|等も|などもご連絡/.test(t)) return null;
  //   管理会社・大家に「共有／お伝え」するだけ（お客様に結果を知らせる約束ではない・84b560f4）も外す
  if (/(?:管理会社|オーナー|大家)(?:様|さん)?(?:に|へ)(?:も)?(?:ご)?(?:共有|お伝え)/.test(t) && !/ご連絡|ご報告/.test(t)) return null;
  if (/(?:ご連絡|ご共有|共有|お伝え|ご報告)(?:を)?(?:させて(?:頂|いただ)|致します|いたします|差し上げます)/.test(t)) return "contact";
  return null;
}
// 2026-11-26 作業員L（#726 の確かめ）: 「〜となります」「でした」だけでは果たした扱いにしない（6件中 3件が別の話の「募集中となります」等で果たした扱いになっていた）。
//   知らせた形の文＝確かめた結果の言い方（確認しましたところ・との事・ご回答・お待たせ致しました・ご報告・結果・確認が取れ・確認出来ました）だけ
const CONTACT_DONE_RE = /確認(?:させて(?:頂|いただ)き|致し|いたし|し)ましたところ|との(?:事|こと)|ご回答|お待たせ(?:致|いた)?しました|ご報告(?:致|いた)?します|結果|(?:確認|連絡)が取れ|確認(?:が)?(?:出来|でき)ました/;
const NEGOTIATE_DONE_RE = /交渉(?:の)?結果|(?:減額|値下げ|割引|値引き|免除|無料)[^。！!？?\n]{0,10}(?:頂け|いただけ|して(?:頂|いただ)け|出来|でき|になり|となり|して下さ|してくださ)|(?:了承|承諾|OK)(?:を)?(?:頂|いただ|が出|でした)|難しい|不可|NG|(?:通り|通っ)ました/;
export function promiseContactFulfilledBy(promise: { at: string; kind: "contact" | "negotiate" }, ev: PromiseEvidence): { by: string; at: string } | null {
  const t0 = Date.parse(promise.at);
  const after = (iso: string | null | undefined) => !!iso && Date.parse(iso) > t0;
  const cands: Array<{ by: string; at: string }> = [];
  const re = promise.kind === "negotiate" ? NEGOTIATE_DONE_RE : CONTACT_DONE_RE;
  for (const m of ev.msgs) {
    if (m.sender !== "staff" || !after(m.created_at)) continue;
    if (re.test(String(m.text ?? "").normalize("NFKC"))) cands.push({ by: m.is_aix_generated ? "aix_text" : "staff_text", at: m.created_at });
  }
  const aixRe = promise.kind === "negotiate" ? /estimate/ : /check_result|property|recommend|estimate/;
  for (const a of ev.aix) { const at = a.sent_at ?? a.created_at; if (after(at) && aixRe.test(String(a.aix_type ?? ""))) cands.push({ by: `aix:${a.aix_type}`, at }); }
  return cands.sort((x, y) => x.at.localeCompare(y.at))[0] ?? null;
}
/** 見張らない会話か（申込以降・お客様が決めた・こちらが締めた）。約束の時刻より後の発言で見る */
export function promiseClosedConversation(status: string | null, msgs: ReadonlyArray<PdMsg>, sinceIso: string): boolean {
  if (status && STOP_STATUS.has(status)) return true;
  const t0 = Date.parse(sinceIso);
  return msgs.some((m) => Date.parse(m.created_at) > t0 && (
    (m.sender === "customer" && STOPPED_RE.test(String(m.text ?? "").normalize("NFKC"))) ||
    (m.sender === "staff" && STAFF_CLOSED_RE.test(String(m.text ?? "").normalize("NFKC")))));
}

/** 同じ番（次のお客様の発言まで）の後ろの通で、条件の用紙（AIX の「ご希望のお部屋探しご条件」）か「ご入力ください」を送った＝お客様の入力待ちの約束（dfa8a68f の形） */
export function promiseInputWaitTurn(ms: ReadonlyArray<PdMsg>, j: number): boolean {
  for (let x = j + 1; x < ms.length && ms[x].sender !== "customer"; x++) {
    const t = String(ms[x].text ?? "").normalize("NFKC");
    if (/ご希望のお部屋探しご条件|ご入力(?:ください|下さい|の程|をお願い|頂けますと)/.test(t)) return true;
  }
  return false;
}

/** 1つの会話の、期限を過ぎて果たしていない約束（全部・同じ種類の言い直しは新しい方1つ）。事実だけ（作業員N の統括の材料 CONDUCTOR_OVERDUE_PROMISES 用） */
export type OverduePromise = { kind: PromiseKindName; promisedAt: string; dueAt: string; dueBy: "words" | "default72h"; daysOver: number };
export function overduePromisesOf(input: Pick<PdInput, "status" | "msgs" | "aix" | "sent">, nowMs: number, o: { maxDays?: number; checkObjectOf?: CheckObjectOf } = {}): OverduePromise[] {
  const maxDays = o.maxDays ?? PROMISE_DROP_MAX_DAYS;
  const ms = [...input.msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byKind = new Map<PromiseKindName, { at: string; text: string }>();
  for (let j = 0; j < ms.length; j++) {
    const m = ms[j];
    if (m.sender !== "staff" || m.is_aix_generated || promiseInputWaitTurn(ms, j)) continue;
    const k = promiseKindNameOf(String(m.text ?? ""));
    if (!k || !PROMISE_KIND_JUDGEABLE.has(k)) continue;
    // 種類ごとに一番新しい約束1つ（果たす前の言い直しは新しい方にまとまる・果たした後の新しい約束も新しい方を見る）
    byKind.set(k, { at: m.created_at, text: String(m.text ?? "") });
  }
  const out: OverduePromise[] = [];
  for (const [kind, p] of byKind) {
    const t0 = Date.parse(p.at);
    if ((nowMs - t0) / 864e5 > maxDays) continue;
    if (promiseOpenEnded(p.text)) continue; // #660: 期日の無い約束（新着で出次第）は期日超えにしない
    const due = promiseDeadlineMs(promiseSentenceOf(p.text), t0, kind);
    if (nowMs < due.ms) continue;
    if (promiseFulfilledBy({ at: p.at, kind, text: p.text }, { msgs: ms, aix: input.aix, sent: input.sent }, { checkObjectOf: o.checkObjectOf })) continue;
    if (promiseClosedConversation(input.status, ms, p.at)) continue;
    out.push({ kind, promisedAt: p.at, dueAt: new Date(due.ms).toISOString(), dueBy: due.by, daysOver: Math.floor((nowMs - due.ms) / 864e5) });
  }
  return out.sort((a, b) => a.promisedAt.localeCompare(b.promisedAt));
}

/**
 * 2026-11-27 作業員L（作業員A の #808 時間の地図の入力・分け目は A と決めた）: まだ果たしていない約束を、期限前の物も含めて（純関数）。
 *   overduePromisesOf と同じ数え方（種類ごとに一番新しい約束・期日の無い約束は外す・果たした約束・閉じた会話は外す）で、期限を過ぎたかを overdue に。
 *   形は A の PromiseDue（{ kind, promisedAt, dueAt, overdue }・ISO）に dueBy を足した物
 */
export type PromiseDue = { kind: PromiseKindName; promisedAt: string; dueAt: string; dueBy: "words" | "default72h"; overdue: boolean };
export function openPromisesWithDue(input: Pick<PdInput, "status" | "msgs" | "aix" | "sent">, nowMs: number, o: { maxDays?: number; checkObjectOf?: CheckObjectOf } = {}): PromiseDue[] {
  const maxDays = o.maxDays ?? PROMISE_DROP_MAX_DAYS;
  const ms = [...input.msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byKind = new Map<PromiseKindName, { at: string; text: string }>();
  for (let j = 0; j < ms.length; j++) {
    const m = ms[j];
    if (m.sender !== "staff" || m.is_aix_generated || promiseInputWaitTurn(ms, j)) continue;
    const k = promiseKindNameOf(String(m.text ?? ""));
    if (!k || !PROMISE_KIND_JUDGEABLE.has(k)) continue;
    byKind.set(k, { at: m.created_at, text: String(m.text ?? "") });
  }
  const out: PromiseDue[] = [];
  for (const [kind, p] of byKind) {
    const t0 = Date.parse(p.at);
    if ((nowMs - t0) / 864e5 > maxDays) continue;
    if (promiseOpenEnded(p.text)) continue;
    const due = promiseDeadlineMs(promiseSentenceOf(p.text), t0, kind);
    if (promiseFulfilledBy({ at: p.at, kind, text: p.text }, { msgs: ms, aix: input.aix, sent: input.sent }, { checkObjectOf: o.checkObjectOf })) continue;
    if (promiseClosedConversation(input.status, ms, p.at)) continue;
    out.push({ kind, promisedAt: p.at, dueAt: new Date(due.ms).toISOString(), dueBy: due.by, overdue: nowMs >= due.ms });
  }
  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export type PromiseDrop = {
  conversationId: string; customerName: string | null; kind: PdKind; promisedAt: string; days: number;
  /** 約束の後にお客様の発言があったか（お礼1回で黙った等） */
  customerSpokeAfter: boolean;
  /** 約束の後に取り下げた要対応の数（ブレインが立てたがスタッフが外した） */
  dismissedAfter: number;
  /** 約束の後に作られ、まだ送っていない売上サポの候補の数 */
  readyPicksAfter: number;
};

/** 1つの会話: 一番新しい約束が 72時間を過ぎて果たされていなければ1件（それ以外は null） */
export function promiseDropOf(input: PdInput, nowMs: number, o: { minH?: number; maxDays?: number; checkObjectOf?: CheckObjectOf } = {}): PromiseDrop | null {
  if (input.status && STOP_STATUS.has(input.status)) return null;
  const minH = o.minH ?? PROMISE_DROP_MIN_H, maxDays = o.maxDays ?? PROMISE_DROP_MAX_DAYS;
  const ms = [...input.msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let promise: { at: string; kind: PdKind; text: string } | null = null;
  for (let j = 0; j < ms.length; j++) {
    const m = ms[j];
    if (m.sender !== "staff" || m.is_aix_generated || promiseInputWaitTurn(ms, j)) continue;
    const k = promiseDropKindOf(String(m.text ?? ""));
    if (k) promise = { at: m.created_at, kind: k, text: String(m.text ?? "") };
  }
  if (!promise) return null;
  const t0 = Date.parse(promise.at);
  const ageH = (nowMs - t0) / 36e5;
  // 期限（作業員N の B1 と同じ）: 文の期限の言葉の日の終わり／無ければ 72時間。minH を渡された時はそれを使う（テスト）
  if (o.minH == null && promiseOpenEnded(promise.text)) return null; // #660: 期日の無い約束は見張りに出さない
  const due = o.minH != null ? t0 + minH * 36e5 : promiseDeadlineMs(promiseSentenceOf(promise.text), t0, promise.kind).ms;
  if (!(nowMs >= due) || ageH > maxDays * 24) return null;
  const after = (iso: string | null | undefined) => !!iso && Date.parse(iso) > t0;
  if (promiseFulfilledBy({ at: promise.at, kind: promise.kind, text: promise.text }, { msgs: ms, aix: input.aix, sent: input.sent }, { checkObjectOf: o.checkObjectOf })) return null;
  if (promiseClosedConversation(input.status, ms, promise.at)) return null;
  const custAfter = ms.filter((m) => m.sender === "customer" && after(m.created_at));
  return {
    conversationId: input.conversationId, customerName: input.customerName, kind: promise.kind, promisedAt: promise.at,
    days: Math.floor(ageH / 24), customerSpokeAfter: custAfter.length > 0,
    dismissedAfter: input.items.filter((i) => i.status === "dismissed" && after(i.created_at)).length,
    readyPicksAfter: input.picks.filter((p) => after(p.created_at) && !p.sent_at && !p.expired_at && (p.status ?? "pending") === "pending").length,
  };
}

/** 売上番長グループに出す文（対象が無ければ null）。古い順・最大 maxLines 行 */
export function buildPromiseDropPost(drops: ReadonlyArray<PromiseDrop>, nowMs: number, maxLines = 20): string | null {
  if (!drops.length) return null;
  const d = new Date(nowMs + 9 * 3600_000);
  const head = `【AIX要対応・お約束した物件がまだ届いていません】${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const sorted = [...drops].sort((a, b) => a.promisedAt.localeCompare(b.promisedAt));
  const lines = sorted.slice(0, maxLines).map((x) => {
    const button = aixButtonText(x.kind === "pickup" ? "property_send" : "property_check_result");
    const notes = [`お約束から${x.days}日`, x.readyPicksAfter ? `候補${x.readyPicksAfter}件あり` : "", x.dismissedAfter ? "要対応を外した後" : ""].filter(Boolean).join("・");
    return `・${x.customerName || "お客様"}さん → ${button}（${notes}）`;
  });
  return [head, "", ...lines, "", `${drops.length}件${drops.length > maxLines ? `（古い順に${maxLines}件）` : ""}。送ったら自動で外れます`].join("\n");
}

/** 1日1回か（その日にまだ出していない時だけ・JST の日付） */
export function promiseDropDue(lastIso: string | null | undefined, nowMs: number): boolean {
  if (!lastIso) return true;
  const day = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  const last = Date.parse(lastIso);
  return !Number.isFinite(last) || day(last) < day(nowMs);
}
