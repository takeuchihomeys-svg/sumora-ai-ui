// app/lib/aix-should-be.ts — 手打ちの文・AIX の送信を「本来はどの AIX のどのボタン×ピッカーで送る物か」に当てはめる（純関数・DB/LLM なし）
//
// なぜ（竹内さん 10/22 d04ed51b・76c249e0・aad87f41）:
//   ・スタッフ（と時々竹内さん）は AIX で送るべき所を手打ちで送る・押し間違える。押した記録は正解にしない（竹内基準）。
//   ・ボタン×ピッカーの意味は定義（aix-catalog の staffOnly・when／aix-confirm-items の確認事項／aix-meaning-learn の話題）と
//     竹内さんの AIX の送信から決まる。その意味で文を読み「本来の AIX」に当てはめる。
// 使う所:
//   ①見張りの採点（line-watch-judge）: スタッフが手打ち・押し間違いでも、ブレインの選んだ AIX が本来の AIX と同じなら正解に数える（same_via_mapping）
//   ②意味の学び（scripts/learn-aix-meanings.ts）: 竹内さんの手打ちで本来の AIX がはっきりした文を、そのピッカーのお手本の候補に足す
//   ③検証（scripts/audit-aix-should-be.ts）: 竹内さん自身の AIX の送信（押したボタン×ピッカー＝ラベル）で正解率を測る
// 当てはめは「はっきりした物だけ」（当たらない＝null＝返信でよい・判断しない）。約束だけの文（確認させて頂きます）は当てない（AIX は結果が出てから）。
import { contentTopicsOf } from "./aix-meaning-learn";
import { AIX_CONFIRM_ITEMS, CONFIRM_REPORT_RE } from "./aix-confirm-items";

export type ShouldBeAix = {
  /** aix-catalog の鍵（ボタン か ボタン/ピッカー） */
  key: string;
  button: string;
  picker: string | null;
  /** strong＝定型の形・はっきりした中身／weak＝中身は合うが他の読みもある */
  strength: "strong" | "weak";
  why: string;
  /** 同じ文に入っている他の AIX の中身（鍵） */
  also: string[];
};
export type ShouldBeMode = "hand" | "aix";

const N = (s: string) => String(s ?? "").normalize("NFKC");
/** 約束だけ（結果を言っていない）＝AIX ではなく約束の返信 */
const PROMISE_RE = /確認させて(?:頂|いただ)きます|確認(?:出来|でき)次第|お調べ(?:致|いた)します|お問い合わせ(?:致|いた)します|作成し(?:て)?お送りさせて(?:頂|いただ)きます|ピックアップし(?:て)?お送りさせて(?:頂|いただ)きます|(?:出来|でき)次第(?:ご連絡|お送り)/;
/** 結果の言い切り（確認した結果を伝えている形） */
const RESULT_END_RE = /となります|となっております|となっていました|でした|ございます|御座います|可能です|不可|出来ません|できません|との(?:事|こと)|ておりました|しております|募集中/;
const TIME_RE = /[0-9]{1,2}\s*[:：時][0-9]{0,2}/;
const DATE_RE = /[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}|本日|明日/;
/** 新着の物件の知らせ（内覧の候補日ではない） */
const NEW_LISTING_RE = /新着[^\n。]{0,30}(?:お部屋|物件)(?:が)?募集に(?:で|出)ました|[0-9]件新着|新着で[0-9]件/;

type Hit = { key: string; strength: "strong" | "weak"; why: string };

