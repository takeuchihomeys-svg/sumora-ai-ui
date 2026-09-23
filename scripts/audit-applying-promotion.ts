// 申込（applying）への自動昇格が止まっている理由を実物で確かめる（読み取りのみ・書き込みなし）
//
// 2026-09-23 課題②: DB の conversations.status がブレインの brain_strategy.checkpoint_stage より後ろの会話が 27.4%（32/117）。
//   line-webhook の tryPromoteToApplying は applying_text_received と applying_image_received の両方が要るが、画像の旗は 0 件。
//
// 【見る物】
//   ① 後ろの会話それぞれで、お客様の申込フォーム（テキスト）と画像はいつ・どの順で届いたか。
//      画像の旗が立つ条件（直近72h以内のスタッフ発言に /申込書|申込用紙|ご記入|入居申込/）に当たっていたか。
//   ② 昇格条件の候補を並べ、「昇格すべき会話（後ろの32件）」の何件を拾い、
//      「昇格すべきでない会話（status も ブレインも申込前・スタッフが手で戻した会話）」の何件で誤って true になるか（誤昇格0が条件）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-applying-promotion.ts
//   本名・電話番号は出力しない（メッセージ本文は出さず、当たった語と種別だけ出す）
import { createClient } from "@supabase/supabase-js";
import { isApplicationFormMessage, hasApplyHintKeyword, PRE_APPLY_STATUSES } from "../app/lib/application-form-detect";
import { resolveApplyingPromotion, shouldSetApplyingImageFlag, STAFF_FORM_REQUEST_RE } from "../app/lib/applying-promotion";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const H = 3600_000;
const D = 24 * H;
const short = (id: string) => id.slice(0, 8);
const fmt = (iso: string) => iso.slice(0, 16).replace("T", " ");

// 従来の画像の旗の語は app/lib/applying-promotion.ts の STAFF_FORM_REQUEST_RE（本番と同じ物を import・四者同名）
const IMAGE_RE = /^\[画像\]/;

/**
 * 直した後の本番（2026-09-23）を時系列で流す: 旗を積み上げ、フォーム文・画像の各出来事で resolveApplyingPromotion を呼ぶ。
 *   手戻しの印は見ない（生の証拠だけで true になるかを測る。印がある会話は本番では manual_back で必ず止まる）
 */
