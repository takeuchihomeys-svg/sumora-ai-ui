// app/lib/staff-confirm-facts.ts
// 「スタッフしか確かめられない事実」に頼る文は自動で送らない（AIX でスタッフが送る所で止める）— 純関数・DB 依存なし。
//
// 2026-10-02 竹内さんの決定「スタッフの確認が要る物は AIX で止める」:
//   空き状況・物件確認の結果・見積書（金額）・待ち合わせの住所・内覧の確定・申込の形式（同居人の有無）など、
//   管理会社・見積書ツール・カレンダー・お客様への確認でしか分からない事実は、自動の道（自動返信 canAutoReply・
//   今後の AIX の自動送信）では送らない。スタッフが AIX を開き、確かめた事を入れてから送る。
//
// 2つの入口:
//   ① AIX の種類で止める（aixAutoSendGate）: 下の STAFF_CONFIRM_AIX の AIX は「入力なしで文が作れても」自動では送らない。
//      aix-autofill-readiness（⑦の自動反映の度合い）は「作れるか」、こちらは「送ってよいか」＝別の問い。
//   ② 返信の本文で止める（findStaffOnlyFact）: AIX なしの自動返信の下書きが、スタッフしか知らない事実を言い切っていたら送らない
//      （作り話の空き状況・金額・住所・確定日時）。止めるだけで本文は書き換えない（＝誤って送る向きの心配が無い・人に残すだけ）。
//      線は scripts/audit-staff-confirm-facts.ts（下書き×実送信）で全部読んで引いた（このファイルの下のコメント）。

/** スタッフの確認が要る AIX と、その確認の中身（画面・ログの日本語） */
export const STAFF_CONFIRM_AIX: Readonly<Record<string, string>> = {
  property_check_result: "物件確認の結果（募集中／終了／退去予定・入居可能日など管理会社に確かめた事）",
  acknowledge_check: "管理会社・代表への確認（確認の宛先と中身）",
  estimate_sheet: "御見積書（見積書ツールの金額）",
  meeting_place: "待ち合わせの住所（番地まで）と確定した日時",
  viewing_invite: "内覧の候補日（カレンダーの空き・管理会社の内覧の可否）",
  application_push: "申込の形式（同居人の有無・緊急連絡先／連帯保証人）",
  cost_explain: "費用の説明の金額（貸主からの報酬・還元額）",
  cost_breakdown: "御見積書の項目と金額",
  guarantor_info: "保証会社の名前と種類（物件ごと）",
  property_send: "送る物件（売上サポのピックアップ・募集状況）",
  property_recommendation: "オススメする物件（募集状況・資料）",
  property_search: "探す物件（Chrome拡張の検索・2026-10-02 ⑫）",
};

export type AutoSendGate = { ok: boolean; reason: string };

/** その AIX を自動で送ってよいか（スタッフの確認が要る AIX は送らない）。知らない AIX も送らない（迷ったら人に残す） */
export function aixAutoSendGate(action: string | null | undefined): AutoSendGate {
  const a = (action ?? "").trim();
  if (!a) return { ok: false, reason: "no_action" };
  if (STAFF_CONFIRM_AIX[a]) return { ok: false, reason: `staff_confirm:${a}` };
  // 確認の要らない AIX（文はフォームや定型・会話だけで決まる）。ただし今はどれも自動では送っていない（スタッフが押す）
  if (["condition_hearing", "phone_call", "followup_revive", "greeting_viewing", "zenryoku_support"].includes(a)) return { ok: true, reason: "no_staff_fact" };
  return { ok: false, reason: `unknown_aix:${a}` };
}

export type StaffOnlyFactHit = { kind: "vacancy" | "estimate_amount" | "meeting_address" | "viewing_fixed"; text: string };

/** 文に分ける（。！!？? と改行） */
function sentences(s: string): string[] {
  return s.split(/(?<=[。！!？?])|\n/).map((x) => x.trim()).filter(Boolean);
}

