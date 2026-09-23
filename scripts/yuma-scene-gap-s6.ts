// S6「会社の事実の質問」の YUMA 再現（ブレインごと1回 → 60秒以内に生成側 ×3）
//
// 2026-09-23 Fable5.1 実測（竹内「実際の成約データや直近の今月のLINEをお手本にして生成される文にギャップが生まれないか確認する」）
//
// 【設計】scripts/yuma-brain-specific-test.ts（挿入→bg-async→待つ→消す）と scripts/yuma-company-facts-direct.ts
//   （画面と同じ body で generate-reply を直接叩く）を合体。場面は**今月の実物**（scripts/audit-company-facts-month.ts で
//   全件読んで選んだ）から写し、実送信・押した AIX と並べる。
//   ・(i) 自分の控えに restore（前の場面の判断の上に積ませない）
//   ・(ii) 元会話の対象発言までの直近 25 通を YUMA に挿す。created_at は対象＝now−60s に平行移動し、間隔は最大60分に圧縮
//         （YUMA の既存発言 09-22 より新しく保つため）。顧客名は YUMA に置換・image_url は付けない（Vision の費用を避ける）
//   ・(iii) status は当時の ai_reply_examples.conversation_state（無ければ元会話の今の status）
//   ・(iv) arm → bg-async → 待つ → **前提が作れたか**（最新発言・brain_analyzed_at・analyzed_msg_ts）を毎回確認
//   ・(v) 60秒以内に generate-reply を画面と同じ 12 項目で直接（bg-async で下書きが出た回は1回目に数える）
//   ・(vi) 片付け（messages / aix_action_items / automation_commands）→ restore
//
// ⚠ 書き込みあり。YUMA だけ。他の実測エージェントと同時に使わないよう ai_draft_check に印を置き、毎回確かめる。
// 実行: npx tsx --env-file=.env.local scripts/yuma-scene-gap-s6.ts [REPS=3] [ONLY=id,id] [SKIP_BRAIN=1]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { classifySentKind, customerSceneOf } from "../app/lib/sent-shape";
import { isConditionFormMessage, MSG_SEP } from "../app/lib/reply-context";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { detectRecommendApplyLine } from "../app/lib/apply-line-rates";
import { isRentNegotiationPromise } from "../app/lib/rent-negotiation-guard";
import { DRAFT_SKIP_STATUSES } from "../app/lib/conversation-status";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const REPS = Number(process.env.REPS ?? 3);
const RUN_ID = `S6-${Date.now()}`;
const BACKUP = "scripts/.yuma-backup-s6.json";
const OUT = process.env.OUT ?? "scripts/.s6-run.txt";
const COLS = "id, customer_name, status, ai_draft, ai_draft_check, suggested_aix_meta, last_brain_meta, brain_analyzed_at, brain_strategy, draft_pending_at, draft_attempted_at, last_message, last_sender, updated_at";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s = "") => { console.log(s); appendFileSync(OUT, s + "\n", "utf8"); };
const mask = (s: string) => s.replace(/https?:\/\/\S+/g, "[URL]").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]");

type Scene = {
  id: string; fact: string;
  /** 元会話の id の先頭8桁 */
  conv: string;
  /** 対象発言の UTC 時刻の先頭（分まで） */
  at: string;
  /** 対象発言の本文の一部（同じ分に複数ある時の特定用） */
  match: string;
  /** その時スタッフが実際にした事（監査で読んだ物） */
  actual: string;
  want: RegExp; wantNote: string; forbid: RegExp; forbidNote: string;
  /** 誤当たりの場面（事実が渡ってはいけない）＝ want は無く、事実の語が出たら副作用 */
  falsePositive?: boolean;
  /** 会話を写さず、YUMA 自身の履歴の上に1通だけ足す（今月に実物が無い店舗の質問） */
  synthetic?: string;
};

const STORE_WANT = /(オンライン専門|店舗で(は|ではあり)|店舗では(無|な)|ご来社|来店.{0,8}(出来|でき)ない|事務所)/;
const STORE_FORBID = /(店舗|そちら|事務所)[^。\n]{0,16}(お待ちしております|お越しください|ご案内させて|ご相談させて|伺って)/;