function simulateNewProduction(f: Facts): { promote: boolean; reason: string | null; at: string | null } {
  type Ev = { at: string; kind: "form" | "image" | "push"; imageType?: string | null; staffAsked?: boolean };
  const evs: Ev[] = [
    ...f.formTexts.map((t): Ev => ({ at: t.at, kind: "form" })),
    ...f.images.map((i): Ev => ({ at: i.at, kind: "image", imageType: i.imageType, staffAsked: i.staffAskedWithin72h })),
    ...f.applicationPushAt.map((p): Ev => ({ at: p, kind: "push" })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let text = false, image = false, lastPush: string | null = null;
  for (const e of evs) {
    if (e.kind === "push") { lastPush = e.at; continue; }
    if (e.kind === "form") text = true;
    if (e.kind === "image") {
      // 本番: 保存時は語だけ（imageType なし）、Vision 後に id_document で再判定。どちらかで立てば旗は立つ
      const r = shouldSetApplyingImageFlag({ imageType: e.imageType, lastStaffTextWithin72h: e.staffAsked ? "申込書" : "" });
      if (!r.set) continue;
      image = true;
    }
    const d = resolveApplyingPromotion({ status: "proposing", textReceived: text, imageReceived: image, statusManualBackAt: null, lastApplicationPushAt: lastPush, now: e.at });
    if (d.promote) return { promote: true, reason: d.reason, at: e.at };
  }
  return { promote: false, reason: null, at: null };
}

const STATUS_STAGE: Record<string, number> = {
  first_reply: 0, hearing: 0, condition_hearing: 0, property_search: 0,
  proposing: 1, property_recommendation: 1, availability_check: 1, estimate_request: 1,
  viewing: 2, applying: 3, application: 3, screening: 3, contract: 4, approved: 4,
};
const BRAIN_STAGE: Record<string, number> = { hearing: 0, proposing: 1, viewing: 2, applying: 3, contract: 4 };

type Conv = {
  id: string; status: string | null; brain_strategy: Record<string, unknown> | null;
  applying_text_received: boolean | null; applying_image_received: boolean | null;
  is_post_apply: boolean | null; status_manual_back_at: string | null; updated_at: string | null;
};
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; image_type: string | null; is_aix_generated: boolean | null };
type Aix = { conversation_id: string; aix_type: string | null; created_at: string };
type Stage = { conversation_id: string; from_status: string | null; to_status: string; trigger: string | null; changed_at: string };

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

/** 1会話の「申込に関わる出来事」を時系列で拾う */
type Facts = {
  formTexts: { at: string; type: string; joined: boolean; keywords: string[] }[];   // お客様の申込フォーム（テキスト）
  images: { at: string; imageType: string | null; staffAskedWithin72h: boolean; lastStaffGapH: number | null }[]; // お客様の画像
  idDocs: string[];                                                                   // image_type=id_document の時刻
  staffFormRequests: string[];                                                        // スタッフの申込書依頼の発言（正規表現）
  applicationPushAt: string[];                                                        // AIX【申込へ】押下
  firstStaffAt: string | null;
  isPostApply: boolean;
  msgCount: number; customerCount: number; firstAt: string | null; lastAt: string | null;
  /** AIX【申込へ】の直後（2h以内）のスタッフ発言に含まれる語（本文は出さない） */
  pushFollowKeywords: string[];
  /** フォーム文の実物の形（本文は出さない）: 文字数・行数・当たった項目数・疑問形か */
  formShapes: { at: string; len: number; lines: number; fields: number; question: boolean }[];
};

const FORM_FIELD_RE = /氏名|フリガナ|生年月日|現住所|緊急連絡先|勤務先|続柄|住居年数|入居者|申込書|保証人|年収|職業|法人名|会社名|代表者|登記住所|本社所在地|設立|資本金|事業内容|年商|従業員数|法人番号/g;
const PUSH_KEYWORDS = ["申込", "申し込み", "フォーマット", "氏名", "生年月日", "ご記入", "本人確認", "免許", "マイナンバー", "保険証", "書類", "審査", "入居申込", "申込書", "申込用紙"];

function factsOf(msgs: Msg[], aix: Aix[], conv: Conv): Facts {
  const pushes = aix.filter((a) => a.aix_type === "application_push").map((a) => a.created_at).sort();
  const f: Facts = {
    formTexts: [], images: [], idDocs: [], staffFormRequests: [], applicationPushAt: pushes, firstStaffAt: null,
    isPostApply: !!conv.is_post_apply, msgCount: msgs.length, customerCount: msgs.filter((m) => m.sender === "customer").length,
    firstAt: msgs.length ? msgs.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))[0].created_at : null,
    lastAt: msgs.length ? msgs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0].created_at : null,
    pushFollowKeywords: [], formShapes: [],
  };
  for (const p of pushes) {
    const follow = msgs.filter((m) => m.sender === "staff" && m.created_at >= p && new Date(m.created_at).getTime() - new Date(p).getTime() <= 2 * H);
    for (const m of follow) for (const k of PUSH_KEYWORDS) if ((m.text ?? "").includes(k) && !f.pushFollowKeywords.includes(k)) f.pushFollowKeywords.push(k);
  }
  const sorted = msgs.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  const customerTexts: { at: string; text: string }[] = [];
  for (const m of sorted) {
    const t = m.text ?? "";
    if (m.sender === "staff") {
      if (!f.firstStaffAt && t.trim()) f.firstStaffAt = m.created_at;
      if (STAFF_FORM_REQUEST_RE.test(t)) f.staffFormRequests.push(m.created_at);
      continue;
    }
    if (IMAGE_RE.test(t)) {
      // 本番と同じ: 画像の時点から72h以内の直近スタッフ発言1件だけを見る
      const cutoff = new Date(new Date(m.created_at).getTime() - 72 * H).toISOString();
      const lastStaff = sorted.filter((s) => s.sender === "staff" && s.created_at < m.created_at && s.created_at > cutoff).pop();
      const anyLastStaff = sorted.filter((s) => s.sender === "staff" && s.created_at < m.created_at).pop();
      f.images.push({
        at: m.created_at, imageType: m.image_type,
        staffAskedWithin72h: !!lastStaff && STAFF_FORM_REQUEST_RE.test(lastStaff.text ?? ""),
        lastStaffGapH: anyLastStaff ? (new Date(m.created_at).getTime() - new Date(anyLastStaff.created_at).getTime()) / H : null,
      });
      if (m.image_type === "id_document") f.idDocs.push(m.created_at);
      continue;
    }
    if (!t.trim()) continue;
    customerTexts.push({ at: m.created_at, text: t });
    const single = isApplicationFormMessage(t);
    if (single.detected) {
      f.formTexts.push({ at: m.created_at, type: single.formType ?? "", joined: false, keywords: single.matchedKeywords });
      f.formShapes.push({ at: m.created_at, len: t.length, lines: t.split("\n").length, fields: (t.match(FORM_FIELD_RE) ?? []).length, question: /[?？]|ですか|でしょうか|できますか|可能で/.test(t) });
      continue;
    }
    if (hasApplyHintKeyword(t)) {
      // 本番と同じ分割送信フォールバック: 直近8件のお客様テキストを結合
      const joined = customerTexts.slice(-8).map((c) => c.text).join("\n");
      const j = isApplicationFormMessage(joined);
      if (j.detected) f.formTexts.push({ at: m.created_at, type: j.formType ?? "", joined: true, keywords: j.matchedKeywords });
    }
  }
  return f;
}