// ── 線（2026-10-02・scripts/audit-staff-confirm-facts.ts）──
// vacancy: 管理会社に確かめた結果の言い切り（「募集中となります」「空いております」「お申込みが入っており」「募集終了しておりました」）。
//   宣言（「募集状況確認させて頂きます」）・お客様の言葉の復唱の形（「空いていれば」「募集中であれば」）・一般の説明（「申込が入っているお部屋でもご内覧は可能」）は当てない。
//   返信生成の下書き 1,134件（90日）で当たるのは 8件だけ: 空き状況 5（「現在空室となっておりますので」「6件もお申込み入っている」等・スタッフが消した 3）・金額 1・確定日時 2。どれもスタッフが確かめる事実＝止めてよい
const VACANCY_RE = /(?:現在|まだ|引き続き)?(?:募集中|空室|空き部屋)(?:で(?:す|ございます)|となって(?:おり|い)|となります|でした)|空いて(?:おります|います|おりました|いました)(?!か)|(?:お?申し?込み?|申込)(?:が|も)?(?:既に)?(?:入って(?:おり|い|しまい)|入りました|入っております)|募集(?:が)?終了(?:して|となって|しており|でした|となりました|しました)|(?:[0-9０-９]+番手)(?:での|にて)?(?:お申し?込み|申込)(?:可能|となります)/;
const VACANCY_EXCLUDE_RE = /確認(?:させて|して|致し|いたし|出来次第|でき次第)|(?:れ|け)ば|場合|かどうか|でしょうか|ですか|ますか|ご希望|お探し|お部屋でも|物件でも/;
// estimate_amount: 初期費用・総額の金額の言い切り（見積書の数字は見積書ツールの物）
const ESTIMATE_AMOUNT_RE = /(?:初期費用|総額|合計)[^。\n]{0,14}?[0-9０-９][0-9０-９,，]{2,}\s*円|[0-9０-９][0-9０-９,，]{2,}\s*円(?:に|まで)?(?:割引|お値引き|お安く)/;
const ESTIMATE_AMOUNT_EXCLUDE_RE = /(?:れ|け)ば|場合は|以内|以下|程度|前後|くらい|ぐらい|ご予算|ご希望/;
// meeting_address: 待ち合わせ・集合の場所としての住所（〒・番地・丁目＋数字）
const MEETING_ADDRESS_RE = /(?:待ち合わせ|集合|現地)[^。\n]{0,30}(?:〒|[0-9０-９]+丁目|[0-9０-９]+番地?|[0-9０-９]+-[0-9０-９]+)|〒\s*[0-9０-９]{3}-?[0-9０-９]{4}/;
// viewing_fixed: 内覧の日時を確定・予約した言い切り（日付・時刻つき）
const VIEWING_FIXED_RE = /(?:[0-9０-９]{1,2}\s*[\/月]\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}日)[^。\n]{0,20}(?:[0-9０-９]{1,2}[:：時])[^。\n]{0,20}(?:で(?:確定|承り|お取り|ご予約)|確定(?:致し|いたし|し)|ご予約(?:致し|いたし|させて頂き|させていただき)ました|お待ちして)/;

/**
 * 自動で送る返信の下書きが、スタッフしか確かめられない事実を言い切っているか。
 * 当たれば自動では送らない（AIX／スタッフの手に残す）。本文は変えない。
 */
export function findStaffOnlyFact(draft: string | null | undefined): StaffOnlyFactHit | null {
  for (const s of sentences(String(draft ?? ""))) {
    if (VACANCY_RE.test(s) && !VACANCY_EXCLUDE_RE.test(s)) return { kind: "vacancy", text: s };
    if (ESTIMATE_AMOUNT_RE.test(s) && !ESTIMATE_AMOUNT_EXCLUDE_RE.test(s)) return { kind: "estimate_amount", text: s };
    if (MEETING_ADDRESS_RE.test(s)) return { kind: "meeting_address", text: s };
    if (VIEWING_FIXED_RE.test(s)) return { kind: "viewing_fixed", text: s };
  }
  return null;
}

// ── 2026-10-02 ⑫ 11巡目: 会話に無い金額（相場・家賃帯）の言い切りは自動で送らない ──
//   YUMA の再生（10巡目 cost_12・DeepSeek）の下書き「堺筋本町駅周辺は10万円〜11万円台からお部屋が出てきます」が関所を通った
//   （見積金額内訳ゲートは費用の語が無いと見ない・⑪は一般の相場の説明をゲートから外した＝本文は書き換えない）。
//   相場の数字はスタッフが知っている事（人の実送信には普通にある）なので本文は変えず、**自動で送るかどうか**だけを止める（人に残す）。
//   線: 文の金額（N万円・N万・N,NNN円）が、この会話の通・登録の条件・会社の決まった金額（0円・2,980円）のどこにも無い時
const AMOUNT_RE = /([0-9０-９]+(?:[.．][0-9０-９]+)?)\s*万(?:円)?|([0-9０-９][0-9０-９,，]{3,})\s*円/g;
const FIXED_COMPANY_AMOUNTS = new Set(["0", "2980"]);
function toYen(m: RegExpMatchArray): string | null {
  const n = (s: string) => s.normalize("NFKC").replace(/[,，]/g, "");
  if (m[1]) { const v = Math.round(Number(n(m[1])) * 10000); return Number.isFinite(v) ? String(v) : null; }
  if (m[2]) return n(m[2]);
  return null;
}
function amountsIn(t: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(t ?? "").matchAll(AMOUNT_RE)) { const y = toYen(m); if (y) out.add(y); }
  return out;
}
export type UngroundedAmountHit = { text: string; amounts: string[] };
/** 下書きの金額で、会話（groundText）に無い物があれば最初の文を返す。groundText が無い時は判定しない（null） */
export function findUngroundedAmount(draft: string | null | undefined, groundText: string | null | undefined): UngroundedAmountHit | null {
  if (!groundText) return null;
  const ground = amountsIn(groundText);
  // 会話の側は「円」が無い数（お客様のフォームの「65,000まで」「45000~50000」）も金額として読む（11巡目 first_contact_02 で止めすぎた）
  for (const m of String(groundText).normalize("NFKC").matchAll(/(?<![0-9])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})(?![0-9])/g)) ground.add(m[1].replace(/,/g, ""));
  for (const s of sentences(String(draft ?? ""))) {
    const miss = [...amountsIn(s)].filter((a) => !ground.has(a) && !FIXED_COMPANY_AMOUNTS.has(a));
    if (miss.length) return { text: s, amounts: miss };
  }
  return null;
}