const SCENES: Scene[] = [
  { id: "P1 日割(9/20入居なら+日割)", fact: "prorated_rent", conv: "5752c0d1", at: "2026-09-10T07:23", match: "日割り",
    actual: "通常返信（編集）: 審査に1〜2週間・契約1週間で最短2週間／20日入居は確証出来ない（日割には直接答えず）",
    want: /日割/, wantNote: "日割家賃が発生することに触れる", forbid: /日割[^。\n]{0,8}(発生(しません|いたしません|しない)|かかりません|不要)/, forbidNote: "日割が発生しないと言う" },
  { id: "P2 日割(10/31入居この料金+当月日割)", fact: "prorated_rent", conv: "8590144d", at: "2026-09-22T06:16", match: "日割り分家賃",
    actual: "通常返信（そのまま送信あり）: 1日分の日割家賃とこちらの御見積書の費用／シャワー・間取り・鍵交換の説明",
    want: /日割/, wantNote: "日割家賃に触れる（1日分）", forbid: /日割[^。\n]{0,8}(発生(しません|いたしません|しない)|かかりません|不要)/, forbidNote: "日割が発生しないと言う" },
  { id: "P3 日割(日割り家賃無しで284,500円?)", fact: "prorated_rent", conv: "8b5a777e", at: "2026-09-12T14:17", match: "284,500",
    actual: "AIX 見積書×2 → 通常「はい！！284,500円となります！！こちら見積書となります」",
    want: /(284,500|日割)/, wantNote: "金額か日割に触れる", forbid: /日割[^。\n]{0,8}(発生(しません|いたしません|しない)|かかりません)|1日入居/, forbidNote: "日割が発生しないと言う／聞かれていない1日入居の説明" },
  { id: "R1 室内写真(こちらの物件お部屋の写真ありますか)", fact: "room_photo", conv: "fb8ab8d5", at: "2026-09-06T07:17", match: "写真などありますか",
    actual: "AIX property_check_result（室内イメージURL）→「こちら室内のイメージとなります」",
    want: /(撮影|お送り|送らせて|添付|室内(写真|イメージ|動画)|画像)/, wantNote: "写真・動画を送れる／送る", forbid: /((写真|画像)(が|は)?(ござい|あり)ません|ご用意(出来|でき)て(い)?ない|写真が(無|な)い)/, forbidNote: "写真が無いと断定" },
  { id: "R2 室内写真(ここの部屋アップの写真何枚か欲しい・建築中)", fact: "room_photo", conv: "ad97cd40", at: "2026-09-16T09:28", match: "アップの写真",
    actual: "通常返信（編集）: 建築中で内覧会が9/18・9/25のみ（写真は内覧会で撮影する流れ）",
    want: /(撮影|お送り|送らせて|添付|室内(写真|イメージ|動画)|内覧会)/, wantNote: "撮影して送る／内覧会", forbid: /((写真|画像)(が|は)?(ござい|あり)ません|ご用意(出来|でき)て(い)?ない|写真が(無|な)い)/, forbidNote: "写真が無いと断定" },
  { id: "E1 緊急連絡先(勤務先とかも記入必須?)", fact: "emergency_contact", conv: "62d01e33", at: "2026-09-11T09:41", match: "勤務先とかも記入必須",
    actual: "通常返信（編集）: お申込み時は無しでの申込みも可能／審査の際に追加指示の可能性／勤務先情報は開けて入力で大丈夫",
    want: /(緊急連絡先|勤務先)/, wantNote: "緊急連絡先の勤務先について答える", forbid: /(柔軟に対応|ケースもござ|緊急連絡先(は|が)?(不要|無くても|なくても))/, forbidNote: "緊急連絡先そのものを不要と言う" },
  { id: "E2 緊急連絡先(電話番号は自宅の番号でもいいか)", fact: "emergency_contact", conv: "60e6d3ab", at: "2026-09-03T10:52", match: "自宅の電話番号",
    actual: "通常返信（翌朝）: 管理会社より携帯番号の追加指示があるかもしれないが、緊急連絡先の電話番号は自宅の固定番号でも審査可能",
    want: /(固定|自宅|携帯)/, wantNote: "自宅番号の可否に答える", forbid: /(携帯番号(が|は)必須|携帯(電話)?(でないと|以外は)|固定(電話|番号)(は|では)?(不可|出来ません|できません))/, forbidNote: "携帯必須と断定（スタッフは固定でも可と答えた）" },
  { id: "C1 キャンセル(内覧するまではキャンセル無料なんですよね?)", fact: "cancel", conv: "f7d0e62d", at: "2026-09-07T03:38", match: "キャンセル無料",
    actual: "通常返信＋AIX 申込フォーマット: お申込みさせていただきます／ご内覧開始前までに審査が完了すると思われます／キャンセル料掛からない様慎重に進めます",
    want: /(審査[^。\n]{0,20}(通過|通る|承認)[^。\n]{0,16}(まで|前)|キャンセル料[^。\n]{0,14}(かかりません|無料|発生しません|一切|不要|掛からない))/, wantNote: "審査通過までキャンセル料はかからない", forbid: /キャンセル料[^。\n]{0,10}(発生いたします|かかります|必要となります)/, forbidNote: "キャンセル料がかかると言う" },
  { id: "C2 キャンセル(オーナー審査までキャンセル可能は申込から何日?)", fact: "cancel", conv: "60e6d3ab", at: "2026-09-03T05:25", match: "何日ぐらい",
    actual: "通常返信（編集）: 申込から1週間程が審査期間・承認後1週間猶予→おおよそ2週間がキャンセル可能期間",
    want: /(日|週間)/, wantNote: "期間の目安に答える", forbid: /キャンセル料[^。\n]{0,10}(発生いたします|かかります|必要となります)/, forbidNote: "キャンセル料がかかると言う" },
  { id: "A1 申込書類(書類提出は何が必要でしたか・内定書がないとダメ?)", fact: "apply_docs", conv: "60e6d3ab", at: "2026-09-03T03:53", match: "書類提出は何が必要",
    actual: "通常返信（そのまま送信あり）: フォーマット入力＋本人確認書類（免許証またはマイナンバー裏表）の2点／内定通知書無しでの審査も可能",
    want: /(本人確認書類|運転免許証|マイナンバー)/, wantNote: "本人確認書類（免許証・マイナンバー）", forbid: /(必ず|必須)[^。\n]{0,10}(収入証明|内定(通知)?書)/, forbidNote: "内定書が必須と断定" },
  { id: "V1 内覧方法(こちらの内見の方はどうでしょうか?)", fact: "viewing_method", conv: "d25e07d1", at: "2026-09-16T13:03", match: "内見の方は",
    actual: "AIX property_check_result → meeting_place（9/17 10:45 現地待ち合わせ）",
    want: /(内見|内覧|ご案内)/, wantNote: "内覧に応じる", forbid: /内(見|覧)(は|が)?(出来|でき)ません|内(見|覧)不可/, forbidNote: "内覧不可と言う" },
  { id: "S0 店舗(当日はそちらの店舗へ伺い…・YUMA履歴のみ)", fact: "store", conv: "", at: "", match: "",
    synthetic: "承知いたしました。当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います。",
    actual: "（過去の実物）弊社オンライン専門の不動産サービスとなります／大阪市中央区に事務所ございますが店舗では無く作業用の事務所／ご来社でのご相談が出来ない",
    want: STORE_WANT, wantNote: "オンライン専門・来社での相談は受けていない", forbid: STORE_FORBID, forbidNote: "店舗訪問を受け入れる" },
  { id: "S1 店舗の誤当たり(職場の住所はお店のことを書いたら?)", fact: "store", conv: "4a79a43e", at: "2026-09-14T04:22", match: "お店のこと",
    actual: "通常返信（編集）: ご勤務先のご情報あけた状態でお送り頂ければ大丈夫です",
    falsePositive: true, want: /勤務先|職場|お店/, wantNote: "勤務先欄の書き方に答える", forbid: /(オンライン専門|店舗で(は|ではあり)|ご来社|来店|事務所)/, forbidNote: "誤当たりの副作用: 聞かれていない店舗の事実を書く" },
  { id: "S2 店舗の誤当たり(SUUMO の店舗情報の画像)", fact: "store", conv: "8590144d", at: "2026-09-22T08:49", match: "取り扱い店舗",
    actual: "通常返信（そのまま送信あり）: 募集状況確認させて頂きます → AIX 確認結果（募集に出ていない）",
    falsePositive: true, want: /(募集|確認)/, wantNote: "募集状況の確認を宣言", forbid: /(オンライン専門|店舗で(は|ではあり)|ご来社|来店|事務所)/, forbidNote: "誤当たりの副作用: 聞かれていない店舗の事実を書く" },
];