// ── 昇格条件の候補（純粋に Facts だけで決まる）────────────────────────────
type Cand = { key: string; label: string; test: (f: Facts) => boolean };
const CANDS: Cand[] = [
  { key: "now", label: "【旧の本番】フォーム文 ＋ 画像の旗（72h以内のスタッフ申込書依頼の直後の画像）", test: (f) => f.formTexts.length > 0 && f.images.some((i) => i.staffAskedWithin72h) },
  { key: "new", label: "【直した後の本番】フォーム文 ＋（画像の旗[語 or 本人確認書類] or 14日以内に先行する AIX申込へ）", test: (f) => simulateNewProduction(f).promote },
  { key: "text_only", label: "A1: フォーム文だけ（2026-08-20 以前の形）", test: (f) => f.formTexts.length > 0 },
  { key: "text_single", label: "A1': フォーム文（単発検知のみ・結合フォールバックなし）", test: (f) => f.formTexts.some((t) => !t.joined) },
  { key: "text_img7d", label: "A2: フォーム文 ＋ 前後7日以内にお客様の画像", test: (f) => f.formTexts.some((t) => f.images.some((i) => Math.abs(new Date(i.at).getTime() - new Date(t.at).getTime()) <= 7 * D)) },
  { key: "text_iddoc14d", label: "A3: フォーム文 ＋ 前後14日以内に本人確認書類（image_type=id_document）", test: (f) => f.formTexts.some((t) => f.idDocs.some((d) => Math.abs(new Date(d).getTime() - new Date(t.at).getTime()) <= 14 * D)) },
  { key: "text_iddoc_or_push", label: "A3': フォーム文 ＋（14日以内の本人確認書類 または 先行する AIX【申込へ】）", test: (f) => f.formTexts.some((t) => f.idDocs.some((d) => Math.abs(new Date(d).getTime() - new Date(t.at).getTime()) <= 14 * D) || f.applicationPushAt.some((p) => p <= t.at)) },
  { key: "post_apply_flag", label: "A9: スタッフの「申込後」トグル（is_post_apply=true）", test: (f) => f.isPostApply },
  { key: "text_or_post_apply", label: "A10: フォーム文 または is_post_apply=true", test: (f) => f.formTexts.length > 0 || f.isPostApply },
  { key: "text_push", label: "A4: フォーム文 ＋ その前に AIX【申込へ】押下あり", test: (f) => f.formTexts.some((t) => f.applicationPushAt.some((p) => p <= t.at)) },
  { key: "text_staffreq", label: "A5: フォーム文 ＋ その前にスタッフの申込書依頼の発言（期限なし）", test: (f) => f.formTexts.some((t) => f.staffFormRequests.some((s) => s <= t.at)) },
  { key: "text_staffreq14d", label: "A5': フォーム文 ＋ 14日以内前にスタッフの申込書依頼の発言", test: (f) => f.formTexts.some((t) => f.staffFormRequests.some((s) => s <= t.at && new Date(t.at).getTime() - new Date(s).getTime() <= 14 * D)) },
  { key: "text_push_or_req", label: "A6: フォーム文 ＋（AIX【申込へ】または申込書依頼の発言）が先にある", test: (f) => f.formTexts.some((t) => f.applicationPushAt.some((p) => p <= t.at) || f.staffFormRequests.some((s) => s <= t.at)) },
  { key: "iddoc_only", label: "A7: 本人確認書類の画像だけ", test: (f) => f.idDocs.length > 0 },
  { key: "text_or_iddoc_after_push", label: "A8: AIX【申込へ】の後に（フォーム文 または 本人確認書類）", test: (f) => f.applicationPushAt.some((p) => f.formTexts.some((t) => t.at >= p) || f.idDocs.some((d) => d >= p)) },
];