/** 物件確認した（結果・条件）のピッカー。結果の報告の形がある時だけ */
function checkResultHits(t: string, mode: ShouldBeMode): Hit[] {
  const out: Hit[] = [];
  const report = CONFIRM_REPORT_RE.test(t) || /お待たせ(?:致し|いたし)ました/.test(t) || /管理会社(?:様|担当者?)?(?:に|へ)(?:確認|問い合わせ)/.test(t);
  const ends = RESULT_END_RE.test(t);
  const promiseOnly = PROMISE_RE.test(t) && !CONFIRM_REPORT_RE.test(t);
  if (promiseOnly) return out;
  if (/(?:\(|（)室内(?:イメージ|写真|画像|動画)(?:\)|）)/.test(t) || (/室内(?:の)?(?:写真|画像|動画|イメージ)/.test(t) && (report || /https?:\/\//.test(t)))) out.push({ key: "property_check_result/interior_photo", strength: "strong", why: "室内の写真・イメージ" });
  const ok = /[0-9０-９一二]\s*番手(?:以降)?(?:で|に)(?:の)?(?:お申し?込み?|ご案内|受付)|募集中|募集(?:して|されて)(?:おり|い)|ご紹介(?:が)?可能|空いて(?:おり|い)/.test(t);
  const ng = /募集(?:が)?終了|満室|埋まって|ご紹介(?:が)?(?:出来|でき)(?:ない|ません|かねます)|募集(?:されて|して)(?:い)?ない|募集に出て(?:い)?ない|募集に出ておりません|成約/.test(t);
  const avail = report || /現在|お送り(?:頂|いただ)きました/.test(t);
  if (/専任/.test(t) && (ng || report)) out.push({ key: "property_check_result/exclusive", strength: "strong", why: "専任（紹介できない）" });
  else if (ok && /のみ募集中|他の(?:お)?部屋は募集されて/.test(t)) out.push({ key: "property_check_result/other_room_check", strength: "strong", why: "その部屋だけ募集中" });
  else if (ok && /(?:別|他)の(?:間取り|階|お部屋|部屋)|こちらの[^\n。]{0,10}号室が[^\n。]{0,20}募集中/.test(t) && avail) out.push({ key: ng ? "property_check_result/alternative" : "property_check_result/other_room_check", strength: ng ? "strong" : "weak", why: "別の部屋の募集" });
  else if (ng && !ok && avail) out.push({ key: "property_check_result/unavailable", strength: report ? "strong" : "weak", why: "募集終了の結果" });
  else if (ok && avail && (report || /現在募集中|お送り(?:頂|いただ)きました|番手/.test(t))) out.push({ key: "property_check_result/available", strength: report ? "strong" : "weak", why: "募集中の結果" });
  if (/[0-9]番手/.test(t) && !out.length && (report || ends)) out.push({ key: "property_check_result/mgmt_application_status", strength: "weak", why: "申込の番手" });
  // 条件・交渉（確認事項の網＋報告の形）。手打ちは報告の形を必ず求める（資料・会話で答えられる事を手打ちで返すのは返信）
  if (report || (mode === "aix" && ends)) {
    for (const c of AIX_CONFIRM_ITEMS) {
      if (!c.key.startsWith("property_check_result/") || out.some((o) => o.key === c.key)) continue;
      if (/\/(?:available|vacate_date|interior_photo|other_room_check|room_vacancies|mgmt_application_status)$/.test(c.key)) continue;
      if (!c.re.test(t)) continue;
      out.push({ key: c.key, strength: report ? "strong" : "weak", why: `確認事項: ${c.items[0]}` });
    }
    if (/退去(?:予定)?日|退去予定/.test(t) && /入居|ご案内|内覧/.test(t) && !out.some((o) => o.key.endsWith("mgmt_move_in"))) out.push({ key: "property_check_result/mgmt_move_in", strength: "weak", why: "退去予定と入居" });
  }
  // 入居日と退去日は1つに（入居できる日を伝える＝mgmt_move_in）
  const mi = out.findIndex((o) => o.key.endsWith("/mgmt_move_in"));
  if (mi >= 0) for (let i = out.length - 1; i >= 0; i--) if (out[i].key.endsWith("/vacate_date")) out.splice(i, 1);
  return out;
}

/**
 * 文 → 本来の AIX（無ければ null）。mode="hand" は手打ちの文（AIX の定型の形でなくてよいが、約束・聞き返しだけは当てない）、
 *   mode="aix" は AIX の送信の文（押したボタンを見ずに中身だけで読む）。
 */
export function shouldBeAixOf(textIn: string | null | undefined, o: { mode?: ShouldBeMode } = {}): ShouldBeAix | null {
  const mode = o.mode ?? "hand";
  const t = N(textIn ?? "").trim();
  if (t.replace(/\s/g, "").length < (mode === "aix" ? 12 : 20)) return null;
  const hits: Hit[] = [];
  const add = (key: string, strength: Hit["strength"], why: string) => { if (!hits.some((h) => h.key === key)) hits.push({ key, strength, why }); };
  const topics = contentTopicsOf(t);
  const has = (k: Parameters<typeof topics.includes>[0]) => topics.includes(k);
  const yen = (t.match(/[\d,]{3,}\s*円/g) ?? []).length;

  // ── 定型（フォーム・固定の型） ──
  if (/記入欄/.test(t) && /・\s*(?:氏名|お名前|生年月日)/.test(t)) add("application_push/format", "strong", "申込フォーマット");
  if (/本人確認書類|運転免許証|マイナンバー/.test(t) && /お申込み?(?:を)?完了|ご提出|お送り(?:頂|いただ)き次第/.test(t) && !/記入欄/.test(t)) add("application_push/docs_request", "strong", "申込の書類のお願い");
  if ((/[①1][^\n]{0,20}(?:ご?入居(?:の)?時期|ご希望(?:の)?家賃)/.test(t) && /[③3][^\n]{0,20}(?:間取り|広さ)/.test(t)) || /ご希望のお部屋探し(?:ご)?条件/.test(t)) add(/^[^\n]{0,4}[(（][^\n]{0,30}ご条件[)）]/.test(t) && t.length < 400 ? "condition_hearing/form_only" : "condition_hearing", "strong", "条件ヒアリングのフォーム");
  if (/電話をかけるボタン/.test(t)) add("phone_call", "strong", "電話のボタン");
  else if (/お電話(?:を)?(?:お)?(?:かけ|掛け)(?:て)?(?:ください|下さい)/.test(t)) add("phone_call", "weak", "電話のお願い");
  if (/お申込み?(?:が)?完了していない状況/.test(t)) add("followup_revive", "strong", "申込が完了していない追客");
  if (/代表(?:に|へ)確認させて(?:頂|いただ)きます|代表からの(?:許可|返事|回答)/.test(t)) add("acknowledge_check/daihyo_initial_cost", "strong", "代表に初期費用の確認");
  if (/お部屋(?:お)?探し(?:は)?(?:継続|お続け)(?:され|して)(?:て)?(?:い)?(?:ます|らっしゃい)/.test(t)) add("followup_revive/search_continue", "strong", "お部屋探しの継続の確認");

  // ── 1件の推し（御見積書の同封・節約の文を含むので費用より先） ──
  const recForm = /(?:\(|（)オススメポイント(?:\)|）)/.test(t) || /^🌟/.test(t);
  if (recForm) {
    const v = /中でも|お送りさせて(?:頂|いただ)(?:き|い)(?:まし)?たお部屋の中/.test(t) ? "継続ピックアップ" : /新着|新た(?:に|な)|募集に(?:で|出)ました|退去予定/.test(t) ? "新着1件" : /代替/.test(t) ? "代替ピックアップ" : "新規ピックアップ";
    add(`property_recommendation/${v}`, "strong", "1件の推し（オススメポイント）");
  }
  // ── 費用 ──
  const estimateForm = /初期費用\s*[:：]\s*[\d,]+\s*円/.test(t) || (yen >= 1 && /割引させて(?:頂|いただ)き|節約(?:出来|でき)/.test(t));
  if (!recForm && (estimateForm || (has("estimate") && yen >= 3))) {
    const multi = (t.match(/【[^】]+】/g) ?? []).length >= 2 || /[②2]\s*【/.test(t);
    add(`estimate_sheet/${multi ? "multi" : "single"}`, estimateForm ? "strong" : "weak", "御見積書の金額");
  }
  if (/貸主(?:様)?から[^\n。]{0,12}(?:手数料|報酬|広告料)|還元させて(?:頂|いただ)/.test(t)) add("cost_explain", "strong", "初期費用が安い仕組み");
  if (/初期費用/.test(t) && yen >= 1 && /含め(?:させて|て)|込み|翌月分|前家賃|日割/.test(t) && !estimateForm) add("cost_breakdown", "weak", "初期費用の内訳");

  // ── 内覧 ──
  const candidates = /ご都合|ご案内(?:可能|出来|でき)(?:です|ます)|候補|お日にち|お時間(?:が)?空いて/.test(t);
  const meet = /待ち合わせ|現地エントランス|現地集合/.test(t);
  if (meet && TIME_RE.test(t) && !/ご都合(?:よろしい|如何|いかが)/.test(t)) add("meeting_place", "strong", "内覧の確定と待ち合わせ");
  else if (/(?:ご案内|ご内覧|内見)/.test(t) && (TIME_RE.test(t) || DATE_RE.test(t)) && candidates && !NEW_LISTING_RE.test(t)) {
    const m = /退去予定/.test(t) ? "退去予定物件" : /変更/.test(t) ? "日程変更" : /^(?:[^\n]{0,20}(?:さん|様)\s*)?(?:かしこまりました|もちろんです|承知(?:致し|いたし)ました)/.test(t) ? "内覧日指定あり" : "通常";
    add(`viewing_invite/${m}`, "strong", "内覧の候補日");
  }
  if (/本日[^\n。]{0,12}[0-9]{1,2}\s*[:：時][0-9]{0,2}\s*(?:より|から)[^\n。]{0,10}ご案内/.test(t) && !candidates) add("greeting_viewing/before", "strong", "内覧の当日の挨拶");

  // ── 物件 ──
  const sendForm = /[0-9０-９一二三四五六七八九]+\s*(?:件|部屋)(?:が)?(?:のみ)?(?:募集中|募集に(?:で|出)て)|[0-9]+部屋(?:のみ)?となります|(?:募集中|募集に(?:で|出)て(?:おり|い))[^\n。]{0,8}(?:でした|ました)ので(?:お)?送り|ピックアップさせて(?:頂|いただ)きました|[0-9]+件(?:の)?(?:お部屋|物件)?(?:が)?(?:新着で)?(?:募集に)?(?:で|出)(?:ました|ております|ています)|お部屋[0-9]+件|(?:全て|すべて)(?:お)?探(?:し)?させて(?:頂|いただ)きました|お探しさせて(?:頂|いただ)きました/.test(t) || (/こちら(?:の)?[0-9]+(?:件|部屋)/.test(t) && !/お送り(?:頂|いただ)きました|募集状況|確認させて/.test(t));
  if (sendForm && !recForm) {
    const v = /代替/.test(t) ? "alternative" : /新着|新た(?:に|な)|募集に(?:で|出)ました/.test(t) ? "new_arrival" : /広げ|も含めて|範囲を広|以内(?:の|に)?(?:エリア|に抑え)|乗り継ぎ/.test(t) ? "widen" : "normal";
    add(`property_send/${v}`, "strong", "物件の束");
  }

  // ── 確認の結果・条件 ──
  for (const h of checkResultHits(t, mode)) add(h.key, h.strength, h.why);
  if (!recForm && !hits.some((h) => h.key.startsWith("estimate_sheet")) && /御見積書(?:と(?:なり|併せ)|(?:を)?同封|お送り)/.test(t)) add("estimate_sheet/single", "weak", "御見積書の送付");
  // 引き続き探す（確認の結果・物件の束の後に添える事が多い＝他の中身があれば弱い）
  if (/(?:ご満足|ご希望)[^\n。]{0,20}(?:物件|お部屋)(?:が)?(?:募集に)?出て(?:い)?ない|見つかるまで[^\n。]{0,20}(?:全力で)?サポート|出次第(?:すぐに)?[^\n。]{0,20}お送り/.test(t) && !sendForm && !recForm && !/ピックアップし(?:て)?お送り|はじめまして|担当させて(?:頂|いただ)きます/.test(t)) add("zenryoku_support", !hits.length && /出て(?:い)?ない|見つかりませんでした|出次第|入り次第/.test(t) ? "strong" : "weak", "引き続き探す（全力サポート）");
  // 保証会社: 物件の保証会社の確認結果（号室・物件・確認）は mgmt_guarantor・一般の説明は guarantor_info
  if (/保証会社(?:は|が)[^\n。]{1,20}(?:となります|です)/.test(t) && !hits.some((h) => h.key.endsWith("/mgmt_guarantor"))) {
    add(/号室|の保証会社が|確認/.test(t) ? "property_check_result/mgmt_guarantor" : "guarantor_info", "weak", "保証会社の種類");
  }

  // ── 申込の後押し（他の中身が無い時だけ・手打ちの締めに多いので弱い） ──
  if (!hits.length && ((/お申込み?(?:で|し)(?:て)?お部屋(?:を)?(?:抑え|押さえ)/.test(t) && /お気に召され|いつでも|フォーマット/.test(t)) || /お申込み?(?:の)?(?:手続き)?(?:を)?進めさせて|お申込みさせて(?:頂|いただ)きます|[0-9]\s*番手でお申込/.test(t))) add("application_push/push", "weak", "申込の後押し");

  // 確認の結果だが話題が網の外（設備の細かい事・畳の張り替え 等）＝ボタンだけ（他に何も当たらない時だけ・報告の形が要る）
  if (!hits.length && CONFIRM_REPORT_RE.test(t) && RESULT_END_RE.test(t) && !PROMISE_RE.test(t)) add("property_check_result", "weak", "管理会社に確認した結果（話題は網の外）");
  if (!hits.length) return null;
  // 手打ち: 約束だけ（結果・資料・日時を言っていない）は当てない
  if (mode === "hand" && PROMISE_RE.test(t) && hits.every((h) => h.strength === "weak")) return null;
  // 主の1つ: 強い物を先に・同じなら上の順（並べた順＝決まりの順）
  let primary = hits.find((h) => h.strength === "strong") ?? hits[0];
  // 募集の結果＋御見積書の同封は「物件確認した」（aix-pickers の when・竹内さんの送信の 88% が見積を同封）＝結果を主にする
  const result = hits.find((h) => /^property_check_result\/(?:available|alternative|unavailable|other_room_check)$/.test(h.key) && h.strength === "strong");
  if (result && primary.key.startsWith("estimate_sheet")) primary = result;
  const [button, picker] = primary.key.split("/");
  return { key: primary.key, button, picker: picker ?? null, strength: primary.strength, why: primary.why, also: hits.filter((h) => h !== primary).map((h) => h.key) };
}

/** 本来の AIX のボタンの全部（主＋同じ文の他の中身） */
export function shouldBeButtons(s: ShouldBeAix | null): string[] {
  if (!s) return [];
  return [...new Set([s.key, ...s.also].map((k) => k.split("/")[0]))];
}

/** 見張りの採点で本来の AIX を使うか（既定 on・止める LINE_WATCH_AIX_MAPPING=off） */
export function watchAixMappingEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LINE_WATCH_AIX_MAPPING ?? "").trim().toLowerCase() !== "off";
}