type Msg = { id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null };
type Row = Record<string, unknown>;

async function yumaRow(): Promise<Row> {
  const { data } = await sb.from("conversations").select(COLS).eq("id", YUMA).maybeSingle();
  return (data ?? {}) as Row;
}
/** 今日の YUMA の「誰も触っていない状態」（2026-09-23 15:36 JST に目で確認した値）。他の実測の途中の状態を控えないための判定 */
const BASELINE_ANALYZED_AT = "2026-09-22T11:54:04";
let BASE_COUNT = 0;
const isBaseline = (r: Row) => String(r.status) === "proposing" && !r.ai_draft && String(r.brain_analyzed_at ?? "").startsWith(BASELINE_ANALYZED_AT) && String(r.last_sender) === "staff";
async function msgCount(): Promise<number> {
  const { count } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA);
  return count ?? 0;
}
/** 他の実測エージェントが YUMA を使っていない瞬間を待つ（2回続けて静かなら進む） */
// 他の実測（S2〜S7）と印の形を揃える: 文字列 "gap-lock:…"（S5/S7 が見る）。S2 は直近の messages・local の LLM 呼び出し・draft_attempted_at を見る
const LOCK = `gap-lock:S6:${RUN_ID}`;
async function waitForQuiet(where: string, maxMs = 40 * 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastNote = "";
  while (Date.now() - t0 < maxMs) {
    const r = await yumaRow(); const n = await msgCount();
    const since3 = new Date(Date.now() - 3 * 60_000).toISOString();
    const [{ count: recentMsgs }, { count: recentLlm }] = await Promise.all([
      sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).gte("created_at", since3),
      sb.from("llm_usage_logs").select("id", { count: "exact", head: true }).eq("env", "local").gte("created_at", new Date(Date.now() - 60_000).toISOString()),
    ]);
    const chk = r.ai_draft_check;
    const foreignLock = (typeof chk === "string" && chk.startsWith("gap-lock:") && chk !== LOCK) || (!!chk && typeof chk === "object" && !("ok" in (chk as Row)) && !("s6_lock" in (chk as Row)));
    const attempted = r.draft_attempted_at ? Date.now() - Date.parse(String(r.draft_attempted_at)) : Infinity;
    // ⚠ dev サーバー（3000）は他の実測と共用で local の LLM 呼び出しは絶えない（実測 60秒に約20回）ので、それは静かさの条件にしない
    const busy = n !== BASE_COUNT || (recentMsgs ?? 0) > 0 || foreignLock || !!r.draft_pending_at || attempted < 5 * 60_000;
    const note = `count=${n}/${BASE_COUNT} 直近3分の発言=${recentMsgs ?? 0} localLLM(60s)=${recentLlm ?? 0} lock=${foreignLock ? String(typeof chk === "string" ? chk : JSON.stringify(chk)).slice(0, 40) : "-"} pending=${r.draft_pending_at ?? "-"} attempted=${Number.isFinite(attempted) ? Math.round(attempted / 1000) + "s前" : "-"}`;
    if (!busy) {
      await sb.from("conversations").update({ ai_draft_check: LOCK }).eq("id", YUMA);
      await sleep(3000);
      const re = await yumaRow();
      if (re.ai_draft_check === LOCK && (await msgCount()) === BASE_COUNT) return true;
    } else if (note !== lastNote) { log(`   ⏳ ${where}: 他の実測が YUMA を使っている様子（${note}）→ 待つ`); lastNote = note; }
    await sleep(20_000);
  }
  log(`🛑 ${where}: ${Math.round(maxMs / 60_000)}分待っても空かない → 中止`);
  return false;
}
async function saveBackup(): Promise<boolean> {
  const row = await yumaRow();
  if (isBaseline(row)) { writeFileSync(BACKUP, JSON.stringify(row, null, 2), "utf8"); log(`控えた（誰も触っていない状態）: ${BACKUP} status=${row.status}`); return true; }
  // 途中の状態なら、共有の控え（scripts/.yuma-backup.json）が素の状態ならそれを使う
  if (existsSync("scripts/.yuma-backup.json")) {
    const shared = JSON.parse(readFileSync("scripts/.yuma-backup.json", "utf8")) as Row;
    if (isBaseline(shared)) { writeFileSync(BACKUP, JSON.stringify(shared, null, 2), "utf8"); log(`今の YUMA は途中の状態（status=${row.status}）なので、共有の控え（素の状態）を自分の控えにした`); return true; }
  }
  log(`🛑 YUMA が途中の状態（status=${row.status} ai_draft=${String(row.ai_draft ?? "").slice(0, 20)}）で、素の状態の控えも無い → 中止`);
  return false;
}
async function restore() {
  const b = JSON.parse(readFileSync(BACKUP, "utf8")) as Row;
  const { id: _i, customer_name: _n, updated_at: _u, ...rest } = b; void _i; void _n; void _u;
  const { error } = await sb.from("conversations").update(rest).eq("id", YUMA);
  if (error) log(`⚠ 戻せない: ${error.message}`);
}
async function setLock() { await sb.from("conversations").update({ ai_draft_check: LOCK }).eq("id", YUMA); }
async function assertLock(where: string): Promise<boolean> {
  const { data } = await sb.from("conversations").select("ai_draft_check").eq("id", YUMA).maybeSingle();
  const chk = data?.ai_draft_check as unknown;
  // 最終チェックの結果（{ok, issues, ...}）以外の物が入っていて自分の印でなければ、他の実測の印
  if (typeof chk === "string" && chk !== LOCK) { log(`🛑 ${where}: 他の実測の印（${chk.slice(0, 40)}）→ 中止`); return false; }
  if (chk && typeof chk === "object" && !("ok" in (chk as Row))) { log(`🛑 ${where}: 他の実測が YUMA を使っている（${JSON.stringify(chk).slice(0, 80)}）→ 中止`); return false; }
  return true;
}
async function armConversation() {
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: LOCK,
    draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);
}
async function waitForDraft(timeoutMs = 240_000): Promise<{ draft: string; sentinel: string | null; timedOut: boolean }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const { data } = await sb.from("conversations").select("ai_draft, draft_pending_at, draft_attempted_at").eq("id", YUMA).maybeSingle();
    const d = String(data?.ai_draft ?? "");
    if (d === "[AIX誘導中]" || d === "[返信不要]") return { draft: "", sentinel: d, timedOut: false };
    if (d && d !== "__SHOWN__") return { draft: d, sentinel: null, timedOut: false };
  }
  return { draft: "", sentinel: null, timedOut: true };
}
async function cleanup(ids: string[], since: string) {
  if (ids.length) { const { error } = await sb.from("messages").delete().in("id", ids); if (error) log(`⚠ messages 削除失敗: ${error.message}`); }
  const a = await sb.from("aix_action_items").delete().eq("conversation_id", YUMA).gte("created_at", since).select("id");
  const c = await sb.from("automation_commands").delete().filter("payload->>conversation_id", "eq", YUMA).gte("created_at", since).select("id");
  const n1 = (a.data ?? []).length, n2 = (c.data ?? []).length;
  if (n1 || n2) log(`   片付け: aix_action_items ${n1}件 / automation_commands ${n2}件`);
}