async function main() {
  const convs = await all<Conv>((a, b) => sb.from("conversations")
    .select("id, status, brain_strategy, applying_text_received, applying_image_received, is_post_apply, status_manual_back_at, updated_at").range(a, b));
  const stageOf = (c: Conv) => ({ rs: STATUS_STAGE[c.status ?? ""], rb: BRAIN_STAGE[String(c.brain_strategy?.checkpoint_stage ?? "")] });
  const active = convs.filter((c) => c.brain_strategy && !(c.status ?? "").startsWith("closed"));
  const lagging = active.filter((c) => { const { rs, rb } = stageOf(c); return rs !== undefined && rb !== undefined && rs < rb; });
  const laggingToApply = lagging.filter((c) => (stageOf(c).rb ?? 0) >= 3);      // ブレインは申込以降
  // 昇格すべきでない会話: status が申込前 かつ ブレインも申込前（hearing/proposing/viewing）かつ is_post_apply=false
  const shouldNot = convs.filter((c) => PRE_APPLY_STATUSES.includes(c.status ?? "") && !c.is_post_apply && c.brain_strategy && (stageOf(c).rb ?? 9) <= 2);
  // スタッフが手で申込以降→申込前に戻した会話（否決など・自動で戻してはいけない）
  const stages = await all<Stage>((a, b) => sb.from("conversation_stage_history").select("conversation_id, from_status, to_status, trigger, changed_at").order("changed_at").range(a, b));
  const manualBackIds = new Set(stages.filter((s) => s.trigger === "manual" && (STATUS_STAGE[s.from_status ?? ""] ?? -1) >= 3 && PRE_APPLY_STATUSES.includes(s.to_status)).map((s) => s.conversation_id));
  const manualBack = convs.filter((c) => manualBackIds.has(c.id) && PRE_APPLY_STATUSES.includes(c.status ?? ""));

  console.log(`=== 会話 ${convs.length}件 ／ 進行中で brain_strategy あり ${active.length}件 ／ DB status がブレインより後ろ ${lagging.length}件（うちブレインが申込以降 ${laggingToApply.length}件）===`);
  console.log(`    昇格すべきでない会話（status も ブレインも申込前・is_post_apply=false）${shouldNot.length}件 ／ スタッフが手で申込前に戻した会話 ${manualBack.length}件`);

  // 対象会話のメッセージ・AIX を取る
  const targetIds = Array.from(new Set([...lagging.map((c) => c.id), ...shouldNot.map((c) => c.id), ...manualBack.map((c) => c.id)]));
  const msgs: Msg[] = [];
  for (let i = 0; i < targetIds.length; i += 40) {
    const batch = targetIds.slice(i, i + 40);
    msgs.push(...await all<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, image_type, is_aix_generated").in("conversation_id", batch).order("created_at").range(a, b)));
  }
  const aix = await all<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").in("conversation_id", targetIds).range(a, b));
  const msgsBy = new Map<string, Msg[]>(); for (const m of msgs) { const l = msgsBy.get(m.conversation_id) ?? []; l.push(m); msgsBy.set(m.conversation_id, l); }
  const aixBy = new Map<string, Aix[]>(); for (const a of aix) { const l = aixBy.get(a.conversation_id) ?? []; l.push(a); aixBy.set(a.conversation_id, l); }
  const factsBy = new Map<string, Facts>();
  const convById = new Map(convs.map((c) => [c.id, c]));
  for (const id of targetIds) factsBy.set(id, factsOf(msgsBy.get(id) ?? [], aixBy.get(id) ?? [], convById.get(id)!));
  const stagesBy = new Map<string, Stage[]>(); for (const s of stages) { const l = stagesBy.get(s.conversation_id) ?? []; l.push(s); stagesBy.set(s.conversation_id, l); }

  // ── ⓪ 段階を持つ場所が DB に何か所あるか（status / is_post_apply / brain）────────
  const postApplyPre = convs.filter((c) => c.is_post_apply && PRE_APPLY_STATUSES.includes(c.status ?? ""));
  const postApplyAll = convs.filter((c) => c.is_post_apply);
  console.log(`\n=== ⓪ is_post_apply（スタッフの「申込後」トグル・page.tsx の会話メニュー）と status ===`);
  console.log(`    is_post_apply=true ${postApplyAll.length}件のうち status が申込前のまま ${postApplyPre.length}件（${pct(postApplyPre.length, postApplyAll.length)}）`);
  console.log(`    ⚠ トグルは status を進めない（解除時だけ proposing に戻す）＝「段階を2か所で持つと片方だけ進む」の実物`);
  const lagPost = lagging.filter((c) => c.is_post_apply).length;
  console.log(`    DB status がブレインより後ろの ${lagging.length}件のうち is_post_apply=true ${lagPost}件`);

  // ── ① 後ろの会話の実物 ─────────────────────────────────────────
  console.log(`\n=== ① DB status がブレインより後ろの ${lagging.length}件: 申込フォーム・画像・スタッフ依頼の実物（時系列）===`);
  let withForm = 0, withImg = 0, imgFlagShouldBe = 0, formAfterPush = 0, formAfterStaffReq = 0;
  const gapBuckets: number[] = [];
  for (const c of lagging.sort((a, b) => (stageOf(b).rb ?? 0) - (stageOf(a).rb ?? 0))) {
    const f = factsBy.get(c.id)!;
    const { rs, rb } = stageOf(c);
    const hasForm = f.formTexts.length > 0; if (hasForm) withForm++;
    if (f.images.length > 0) withImg++;
    const imgShould = f.images.some((i) => i.staffAskedWithin72h); if (imgShould) imgFlagShouldBe++;
    const firstForm = f.formTexts[0]?.at;
    if (firstForm && f.applicationPushAt.some((p) => p <= firstForm)) formAfterPush++;
    if (firstForm && f.staffFormRequests.some((s) => s <= firstForm)) formAfterStaffReq++;
    console.log(`\n  [${short(c.id)}] status=${c.status}(${rs}) ブレイン=${c.brain_strategy?.checkpoint_stage}(${rb}) 旗: text=${c.applying_text_received ? 1 : 0} image=${c.applying_image_received ? 1 : 0} is_post_apply=${c.is_post_apply ? 1 : 0} 手戻し=${c.status_manual_back_at ? fmt(c.status_manual_back_at) : "-"}`);
    const events: { at: string; line: string }[] = [];
    for (const t of f.formTexts) events.push({ at: t.at, line: `お客様: 申込フォーム文（${t.type}${t.joined ? "・結合" : ""}・語=${t.keywords.slice(0, 4).join("/")}）` });
    for (const i of f.images) {
      // 画像は多いので「本人確認書類」「申込書依頼直後」「フォーム文の前後3日」だけ出す
      const nearForm = f.formTexts.some((t) => Math.abs(new Date(i.at).getTime() - new Date(t.at).getTime()) <= 3 * D);
      if (i.imageType === "id_document" || i.staffAskedWithin72h || nearForm) {
        events.push({ at: i.at, line: `お客様: 画像 type=${i.imageType ?? "null"} 直前スタッフ発言に申込書依頼(72h)=${i.staffAskedWithin72h ? "○" : "×"} 直前スタッフ発言からの間隔=${i.lastStaffGapH === null ? "-" : i.lastStaffGapH.toFixed(1) + "h"}` });
        if (i.lastStaffGapH !== null && nearForm) gapBuckets.push(i.lastStaffGapH);
      }
    }
    for (const s of f.staffFormRequests) events.push({ at: s, line: `スタッフ: 申込書依頼の語あり（/申込書|申込用紙|ご記入|入居申込/）` });
    for (const p of f.applicationPushAt) events.push({ at: p, line: `AIX【申込へ】押下` });
    const totalImgs = f.images.length;
    events.sort((a, b) => a.at.localeCompare(b.at));
    for (const e of events.slice(-14)) console.log(`     ${fmt(e.at)}  ${e.line}`);
    if (events.length > 14) console.log(`     …（先頭 ${events.length - 14}件は省略）`);
    console.log(`     画像 合計${totalImgs}枚 ／ 本人確認書類 ${f.idDocs.length}枚 ／ フォーム文 ${f.formTexts.length}通 ／ 申込書依頼の発言 ${f.staffFormRequests.length}通 ／ AIX申込へ ${f.applicationPushAt.length}回`);
    console.log(`     会話: ${f.msgCount}通（お客様 ${f.customerCount}）${f.firstAt ? fmt(f.firstAt) : "-"} 〜 ${f.lastAt ? fmt(f.lastAt) : "-"} ／ 戦略の更新 ${String(c.brain_strategy?.strategy_analyzed_at ?? "").slice(0, 10) || "-"} ／ 履歴: ${(stagesBy.get(c.id) ?? []).map((s) => `${s.from_status ?? "?"}→${s.to_status}(${s.trigger})`).join(" ") || "-"}`);
    if (f.pushFollowKeywords.length) console.log(`     AIX【申込へ】直後のスタッフ発言に含まれる語: ${f.pushFollowKeywords.join("・")}`);
  }
  const noEvidence = laggingToApply.filter((c) => { const f = factsBy.get(c.id)!; return f.formTexts.length === 0 && f.idDocs.length === 0 && f.applicationPushAt.length === 0; });
  console.log(`\n  ⚠ 申込の証拠（フォーム文・本人確認書類・AIX申込へ）が会話に1つも無いのにブレインが申込以降: ${noEvidence.length}/${laggingToApply.length}件（うち is_post_apply=true ${noEvidence.filter((c) => c.is_post_apply).length}件）`);
  for (const c of noEvidence) { const f = factsBy.get(c.id)!; console.log(`     [${short(c.id)}] status=${c.status} brain=${c.brain_strategy?.checkpoint_stage} is_post_apply=${c.is_post_apply ? 1 : 0} 会話${f.msgCount}通 ${f.firstAt ? fmt(f.firstAt) : "-"}〜${f.lastAt ? fmt(f.lastAt) : "-"} 戦略更新=${String(c.brain_strategy?.strategy_analyzed_at ?? "").slice(0, 10) || "-"}`); }
  // AIX【申込へ】の直後の発言に、本番の画像条件の語（申込書|申込用紙|ご記入|入居申込）があるか
  const kwCount = new Map<string, number>();
  let pushConvs = 0;
  for (const id of targetIds) { const f = factsBy.get(id)!; if (!f.applicationPushAt.length) continue; pushConvs++; for (const k of f.pushFollowKeywords) kwCount.set(k, (kwCount.get(k) ?? 0) + 1); }
  console.log(`\n  AIX【申込へ】を押した会話 ${pushConvs}件で、押した直後2h以内のスタッフ発言に含まれる語（会話数）: ${[...kwCount].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  console.log(`    → 本番の画像の旗の語（申込書・申込用紙・ご記入・入居申込）がここに無ければ、AIX で申込を案内する運用では画像の旗は一生立たない`);
  console.log(`\n  まとめ: フォーム文あり ${withForm}/${lagging.length} ／ 画像あり ${withImg} ／ 本番の画像条件（72h以内の申込書依頼の直後）に当たる画像がある会話 ${imgFlagShouldBe}件`);
  console.log(`          フォーム文の前に AIX【申込へ】あり ${formAfterPush}/${withForm} ／ フォーム文の前にスタッフの申込書依頼の発言あり ${formAfterStaffReq}/${withForm}`);
  if (gapBuckets.length) {
    const s = gapBuckets.slice().sort((a, b) => a - b);
    console.log(`          フォーム前後3日の画像で「直前スタッフ発言からの間隔」: 中央値 ${s[Math.floor(s.length / 2)].toFixed(1)}h ／ 72h超 ${s.filter((g) => g > 72).length}/${s.length}`);
  }

  // ── ② 候補ごとの拾い率と誤昇格 ───────────────────────────────────
  console.log(`\n=== ② 昇格条件の候補: 拾う（後ろの会話・ブレイン申込以降 ${laggingToApply.length}件）／ 誤昇格（昇格すべきでない ${shouldNot.length}件・手戻し ${manualBack.length}件）===`);
  console.log(`    ${"候補".padEnd(64)} 拾う      誤昇格(申込前)  誤昇格(手戻し)`);
  const fpDetail = new Map<string, string[]>();
  for (const cd of CANDS) {
    const hit = laggingToApply.filter((c) => cd.test(factsBy.get(c.id)!)).length;
    const fpA = shouldNot.filter((c) => cd.test(factsBy.get(c.id)!));
    const fpB = manualBack.filter((c) => cd.test(factsBy.get(c.id)!));
    console.log(`    ${cd.label.padEnd(64)} ${String(hit).padStart(3)}/${laggingToApply.length}   ${String(fpA.length).padStart(4)}/${shouldNot.length}        ${String(fpB.length).padStart(3)}/${manualBack.length}`);
    fpDetail.set(cd.key, [...fpA.map((c) => `申込前:${short(c.id)} status=${c.status} brain=${c.brain_strategy?.checkpoint_stage}`), ...fpB.map((c) => `手戻し:${short(c.id)} status=${c.status} brain=${c.brain_strategy?.checkpoint_stage}`)]);
  }

  // ── ③ 誤昇格の実物（目で読む）─────────────────────────────────
  // 直した後の本番: 拾う側の内訳（どの根拠で・いつ昇格するか）と、拾えない側の理由
  console.log(`\n=== ②' 直した後の本番: 拾う ${laggingToApply.length}件の内訳 ===`);
  const reasonCount = new Map<string, number>();
  const missed: string[] = [];
  for (const c of laggingToApply) {
    const f = factsBy.get(c.id)!;
    const s = simulateNewProduction(f);
    if (s.promote) { reasonCount.set(s.reason ?? "?", (reasonCount.get(s.reason ?? "?") ?? 0) + 1); console.log(`     拾う [${short(c.id)}] ${s.at ? fmt(s.at) : "-"} reason=${s.reason} 手戻し=${c.status_manual_back_at ? "○（本番では manual_back で止まる）" : "×"} is_post_apply=${c.is_post_apply ? 1 : 0}`); }
    else missed.push(`[${short(c.id)}] フォーム文=${f.formTexts.length} 本人確認=${f.idDocs.length} 申込へ=${f.applicationPushAt.length} 語の画像=${f.images.filter((i) => i.staffAskedWithin72h).length} is_post_apply=${c.is_post_apply ? 1 : 0}`);
  }
  console.log(`     根拠の内訳: ${[...reasonCount].map(([k, n]) => `${k}=${n}`).join(" ") || "-"}`);
  console.log(`     拾えない ${missed.length}件（フォーム文なし＝お客様の意思の記録が無い／古いフォーム／申込へだけ 等。status の修復は別スクリプト）:`);
  for (const m of missed) console.log(`        ${m}`);

  console.log(`\n=== ③ 誤昇格の実物（候補ごと・昇格すべきでない会話で true になった物）===`);
  for (const cd of CANDS) {
    const d = fpDetail.get(cd.key) ?? [];
    if (d.length === 0) { console.log(`  ${cd.key}: 0件`); continue; }
    console.log(`  ${cd.key}: ${d.length}件`);
    for (const line of d.slice(0, 12)) {
      const id = line.split(":")[1].split(" ")[0];
      const c = convs.find((x) => x.id.startsWith(id))!;
      const f = factsBy.get(c.id)!;
      const ft = f.formTexts[0];
      const brainSummary = String(c.brain_strategy?.next_steps ?? c.brain_strategy?.closing_strategy ?? "").replace(/\s+/g, " ").slice(0, 70);
      console.log(`     ${line} 手戻し=${c.status_manual_back_at ? "○" : "×"} is_post_apply=${c.is_post_apply ? 1 : 0} フォーム文=${ft ? `${fmt(ft.at)} ${ft.type}${ft.joined ? "(結合)" : ""} 語=${ft.keywords.slice(0, 4).join("/")}` : "-"} 本人確認=${f.idDocs.length} 申込へ=${f.applicationPushAt.length} 依頼発言=${f.staffFormRequests.length}`);
      const shapes = f.formShapes.map((s) => `${fmt(s.at)} ${s.len}字/${s.lines}行/項目${s.fields}${s.question ? "/疑問形" : ""}`).join(" ｜ ");
      if (shapes) console.log(`        フォーム文の形: ${shapes}`);
      console.log(`        履歴: ${(stagesBy.get(c.id) ?? []).map((s) => `${fmt(s.changed_at)} ${s.from_status ?? "?"}→${s.to_status}(${s.trigger})`).join(" ") || "-"} ／ 会話 ${f.firstAt ? fmt(f.firstAt) : "-"}〜${f.lastAt ? fmt(f.lastAt) : "-"}`);
      if (brainSummary) console.log(`        ブレイン: ${brainSummary}`);
    }
    if (d.length > 12) console.log(`     …（残り ${d.length - 12}件）`);
  }

  // ── ⑤ 全件: 申込フォーム検知（テキスト）の線 ─────────────────────────
  //   即時キーワード（法人契約・入居申込 等）1語だけで detected になる文が、実際に申込に至った会話にどれだけあるか。
  //   「申込に至った」＝ status が申込以降 / is_post_apply / 履歴に申込以降 / AIX【申込へ】あり / 本人確認書類あり のいずれか
  console.log(`\n=== ⑤ 全件（365日）: お客様のテキストで isApplicationFormMessage が true になった文の形と、会話が申込に至ったか ===`);
  const since = new Date(Date.now() - 365 * D).toISOString();
  const custAll = await all<{ conversation_id: string; text: string | null; created_at: string }>((a, b) => sb.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").gte("created_at", since).order("created_at").range(a, b));
  const aixAll = await all<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").eq("aix_type", "application_push").range(a, b));
  const idDocAll = await all<{ conversation_id: string }>((a, b) => sb.from("messages").select("conversation_id").eq("image_type", "id_document").range(a, b));
  const pushConvIds = new Set(aixAll.map((a) => a.conversation_id));
  const idDocConvIds = new Set(idDocAll.map((m) => m.conversation_id));
  const reachedApply = (id: string) => {
    const c = convById.get(id);
    const st = c?.status ?? "";
    return (STATUS_STAGE[st] ?? 0) >= 3 || !!c?.is_post_apply || (stagesBy.get(id) ?? []).some((s) => (STATUS_STAGE[s.to_status] ?? 0) >= 3) || pushConvIds.has(id) || idDocConvIds.has(id);
  };
  type Bucket = { n: number; reached: number; convs: Set<string>; convsNot: Set<string> };
  const buckets = new Map<string, Bucket>();
  const bump = (k: string, id: string) => { const b = buckets.get(k) ?? { n: 0, reached: 0, convs: new Set(), convsNot: new Set() }; b.n++; b.convs.add(id); if (reachedApply(id)) b.reached++; else b.convsNot.add(id); buckets.set(k, b); };
  const notReachedSamples = new Map<string, string[]>();
  for (const m of custAll) {
    const t = m.text ?? ""; if (!t.trim() || IMAGE_RE.test(t)) continue;
    const r = isApplicationFormMessage(t); if (!r.detected) continue;
    const fields = (t.match(FORM_FIELD_RE) ?? []).length;
    const immediate = r.matchedKeywords.length === 1 && /法人御契約|法人契約|法人名義|入居申込書|入居申込|申込みフォーム|申込フォーム|申し込み書/.test(r.matchedKeywords[0]);
    const key = `${r.formType}/${immediate ? "即時語" : "項目数"}/項目${fields === 0 ? "0" : fields < 3 ? "1-2" : fields < 8 ? "3-7" : "8+"}`;
    bump(key, m.conversation_id);
    if (!reachedApply(m.conversation_id)) {
      const l = notReachedSamples.get(key) ?? [];
      if (l.length < 6) l.push(`${short(m.conversation_id)} ${fmt(m.created_at)} ${t.length}字/${t.split("\n").length}行 語=${r.matchedKeywords.slice(0, 3).join("/")} 疑問形=${/[?？]|ですか|でしょうか|できますか|可能で/.test(t) ? "○" : "×"} status=${convById.get(m.conversation_id)?.status ?? "?"}`);
      notReachedSamples.set(key, l);
    }
  }
  console.log(`    ${"形（種別/当たり方/項目数）".padEnd(34)} 文数   会話数  申込に至った会話  至っていない会話`);
  for (const [k, b] of [...buckets].sort((x, y) => y[1].n - x[1].n)) {
    const reachedConvs = [...b.convs].filter(reachedApply).length;
    console.log(`    ${k.padEnd(34)} ${String(b.n).padStart(4)}   ${String(b.convs.size).padStart(4)}    ${String(reachedConvs).padStart(4)}（${pct(reachedConvs, b.convs.size)}）   ${String(b.convsNot.size).padStart(4)}`);
  }
  console.log(`    申込に至っていない会話の実物（形ごと・最大6件・本文は出さない）:`);
  for (const [k, l] of notReachedSamples) { console.log(`     ${k}`); for (const s of l) console.log(`        ${s}`); }

  // ── ⑥ 手で戻した会話で、戻した後にお客様のヒント語が来て結合再判定が再発火するか ─────
  console.log(`\n=== ⑥ 手で申込前に戻した会話 ${manualBack.length}件: 戻した後のお客様テキストに申込ヒント語（氏名/勤務先/保証人 等）が来て、直近8件結合で再検知される件数 ===`);
  let refire = 0;
  for (const c of manualBack) {
    const backAt = c.status_manual_back_at ?? (stagesBy.get(c.id) ?? []).filter((s) => s.trigger === "manual" && PRE_APPLY_STATUSES.includes(s.to_status)).map((s) => s.changed_at).sort().pop() ?? null;
    if (!backAt) continue;
    const ms = (msgsBy.get(c.id) ?? []).filter((m) => m.sender === "customer" && (m.text ?? "").trim() && !IMAGE_RE.test(m.text ?? "")).sort((a, b) => a.created_at.localeCompare(b.created_at));
    let hit = false;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].created_at <= backAt) continue;
      const t = ms[i].text ?? "";
      if (isApplicationFormMessage(t).detected) { hit = true; break; }
      if (hasApplyHintKeyword(t) && isApplicationFormMessage(ms.slice(Math.max(0, i - 7), i + 1).map((x) => x.text ?? "").join("\n")).detected) { hit = true; break; }
    }
    if (hit) refire++;
    console.log(`     [${short(c.id)}] 戻した時刻=${fmt(backAt)} 戻した後のお客様テキスト ${ms.filter((m) => m.created_at > backAt).length}通 → 再検知 ${hit ? "○（テキストだけの昇格なら申込中へ戻る）" : "×"}`);
  }
  console.log(`    再検知される会話 ${refire}/${manualBack.length} → 昇格の前に status_manual_back_at を見る（手で戻した会話は自動で進めない）線が要る`);

  // ── ⑦ 証拠なしでブレインが申込以降の会話: 戦略の出所 ────────────────
  console.log(`\n=== ⑦ 証拠なしでブレインが申込以降 ${noEvidence.length}件の brain_strategy の出所（source / strategy_count / strategy_msg_ts）===`);
  for (const c of noEvidence) {
    const s = c.brain_strategy ?? {};
    console.log(`     [${short(c.id)}] stage=${s.checkpoint_stage} source=${s.source ?? "-"} count=${s.strategy_count ?? "-"} msg_ts=${String(s.strategy_msg_ts ?? "").slice(0, 10) || "-"} analyzed=${String(s.strategy_analyzed_at ?? "").slice(0, 10) || "-"} closing=${String(s.closing_strategy ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
  }

  // ── ④ 読む側の補正（案B）が効く範囲 ────────────────────────────
  const brainApplyFresh = laggingToApply.filter((c) => {
    const at = String(c.brain_strategy?.strategy_analyzed_at ?? "");
    return at ? (Date.now() - new Date(at).getTime()) <= 14 * D : false;
  });
  console.log(`\n=== ④ 案B（読む側を checkpoint_stage で前進方向だけ補正）の効く範囲 ===`);
  console.log(`    後ろの会話（ブレイン申込以降）${laggingToApply.length}件のうち、brain_strategy の更新が14日以内 ${brainApplyFresh.length}件`);
  console.log(`    ⚠ 案B は STATUS_MEANING・成約実例の段階一致・DRAFT_SKIP_STATUSES の3か所を直す。case A（昇格）は DB を1か所直せば3か所とも同時に直る`);
}

main().catch((e) => { console.error(e); process.exit(1); });