/** bg-async と同じ形の条件文字列（property_customers の列から） */
function formatConditions(pc: Row | null): string {
  if (!pc) return "";
  const rentMin = pc.rent_min as number | null, rentMax = pc.rent_max as number | null;
  const add = pc.additional_conditions ? String(pc.additional_conditions).split("\n").map((l) => l.replace(/^【[^】]*】/, "").trim()).filter(Boolean).join("、") : "";
  return [
    pc.desired_area && `エリア: ${pc.desired_area}`, pc.floor_plan && `間取り: ${pc.floor_plan}`,
    (rentMin || rentMax) && `家賃: ${[rentMin ? Math.floor(rentMin / 10000) + "万円〜" : "", rentMax ? Math.floor(rentMax / 10000) + "万円以内" : ""].join("")}`,
    pc.walk_minutes && `駅徒歩: ${pc.walk_minutes}分以内`, pc.move_in_time && `入居: ${pc.move_in_time}`, pc.building_age && `築年数: ${pc.building_age}年以内`,
    pc.preferences && `希望: ${pc.preferences}`, pc.ng_points && `NG: ${pc.ng_points}`, pc.other_requests && `その他: ${pc.other_requests}`,
    add && `追加条件: ${add}`,
  ].filter(Boolean).join("\n");
}
/** 画面（app/page.tsx）と同じ replyHint */
function buildReplyHint(target: string, ctx: Array<{ sender: string; text: string }>, state: string): string | undefined {
  const lines = target.split("\n").map((l) => l.trim()).filter(Boolean);
  const shortLines = lines.filter((l) => l.length <= 25);
  const isBullet = shortLines.length >= 3;
  const COND = /[0-9０-９]+万|[0-9０-９]+LDK|[0-9０-９]+[KDk]|エリア|区|駅|間取り|家賃|広さ|㎡|ペット|駐車場|築/;
  const ACT = /含めて|を外|に変え|以上|以下|でも可|気にしな|上げて|下げて|緩め|広げ|に絞|でお願い|から探|も探/;
  const PICK = /ありませんか|ありますか|送って|ピックアップ|おすすめ|オススメ|出てます|教えて/;
  const hasCond = lines.some((l) => COND.test(l) && ACT.test(l));
  const hasPickup = lines.some((l) => PICK.test(l));
  let hint = "";
  const est = (() => { for (const m of ctx.filter((x) => x.sender === "staff").slice(-8).reverse()) { const mm = (m.text || "").match(/^【([^\s】]+)/); if (mm) return mm[1]; } return null; })();
  if (est) hint += `【見積書の物件名固定】直近に送った見積書の物件「${est}」を使うこと。会話に出てくる他の物件名は絶対に使わない`;
  if (target === "（物件画像を送信）") {
    hint = "【お客様が物件画像を送信】お客様が特定物件の空室確認を依頼している。「かしこまりました！！お送り頂きました物件の募集状況確認させていただきます！！確認出来次第ご連絡させて頂きます！！」と返信し、条件がまだ未確認の場合はあわせて条件ヒアリングフォームを送る（①入居時期 ②ご希望家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他）";
  } else if (state !== "first_reply") {
    if (isBullet) hint += (hint ? "\n" : "") + `【お客様が列挙した条件・要望（返信で具体的に言及すること）】${shortLines.slice(0, 8).join("・")}`;
    else if (hasCond || hasPickup) hint += (hint ? "\n" : "") + `【条件変更/ピックアップ依頼（追加質問禁止・変更内容を具体的に言葉にして即行動宣言）】${lines.join("・")}`;
  }
  return hint || undefined;
}

type Shape = { kind: string; chars: number; lines: number; ack: boolean; thanks: boolean; close: boolean; banned: string[]; memo: boolean; cta: string | null; rent: boolean; promises: string[] };
function shapeOf(text: string): Shape {
  const t = text.trim();
  const lines = t.split("\n").filter((l) => l.trim());
  const sentences = t.split(/(?<=[。！!\n])(?![。！!])/).map((s) => s.trim()).filter(Boolean);
  const banned = ["お待たせ致しました", "お待たせいたしました", "全力サポート", "全力でサポート", "いつでもお気軽に"].filter((w) => t.includes(w));
  const cta = detectRecommendApplyLine(t);
  return {
    kind: classifySentKind(t), chars: t.replace(/\s/g, "").length, lines: lines.length,
    ack: /^(かしこまりました|はい|承知)/.test(t), thanks: /ありがとうござ/.test(t),
    close: /(何卒よろしく|ご査収|お気軽に)/.test(t), banned,
    memo: /への返信です|^【[^】]{2,12}】\s*$|^[─\-=]{3,}|^(下書き|返信案|本文)[:：]/m.test(t) || /<<<[A-Z_]{3,}:/.test(t),
    cta: cta.kind, rent: sentences.some((s) => isRentNegotiationPromise(s)),
    promises: sentences.filter((s) => /(確認(させて|して|いたし|致し)|お送り(させて|いたし|致し)|ご案内(させて|いたし|致し)|ピックアップ(させて|し)|交渉(させて|いたし|し))/.test(s) && /(ます|頂きます|いただきます)/.test(s)).map((s) => s.slice(0, 60)),
  };
}
const fmtShape = (s: Shape) => `種類=${s.kind} ${s.chars}字/${s.lines}行 受け=${s.ack ? "○" : "×"} お礼=${s.thanks ? "○" : "×"} 締め=${s.close ? "○" : "×"} 禁止語=${s.banned.join("/") || "なし"} 作業メモ=${s.memo ? "⚠あり" : "なし"} 申込CTA=${s.cta ?? "なし"} 家賃交渉=${s.rent ? "⚠あり" : "なし"} 宣言=${s.promises.length}`;

async function directGenerate(body: Record<string, unknown>): Promise<{ text: string; meta: Row | null; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  const nl = raw.indexOf("\n");
  let meta: Row | null = null;
  try { meta = JSON.parse(nl >= 0 ? raw.slice(0, nl) : raw) as Row; } catch { meta = null; }
  const text = (nl >= 0 ? raw.slice(nl + 1) : raw).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
  return { text, meta, ms: Date.now() - t0 };
}

async function main() {
  writeFileSync(OUT, `=== S6 会社の事実 YUMA 再現 ${RUN_ID} REPS=${REPS} ===\n`, "utf8");
  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const scenes = only.length ? SCENES.filter((s) => only.some((o) => s.id.startsWith(o))) : SCENES;
  const T0 = new Date().toISOString();
  // 素の状態の発言数（2026-09-23 15:36 JST に確認: 235通）。途中の状態から始めない
  BASE_COUNT = Number(process.env.BASE_COUNT ?? 235);
  if (!(await waitForQuiet("開始前"))) return;
  if (!(await saveBackup())) return;
  const before = JSON.parse(readFileSync(BACKUP, "utf8")) as Row;
  await restore(); await setLock();
  const msgCount0 = await msgCount();
  log(`YUMA の発言数（開始時）: ${msgCount0}\n`);

  const summary: Array<{ scene: Scene; brain: Row; gens: Array<{ src: string; text: string; ok: boolean; want: boolean; bad: boolean; shape: Shape; ms: number; aix: string | null }>; valid: boolean; note: string }> = [];

  for (const s of scenes) {
    const tScene = new Date().toISOString();
    log(`\n${"═".repeat(70)}\n【${s.id}】 fact=${s.fact}`);
    if (!(await waitForQuiet(s.id))) break;
    if (!(await assertLock(s.id))) break;
    await restore(); await setLock();

    // ── 元会話から写す
    let inserted: string[] = [];
    let ctx: Array<{ sender: string; text: string; imageUrl?: string; createdAt: string; isAix: boolean }> = [];
    let state = String(before.status ?? "proposing");
    let hasViewed = false;
    let pc: Row | null = null;
    let targetText = "";
    let targetCreatedAt = "";
    let staffActual: string[] = [];
    let aixActual: string[] = [];
    if (s.synthetic) {
      const { data: ms } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(24);
      const hist = ((ms ?? []) as Msg[]).reverse();
      targetCreatedAt = new Date(Date.now() - 60_000).toISOString();
      const ins = await sb.from("messages").insert({ conversation_id: YUMA, sender: "customer", text: s.synthetic, created_at: targetCreatedAt }).select("id");
      if (ins.error) { log(`場面を作れず: ${ins.error.message}`); continue; }
      inserted = (ins.data as Array<{ id: string }>).map((r) => r.id);
      ctx = [...hist.map((m) => ({ sender: m.sender, text: m.text ?? "", imageUrl: m.image_url ?? undefined, createdAt: m.created_at, isAix: !!m.is_aix_generated })), { sender: "customer", text: s.synthetic, createdAt: targetCreatedAt, isAix: false }];
      targetText = s.synthetic;
      const { data: ypc } = await sb.from("property_customers").select("*").eq("id", String(before.property_customer_id ?? "")).maybeSingle();
      pc = (ypc ?? null) as Row | null;
      hasViewed = false;
    } else {
      const { data: cs } = await sb.from("conversations").select("id, customer_name, status, has_viewed, property_customer_id").like("id", `${s.conv}%`).limit(1);
      const conv = (cs ?? [])[0] as Row | undefined;
      if (!conv) { log(`元会話が見つからない: ${s.conv}`); continue; }
      const origName = String(conv.customer_name ?? "");
      const from = new Date(Date.parse(s.at + ":00Z") - 60_000).toISOString(), to = new Date(Date.parse(s.at + ":00Z") + 120_000).toISOString();
      const { data: tg } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", String(conv.id)).eq("sender", "customer").gte("created_at", from).lte("created_at", to).ilike("text", `%${s.match}%`).order("created_at").limit(1);
      const target = (tg ?? [])[0] as Msg | undefined;
      if (!target) { log(`対象発言が見つからない: ${s.conv} ${s.at} ${s.match}`); continue; }
      const { data: hs } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", String(conv.id)).lte("created_at", target.created_at).order("created_at", { ascending: false }).limit(25);
      const hist = ((hs ?? []) as Msg[]).reverse().filter((m) => m.id !== target.id);
      hist.push(target);
      // 実送信（対象の後 48h・最大3通）と押した AIX（3h）
      const { data: after } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", String(conv.id)).gt("created_at", target.created_at).lte("created_at", new Date(Date.parse(target.created_at) + 48 * 3600_000).toISOString()).neq("sender", "customer").order("created_at").limit(6);
      staffActual = ((after ?? []) as Array<{ text: string | null; is_aix_generated: boolean | null }>).filter((m) => (m.text ?? "").trim() && m.text !== "[画像]").slice(0, 3).map((m) => `${m.is_aix_generated ? "[AIX]" : ""}${String(m.text)}`);
      const { data: al } = await sb.from("aix_usage_logs").select("aix_type").eq("conversation_id", String(conv.id)).gte("created_at", target.created_at).lte("created_at", new Date(Date.parse(target.created_at) + 3 * 3600_000).toISOString());
      aixActual = ((al ?? []) as Array<{ aix_type: string }>).map((a) => a.aix_type);
      // 当時の状態
      const { data: exs } = await sb.from("ai_reply_examples").select("conversation_state, created_at").eq("conversation_id", String(conv.id)).gte("created_at", new Date(Date.parse(target.created_at) - 3 * 3600_000).toISOString()).lte("created_at", new Date(Date.parse(target.created_at) + 6 * 3600_000).toISOString()).limit(10);
      const states = ((exs ?? []) as Array<{ conversation_state: string | null }>).map((e) => e.conversation_state).filter(Boolean) as string[];
      state = states.length ? states.sort((a, b) => states.filter((x) => x === b).length - states.filter((x) => x === a).length)[0] : String(conv.status);
      hasViewed = !!conv.has_viewed;
      if (conv.property_customer_id) { const { data: p } = await sb.from("property_customers").select("*").eq("id", String(conv.property_customer_id)).maybeSingle(); pc = (p ?? null) as Row | null; }
      // 平行移動（対象＝now−60s・間隔は最大60分）
      const tsOrig = hist.map((m) => Date.parse(m.created_at));
      const shifted: number[] = new Array(hist.length);
      shifted[hist.length - 1] = Date.now() - 60_000;
      for (let i = hist.length - 2; i >= 0; i--) { const gap = Math.max(1000, Math.min(60 * 60_000, tsOrig[i + 1] - tsOrig[i])); shifted[i] = shifted[i + 1] - gap; }
      const repl = (t: string) => origName ? t.split(origName).join("YUMA") : t;
      const rows = hist.map((m, i) => ({ conversation_id: YUMA, sender: m.sender, text: repl(m.text ?? ""), created_at: new Date(shifted[i]).toISOString(), is_aix_generated: !!m.is_aix_generated }));
      const ins = await sb.from("messages").insert(rows).select("id, created_at, text");
      if (ins.error) { log(`場面を作れず: ${ins.error.message}`); continue; }
      inserted = (ins.data as Array<{ id: string }>).map((r) => r.id);
      ctx = rows.map((r) => ({ sender: r.sender, text: r.text, createdAt: r.created_at, isAix: r.is_aix_generated }));
      targetText = repl(target.text ?? "");
      targetCreatedAt = rows[rows.length - 1].created_at;
      log(`元会話 ${s.conv} / 当時の状態=${state} / 写した ${rows.length}通（${hist.filter((m) => m.sender !== "customer").length}通がこちら）/ 紐付き条件=${pc ? "あり" : "なし"}`);
    }
    await sb.from("conversations").update({ status: state, last_sender: "customer", last_message: targetText.slice(0, 200) }).eq("id", YUMA);
    log(`客: ${mask(targetText).replace(/\n/g, " / ").slice(0, 200)}`);
    log(`事実の当たり: ${matchCompanyFacts(targetText).map((f) => f.id).join(",") || "なし"} ／ お客様の場面（sent-shape）: ${customerSceneOf(targetText, { isConditionForm: isConditionFormMessage, isShortAck: isShortAckOnly })}`);
    log(`実送信: ${staffActual.map((t) => mask(t).replace(/\n/g, " / ").slice(0, 160)).join(" ｜ ") || s.actual}`);
    log(`押した AIX(3h): ${aixActual.join(",") || "なし"}`);

    // ── ブレインごと（bg-async）
    const brain: Row = {};
    let bgDraft = "";
    let valid = true; let note = "";
    const skipBrain = process.env.SKIP_BRAIN === "1" || DRAFT_SKIP_STATUSES.has(state);
    if (skipBrain) {
      note = DRAFT_SKIP_STATUSES.has(state) ? `status=${state} は自動の下書きを作らない（本番でも bg-async は skipped=status）→ 生成側だけ測る` : "SKIP_BRAIN";
      log(`ブレイン: ${note}`);
    } else {
      let skipped = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        await armConversation();
        try {
          const res = await fetch(`${BASE}/api/generate-draft-bg-async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: YUMA, source: "direct" }) });
          skipped = String(((await res.json()) as Row).skipped ?? "");
        } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
        if (skipped !== "in_progress") break;
        await sleep(20_000);
      }
      const w = skipped ? { draft: "", sentinel: null, timedOut: false } : await waitForDraft();
      bgDraft = w.draft;
      const row = await yumaRow();
      const meta = (row.suggested_aix_meta ?? {}) as Row;
      const analyzedOk = row.brain_analyzed_at ? Date.parse(String(row.brain_analyzed_at)) >= Date.parse(tScene) : false;
      const tsOk = meta.analyzed_msg_ts ? Math.abs(Date.parse(String(meta.analyzed_msg_ts)) - Date.parse(targetCreatedAt)) < 2000 : false;
      const { data: newest } = await sb.from("messages").select("id").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1);
      const newestOk = ((newest ?? [])[0] as { id: string } | undefined)?.id === inserted[inserted.length - 1];
      const { data: bl } = await sb.from("brain_decision_logs").select("suggested_action, suggested_reply_mode, scene_evidence, digest, decision_source, created_at").eq("conversation_id", YUMA).gte("created_at", tScene).order("created_at", { ascending: false }).limit(1);
      const blog = ((bl ?? [])[0] ?? null) as Row | null;
      Object.assign(brain, { skipped, action: meta.action ?? null, reply_mode: meta.reply_mode ?? null, source: meta.source ?? null, pending_pickup: meta.pending_pickup ?? null, dropped_direction: meta.dropped_direction ?? null, direction: (meta.reply_direction ?? (blog?.digest as Row | undefined)?.dir) ?? null, scene: (() => { try { const se = blog?.scene_evidence; const o = typeof se === "string" ? JSON.parse(se) : se; return (o as Row | null)?.scene ?? null; } catch { return null; } })(), log_action: blog?.suggested_action ?? null, decision_source: blog?.decision_source ?? null, sentinel: w.sentinel, timedOut: w.timedOut, analyzedOk, tsOk, newestOk });
      valid = !skipped && analyzedOk && tsOk && newestOk && !w.timedOut;
      if (!valid) note = `前提: skipped=${skipped || "-"} brain_analyzed_at${analyzedOk ? "○" : "×"} analyzed_msg_ts${tsOk ? "○" : "×"} 最新発言${newestOk ? "○" : "×"} timeout=${w.timedOut}`;
      log(`ブレイン: action=${brain.action ?? "-"} reply_mode=${brain.reply_mode ?? "-"} scene=${brain.scene ?? "-"} source=${brain.source ?? "-"} decision_source=${brain.decision_source ?? "-"} ／ ${valid ? "前提○" : "⚠ " + note}`);
      if (brain.direction) log(`   方向: ${String(brain.direction).slice(0, 200)}`);
      log(`   下書き: ${bgDraft ? "出た" : w.sentinel ?? (skipped ? `skipped=${skipped}` : w.timedOut ? "timeout" : "なし")}`);
    }

    // ── 生成側（画面と同じ body）
    const lastStaffIdx = ctx.map((m, i) => (m.sender === "staff" ? i : -1)).filter((i) => i >= 0).at(-1);
    const afterStaff = lastStaffIdx !== undefined ? ctx.slice(lastStaffIdx + 1) : ctx;
    const unreplied = afterStaff.filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]").slice(-10);
    let message = unreplied.length ? unreplied.map((m) => m.text).join(MSG_SEP) : targetText;
    if (message === "[画像]" || !message.trim()) message = "（物件画像を送信）";
    const customerMessages = unreplied.length ? unreplied.map((m) => m.text) : [message];
    const last25 = ctx.slice(-25);
    const hasStaff = last25.some((m) => m.sender === "staff");
    const lastStaff = !hasStaff ? [...ctx].reverse().find((m) => m.sender === "staff") : undefined;
    const recentMessages = (lastStaff ? [lastStaff, ...last25] : last25).map((m) => ({ sender: m.sender, text: m.text || "", imageUrl: m.imageUrl, createdAt: m.createdAt, isAix: m.isAix }));
    const structured = pc ? { move_in_time: pc.move_in_time ?? null, rent_max: pc.rent_max ?? null, desired_area: pc.desired_area ?? null, walk_minutes: pc.walk_minutes ?? null, floor_plan: pc.floor_plan ?? null, initial_cost_limit: pc.initial_cost_limit ?? null, building_age: pc.building_age ?? null, other_requests: pc.other_requests ?? null } : undefined;
    const body = {
      message, customerMessages, state, conversationId: YUMA, customerName: "YUMA",
      customerConditions: formatConditions(pc) || undefined, customerSummary: (pc?.ai_summary as string | null) ?? undefined, customerStructured: structured,
      replyHint: buildReplyHint(message, ctx, state), hasViewed, activeTaskTypes: [] as string[], recentMessages,
    };
    const gens: (typeof summary)[number]["gens"] = [];
    const judge = (text: string) => { const want = s.want.test(text); const bad = s.forbid.test(text); return { want, bad, ok: want && !bad }; };
    if (bgDraft) { const j = judge(bgDraft); gens.push({ src: "bg-async", text: bgDraft, ...j, shape: shapeOf(bgDraft), ms: 0, aix: String(brain.action ?? "") || null }); }
    const tGen = Date.now();
    for (let k = gens.length; k < REPS; k++) {
      if (Date.now() - tGen > 60_000 * 4) log(`   ⚠ 生成開始から ${Math.round((Date.now() - tGen) / 1000)}s 経過（ブレインの鮮度は 60s で古くなる）`);
      let r: { text: string; meta: Row | null; ms: number };
      try { r = await directGenerate(body); } catch (e) { r = { text: `【エラー】${e instanceof Error ? e.message : String(e)}`, meta: null, ms: 0 }; }
      const j = judge(r.text);
      gens.push({ src: `direct#${k + 1}`, text: r.text, ...j, shape: shapeOf(r.text), ms: r.ms, aix: ((r.meta?.suggested_aix as Row | null)?.action as string | undefined) ?? null });
    }
    for (const g of gens) {
      log(`\n  ── ${g.src} ${g.ms ? `${(g.ms / 1000).toFixed(0)}s` : ""} ${g.ok ? "✓" : "✗"}${!g.want ? `（要: ${s.wantNote}）` : ""}${g.bad ? ` ⚠ ${s.forbidNote}` : ""} suggested_aix=${g.aix ?? "-"}`);
      log(`     ${fmtShape(g.shape)}`);
      for (const line of mask(g.text).split("\n")) log(`     │ ${line}`);
    }
    // 同時使用の検知（写した分＋素の状態の通数から増えていたら他の実測が挟まった／ブレインの判断が別の発言に差し替わっていたら生成側も汚れている）
    const nNow = await msgCount();
    if (!skipBrain) {
      const after = await yumaRow();
      const ts = String(((after.suggested_aix_meta ?? {}) as Row).analyzed_msg_ts ?? "");
      if (ts && Math.abs(Date.parse(ts) - Date.parse(targetCreatedAt)) >= 2000) { note += ` ／ ⚠ 生成の後にブレインの判断が別の発言（${ts}）に差し替わっていた`; valid = false; log(`   ⚠ 生成の後にブレインの判断が別の発言に差し替わっていた: ${ts}`); }
    }
    if (nNow !== BASE_COUNT + inserted.length) { note += ` ／ ⚠ 同時使用の疑い: 発言数 ${nNow}（期待 ${BASE_COUNT + inserted.length}）`; valid = false; log(`   ⚠ 同時使用の疑い: 発言数 ${nNow}（期待 ${BASE_COUNT + inserted.length}）`); }
    summary.push({ scene: s, brain, gens, valid, note });

    // ── 片付け（restore で ai_draft_check が素の null に戻る＝他の実測に譲る）
    await cleanup(inserted, tScene);
    await restore();
  }

  // ── 集計
  log(`\n\n${"═".repeat(70)}\n【集計】REPS=${REPS}`);
  log(`${"場面".padEnd(46)} ブレイン(action/mode/scene)        前提  生成✓/n  事実入り  反する  受け  締め  申込CTA  作業メモ  字数中央値`);
  for (const r of summary) {
    const n = r.gens.length, ok = r.gens.filter((g) => g.ok).length, want = r.gens.filter((g) => g.want).length, bad = r.gens.filter((g) => g.bad).length;
    const ack = r.gens.filter((g) => g.shape.ack).length, close = r.gens.filter((g) => g.shape.close).length, cta = r.gens.filter((g) => g.shape.cta).length, memo = r.gens.filter((g) => g.shape.memo).length;
    const chars = r.gens.map((g) => g.shape.chars).sort((a, b) => a - b); const med = chars.length ? chars[Math.floor(chars.length / 2)] : 0;
    const b = r.brain; const bs = b.skipped !== undefined ? `${b.action ?? "-"}/${b.reply_mode ?? "-"}/${b.scene ?? "-"}` : "（status で自動なし）";
    log(`${r.scene.id.slice(0, 44).padEnd(46)} ${bs.padEnd(34)} ${(r.brain.skipped !== undefined ? (r.valid ? "○" : "×") : "—").padEnd(4)} ${`${ok}/${n}`.padEnd(8)} ${`${want}/${n}`.padEnd(8)} ${`${bad}/${n}`.padEnd(6)} ${`${ack}/${n}`.padEnd(5)} ${`${close}/${n}`.padEnd(5)} ${`${cta}/${n}`.padEnd(8)} ${`${memo}/${n}`.padEnd(8)} ${med}`);
  }
  // 費用
  const { data: usage } = await sb.from("llm_usage_logs").select("model, route, input_uncached, cache_read, cache_write, output_tokens").eq("conversation_id", YUMA).gte("created_at", T0);
  const u = (usage ?? []) as Array<{ model: string; route: string; input_uncached: number; cache_read: number; cache_write: number; output_tokens: number }>;
  const price = (m: string) => /haiku/i.test(m) ? { i: 0.8, r: 0.08, w: 1.0, o: 4 } : /opus/i.test(m) ? { i: 15, r: 1.5, w: 18.75, o: 75 } : { i: 3, r: 0.3, w: 3.75, o: 15 };
  let usd = 0; const byModel: Record<string, { n: number; usd: number }> = {};
  for (const x of u) { const p = price(x.model); const c = ((x.input_uncached ?? 0) * p.i + (x.cache_read ?? 0) * p.r + (x.cache_write ?? 0) * p.w + (x.output_tokens ?? 0) * p.o) / 1e6; usd += c; const k = `${x.model} ${x.route}`; byModel[k] = { n: (byModel[k]?.n ?? 0) + 1, usd: (byModel[k]?.usd ?? 0) + c }; }
  log(`\n【費用】llm_usage_logs（YUMA・${T0}〜）${u.length}回 ≈ $${usd.toFixed(2)}`);
  for (const [k, v] of Object.entries(byModel).sort((a, b) => b[1].usd - a[1].usd)) log(`   ${k.padEnd(60)} ${String(v.n).padStart(3)}回 $${v.usd.toFixed(2)}`);

  // 元通りの確認（他の実測が使っている最中なら上書きしない）
  const rowEnd = await yumaRow();
  if ((await msgCount()) === BASE_COUNT && !rowEnd.draft_pending_at) await restore();
  else log(`   ⚠ 終了時に他の実測が YUMA を使っている様子なので、最後の restore は行わない（その実測が自分の控えで戻す）`);
  const msgCount1 = await msgCount();
  const finalRow = await yumaRow();
  log(`\n【元通り】発言数 ${msgCount0} → ${msgCount1} ／ status=${finalRow.status} ai_draft=${String(finalRow.ai_draft ?? "(なし)").slice(0, 20)} ai_draft_check=${JSON.stringify(finalRow.ai_draft_check).slice(0, 40)}`);
  const { count: leftItems } = await sb.from("aix_action_items").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).gte("created_at", T0);
  log(`   残った要対応（開始以降）: ${leftItems ?? 0}件`);
}
main().catch(async (e) => { console.error(e); try { await restore(); } catch { /* noop */ } process.exit(1); });
