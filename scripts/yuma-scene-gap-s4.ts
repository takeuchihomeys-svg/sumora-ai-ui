// 実物の場面を YUMA に写し、ブレインごと1回（bg-async）＋生成側を直接（generate-reply）で回して、実送信と並べる
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
//
// 【2段の理由】（設計知見の2本は矛盾ではなく順番の話）
//   ・「YUMA の bg-async は AIX 誘導で止まる → 生成側は generate-reply 直接」
//   ・「直接叩くと DB の古い AIX 判断が本文に出る → ブレインごと回す」
//   → bg-async でブレインを新しくしてから **60秒以内** に直接叩く（generate-reply route.ts の stale rerun は
//     brain が fresh でない＋60秒超の時だけ走る）。判断は写した場面の物になる。
//
// 【前提が作れたか】（設計知見「作れていない検証は結果が全部0」）毎回3つを確かめ、1つでも違えば「無効」で数えない:
//   ① messages の最新が写した発言か ② brain_analyzed_at ≥ 開始時刻 ③ suggested_aix_meta.analyzed_msg_ts が写した発言の時刻
//
// ⚠ 書き込みは YUMA（dd34f5b0…）だけ。写した messages・aix_action_items・automation_commands・line_tasks は id/時刻で消し、
//   conversations は scripts/.yuma-backup.json（yuma-snapshot save）から戻す。本名・電話・URL は出力に書かない。
//
// 実行: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts save
//       npx tsx --env-file=.env.local scripts/yuma-scene-gap.ts [SCENE=S4] [REPS=3] [ONLY=A,B] [OUT=path.json]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { MSG_SEP } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const BACKUP = "scripts/.yuma-backup.json";
const REPS = Number(process.env.REPS ?? 3);
const OUT = process.env.OUT ?? "scripts/.yuma-scene-gap-out.jsonl";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 実物（今月の S4・成約側を優先）。conv は id の先頭8桁・at は対象発言の created_at（UTC）の先頭16桁 */
type Case = { id: string; conv: string; at: string; kind: string; real: string; realAix: string };
const CASES: Record<string, Case[]> = {
  S4: [
    { id: "A", conv: "fb8ab8d5", at: "2026-09-12T11:06", kind: "並行の依頼", realAix: "なし", real: "かしこまりました！！\n並行して審査かけさせて頂きます😌！！" },
    { id: "B", conv: "5752c0d1", at: "2026-09-10T03:45", kind: "条件の再確認（ここのみ？）", realAix: "なし", real: "はい！！\n中型犬飼育可能なお部屋は〈物件〉303号室のみとなります！！" },
    { id: "C", conv: "9280fa49", at: "2026-09-03T10:29", kind: "内見したい（複数）", realAix: "なし", real: "〈お客様〉さん\nお部屋お送りいただきありがとうございます😊！！\n\n内覧複数件回りたい旨かしこまりました！！\nお部屋の募集状況と内覧可否も一緒にお送りさせていただきます！！" },
    { id: "D", conv: "d3f7f5f3", at: "2026-09-06T02:34", kind: "申込だけお願い（4件）", realAix: "なし", real: "かしこまりました！！\n上記4件お申込みさせていただきます😊！！\n\nお申込み完了しましたら、それぞれの受付番手確認させていただきます！！" },
    { id: "E", conv: "6fdadc8b", at: "2026-09-12T09:45", kind: "短い了承", realAix: "なし", real: "はい😊！！\n気になる点出て来ましたら何時でもお気軽にご連絡ください！！\nそれでは一度失礼致します😌！！" },
    { id: "F", conv: "22b2511e", at: "2026-09-18T05:04", kind: "入居可能日の再確認", realAix: "なし", real: "はい！！\n最短で11月中旬から下旬でのご入居可能となります！！\n\n退去予定のお部屋となりますのでお気に召されましたらお申込みさせていただきます😊！！\n\nお手隙の際にご確認下さい！！" },
    { id: "G", conv: "749c5559", at: "2026-09-13T09:32", kind: "最短入居の質問", realAix: "なし", real: "こちら退去後クリーニング、鍵交換完了後ご入居可能です！！\n2週間〜3週間程必要となりますので\n🌟10月中旬以降のご入居となります！！" },
    { id: "H", conv: "969f0162", at: "2026-09-20T02:53", kind: "決めた・支払いは10/9", realAix: "application_push", real: "かしこまりました！！\nよろしければ一度お申込しお部屋を抑えた状態でご内覧如何でしょうか😌！！\n\n保証会社の審査通過後オーナー審査開始までキャンセル料かかりませんで、お部屋抑えるのを推奨させて頂きます！！" },
    { id: "I", conv: "8b5a777e", at: "2026-09-12T13:12", kind: "安い理由の質問", realAix: "estimate_sheet×2", real: "仲介手数料は0円で大丈夫です！！〈会社〉に還元させて頂いている仕組みのため、初期費用を一般よりお安くご提案出来ております！！\n\n金額差はこの還元の有無によるものですので、ご安心ください😊！！" },
    { id: "J", conv: "60e6d3ab", at: "2026-09-01T10:21", kind: "退去時費用の質問", realAix: "viewing_invite,meeting_place", real: "エルシオン\n退去時クリーニング費用　¥44,000円\n\nKANOACIA\n退去時クリーニング費用　¥27,500円\n\nKTIレジデンス新深江\n退去時費用記載ございませんでしたので、明日確認させていただきます😊！！" },
  ],
};

type Msg = { id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; quoted_message_id?: string | null };

function maskWith(names: string[]) {
  return (s: string) => {
    let t = s;
    for (const n of names) if (n && n.length >= 2) t = t.split(n).join("〈お客様〉");
    return t.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,8}(?:さん|様|さま)/g, "〈お客様〉").replace(/\d{2,4}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/https?:\/\/\S+/g, "〈URL〉");
  };
}
function formatConditions(pc: Record<string, unknown>): string {
  const lines: string[] = [];
  if (pc.desired_area) lines.push(`エリア: ${pc.desired_area}`);
  if (pc.floor_plan) lines.push(`間取り: ${pc.floor_plan}`);
  const rent: string[] = [];
  if (pc.rent_min) rent.push(`${Number(pc.rent_min) / 10000}万円〜`);
  if (pc.rent_max) rent.push(`${Number(pc.rent_max) / 10000}万円以内`);
  if (rent.length) lines.push(`家賃: ${rent.join("")}`);
  if (pc.walk_minutes) lines.push(`駅徒歩: ${pc.walk_minutes}分以内`);
  if (pc.move_in_time) lines.push(`入居: ${pc.move_in_time}`);
  if (pc.building_age) lines.push(`築年数: ${pc.building_age}年以内`);
  if (pc.preferences) lines.push(`希望: ${pc.preferences}`);
  if (pc.ng_points) lines.push(`NG: ${pc.ng_points}`);
  if (pc.other_requests) lines.push(`その他: ${pc.other_requests}`);
  if (typeof pc.additional_conditions === "string") {
    const clean = pc.additional_conditions.split("\n").map((l) => l.replace(/^【[^】]*】/, "").trim()).filter(Boolean).join("、");
    if (clean) lines.push(`追加条件: ${clean}`);
  }
  return lines.join("\n");
}

// 他の実測エージェント（S2〜S8）と同じ印: ai_draft_check に "gap-lock:<場面>:<時刻>" を置き、他人の印がある間は動かさない
const LOCK = `gap-lock:S4:${new Date().toISOString()}`;
async function otherLockHeld(): Promise<string | null> {
  const { data } = await sb.from("conversations").select("ai_draft_check").eq("id", YUMA).maybeSingle();
  const chk = (data as { ai_draft_check?: unknown } | null)?.ai_draft_check;
  const s = typeof chk === "string" ? chk : "";
  return s.startsWith("gap-lock:") && s !== LOCK ? s : null;
}
async function restoreYuma(keepLock = false) {
  if (!existsSync(BACKUP)) throw new Error("控えが無い: 先に yuma-snapshot save");
  const b = JSON.parse(readFileSync(BACKUP, "utf8")) as Record<string, unknown>;
  const { id: _i, customer_name: _n, updated_at: _u, ...rest } = b; void _i; void _n; void _u;
  const { error } = await sb.from("conversations").update({ ...rest, ai_draft_check: keepLock ? LOCK : (rest.ai_draft_check ?? null) }).eq("id", YUMA);
  if (error) throw new Error(`戻せない: ${error.message}`);
}
async function yumaRow() {
  const { data } = await sb.from("conversations").select("status, ai_draft, ai_draft_check, suggested_aix_meta, brain_analyzed_at, has_viewed, property_customer_id, last_sender, draft_pending_at").eq("id", YUMA).maybeSingle();
  return (data ?? {}) as Record<string, unknown>;
}
async function waitForDraft(timeoutMs = 240_000): Promise<{ draft: string; row: Record<string, unknown> }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(4000);
    const row = await yumaRow();
    const d = String(row.ai_draft ?? "");
    if (d && d !== "__SHOWN__") return { draft: d, row };
  }
  return { draft: "", row: await yumaRow() };
}

async function resolveConv(prefix: string): Promise<{ id: string; customer_name: string; status: string; property_customer_id: string | null } | null> {
  const { data } = await sb.from("conversations").select("id, customer_name, status, property_customer_id").limit(3000);
  const hit = ((data ?? []) as Array<{ id: string; customer_name: string; status: string; property_customer_id: string | null }>).find((c) => c.id.startsWith(prefix));
  return hit ?? null;
}

async function runCase(c: Case, T0: string, log: (o: Record<string, unknown>) => void) {
  const conv = await resolveConv(c.conv);
  if (!conv) { log({ case: c.id, invalid: "conv not found" }); return; }
  const mask = maskWith([conv.customer_name]);
  // 元会話: 対象発言（連投含む）までの直近20通
  const { data: allMs } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated, quoted_message_id").eq("conversation_id", conv.id)
    .lte("created_at", `${c.at}:59.999+00:00`).order("created_at", { ascending: false }).limit(40);
  const upto = ((allMs ?? []) as Msg[]).reverse();
  // 対象の発言＝ c.at の分に届いた顧客発言。その後15分以内の顧客連投も含める（監査と同じ束ね方）
  const targetIdx = upto.findIndex((m) => m.sender === "customer" && m.created_at.startsWith(c.at));
  if (targetIdx < 0) { log({ case: c.id, invalid: "target msg not found" }); return; }
  const { data: after } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated, quoted_message_id").eq("conversation_id", conv.id)
    .gt("created_at", upto[targetIdx].created_at).order("created_at", { ascending: true }).limit(6);
  const burst: Msg[] = [upto[targetIdx]];
  for (const m of (after ?? []) as Msg[]) { if (m.sender !== "customer") break; if (Date.parse(m.created_at) - Date.parse(burst[burst.length - 1].created_at) > 15 * 60_000) break; burst.push(m); }
  const src = [...upto.slice(0, targetIdx + 1), ...burst.slice(1)].slice(-20);
  // 元の status（その時点）: ai_reply_examples の conversation_state があればそれ・無ければ proposing（申込以降は下書きを作らない設計なので写せない）
  const { data: exs } = await sb.from("ai_reply_examples").select("conversation_state, aix_action, was_ai_used, ai_draft").eq("conversation_id", conv.id).gte("created_at", `${c.at.slice(0, 10)}T00:00:00+00:00`).lte("created_at", `${c.at.slice(0, 10)}T23:59:59+00:00`);
  const ex = ((exs ?? []) as Array<{ conversation_state: string | null; aix_action: string | null; was_ai_used: boolean | null; ai_draft: string | null }>)[0] ?? null;
  // ai_reply_examples.conversation_state には AIX の種類（property_check_result_available 等）が入っている行もあるので、
  // conversations.status に実在する値だけを採る（それ以外は proposing）
  const STATUSES = new Set(["proposing", "hearing", "property_recommendation", "availability_check", "viewing", "condition_hearing", "first_reply", "property_search", "estimate_request"]);
  const stateAt = ex?.conversation_state && STATUSES.has(ex.conversation_state) ? ex.conversation_state : "proposing";
  // 元の property_customers（画面と同じ材料）
  let customerConditions: string | undefined, customerSummary: string | undefined, customerStructured: Record<string, unknown> | undefined;
  if (conv.property_customer_id) {
    const { data: pc } = await sb.from("property_customers").select("*").eq("id", conv.property_customer_id).maybeSingle();
    if (pc) {
      const p = pc as Record<string, unknown>;
      customerConditions = formatConditions(p) || undefined;
      customerSummary = (p.ai_summary as string | null) ?? undefined;
      customerStructured = { move_in_time: p.move_in_time ?? null, rent_max: p.rent_max ?? null, desired_area: p.desired_area ?? null, walk_minutes: p.walk_minutes ?? null, floor_plan: p.floor_plan ?? null, initial_cost_limit: p.initial_cost_limit ?? null, building_age: p.building_age ?? null, preferences: p.preferences ?? null, ng_points: p.ng_points ?? null, other_requests: p.other_requests ?? null };
    }
  }

  if (process.env.DRY === "1") {
    // 書かない下見: 場面が組めるか（対象の発言・直近20通・status・条件）だけ確かめる
    log({ case: c.id, kind: c.kind, dry: true, stateAt, msgs: src.length, lastIsCustomer: src[src.length - 1]?.sender === "customer", burst: burst.length, hasEstimateInSrc: src.some((m) => m.sender === "staff" && /御見積書|お見積書|見積書同封/.test(m.text ?? "")), customer: mask(src.slice(src.findLastIndex((m) => m.sender === "staff") + 1).map((m) => m.text ?? "").join(" / ")).slice(0, 120), conditions: (customerConditions ?? "").replace(/\n/g, " / ").slice(0, 80), hasSummary: !!customerSummary, exAtTime: ex ? { aix_action: ex.aix_action ?? "通常", was_ai_used: ex.was_ai_used } : null });
    return;
  }
  // ── (i) restore（印は保つ）→ (ii) 写す（時刻を平行移動・名前を YUMA に）──
  const held = await otherLockHeld();
  if (held) { log({ case: c.id, invalid: `他の実測エージェントの印がある: ${held}` }); throw new Error("OTHER_LOCK"); }
  await restoreYuma(true);
  // 他のエージェントの残り物（今日 YUMA に足された発言で、まだ消されていない物）。文脈に混ざるので件数を残す
  const { count: leftovers } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).gte("created_at", "2026-09-23T00:00:00+00:00");
  const lastAt = Date.parse(src[src.length - 1].created_at);
  const offset = (Date.now() - 60_000) - lastAt;
  const rows = src.map((m) => ({
    conversation_id: YUMA, sender: m.sender,
    text: (m.text ?? "").split(conv.customer_name).join("YUMA") || (m.image_url ? "[画像]" : ""),
    image_url: null, // 画像は写さない（Vision の費用と個人情報。本文の「御見積書同封」で台帳は立つ）
    created_at: new Date(Date.parse(m.created_at) + offset).toISOString(),
    is_aix_generated: !!m.is_aix_generated,
  }));
  const ins = await sb.from("messages").insert(rows).select("id, created_at, sender");
  if (ins.error) { log({ case: c.id, invalid: `insert: ${ins.error.message}` }); return; }
  const inserted = (ins.data ?? []) as Array<{ id: string; created_at: string; sender: string }>;
  const insertedIds = inserted.map((r) => r.id);
  const lastInserted = inserted.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)!;
  const custUnits = src.slice(src.findLastIndex((m) => m.sender === "staff") + 1).filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]").slice(-10).map((m) => (m.text ?? "").split(conv.customer_name).join("YUMA"));
  const custText = custUnits.join(MSG_SEP);
  const result: Record<string, unknown> = { case: c.id, kind: c.kind, conv: c.conv, at: c.at, stateAt, real: c.real, realAix: c.realAix, exAtTime: ex ? { aix_action: ex.aix_action ?? "通常", was_ai_used: ex.was_ai_used, ai_draft: mask(ex.ai_draft ?? "").slice(0, 400) } : null, customer: mask(custText) };
  try {
    // (iii)(iv) status を合わせ、customer 番にして bg-async
    await sb.from("conversations").update({ status: stateAt, last_sender: "customer", last_message: custText.slice(0, 200), ai_draft: null, ai_draft_check: LOCK, draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null }).eq("id", YUMA);
    let skipped = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${BASE}/api/generate-draft-bg-async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: YUMA, source: "direct" }) });
        const j = (await res.json()) as Record<string, unknown>;
        skipped = String(j.skipped ?? "");
      } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
      if (skipped !== "in_progress") break;
      await sleep(20_000);
    }
    result.bgSkipped = skipped || null;
    const { draft, row } = await waitForDraft();
    // (v) 前提の確認
    const { data: latest } = await sb.from("messages").select("id, created_at").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1);
    const latestId = ((latest ?? []) as Array<{ id: string }>)[0]?.id;
    const meta = (row.suggested_aix_meta ?? null) as Record<string, unknown> | null;
    const analyzedAt = row.brain_analyzed_at ? Date.parse(String(row.brain_analyzed_at)) : NaN;
    const premise = {
      latestIsCopied: latestId === lastInserted.id,
      brainFresh: Number.isFinite(analyzedAt) && analyzedAt >= Date.parse(T0),
      analyzedMsgMatches: !!meta?.analyzed_msg_ts && Math.abs(Date.parse(String(meta.analyzed_msg_ts)) - Date.parse(lastInserted.created_at)) < 1500,
    };
    result.premise = { ...premise, foreignLeftovers: leftovers ?? null };
    result.valid = premise.latestIsCopied && premise.brainFresh && premise.analyzedMsgMatches;
    result.brain = meta ? {
      action: meta.action ?? null, reply_mode: meta.reply_mode ?? null, decision_source: meta.decision_source ?? null, source: meta.source ?? null,
      reason: mask(String(meta.reason ?? "")).slice(0, 160), note: mask(String(meta.note ?? "")).slice(0, 160),
      reply_direction: mask(String(meta.reply_direction ?? "")).slice(0, 200), pending_pickup: meta.pending_pickup ?? null, dropped_direction: meta.dropped_direction ?? null,
      scene: (meta.scene_evidence as Record<string, unknown> | null)?.scene ?? null, engagement_stance: meta.engagement_stance ?? null, customer_intent: meta.customer_intent ?? null,
      key_topics: meta.key_topics ?? null, avoid_topics: meta.avoid_topics ?? null,
    } : null;
    const { data: bdl } = await sb.from("brain_decision_logs").select("suggested_action, suggested_reply_mode, decision_source, scene_evidence, digest, created_at").eq("conversation_id", YUMA).gte("created_at", T0).order("created_at", { ascending: false }).limit(1);
    const b0 = ((bdl ?? []) as Array<Record<string, unknown>>)[0];
    result.decisionLog = b0 ? { action: b0.suggested_action, reply_mode: b0.suggested_reply_mode, decision_source: b0.decision_source, scene: (b0.scene_evidence as Record<string, unknown> | null)?.scene ?? null, digest: b0.digest ? JSON.stringify(b0.digest).slice(0, 300) : null } : null;
    result.bgDraft = mask(draft);
    result.bgKind = draft === "[AIX誘導中]" ? "aix" : draft === "[返信不要]" ? "no_reply" : draft ? "draft" : "none";
    // (vii) 生成側: 60秒以内に画面と同じ body で直接
    const brainAtMs = Number.isFinite(analyzedAt) ? analyzedAt : Date.now();
    const { data: ym } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(60);
    const ctx = ((ym ?? []) as Array<Record<string, unknown>>).reverse();
    const last25 = ctx.slice(-25);
    const hasStaff = last25.some((m) => m.sender === "staff");
    const lastStaff = !hasStaff ? [...ctx].reverse().find((m) => m.sender === "staff") : undefined;
    const recentMessages = (lastStaff ? [lastStaff, ...last25] : last25).map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated }));
    // replyHint（画面と同じ: 直近8通のスタッフ送信が「【物件名」で始まれば見積書の物件名固定）
    const estimateProp = (() => { for (const m of ctx.filter((m) => m.sender === "staff").slice(-8).reverse()) { const mm = String(m.text ?? "").match(/^【([^\s】]+)/); if (mm) return mm[1]; } return null; })();
    const hint = estimateProp ? `【見積書の物件名固定】直近に送った見積書の物件「${estimateProp}」を使うこと。会話に出てくる他の物件名は絶対に使わない` : undefined;
    const directReps = result.bgKind === "draft" ? Math.max(0, REPS - 1) : REPS;
    const direct: Array<{ text: string; meta: string; ms: number; sinceBrainSec: number }> = [];
    for (let k = 0; k < directReps; k++) {
      const body = { message: custText, customerMessages: custUnits, state: stateAt, conversationId: YUMA, customerName: "YUMA", customerConditions, customerSummary, customerStructured, replyHint: hint, hasViewed: !!row.has_viewed, activeTaskTypes: [] as string[], recentMessages };
      const t = Date.now();
      let text = "", metaLine = "";
      try {
        const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const raw = await res.text();
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) { metaLine = raw.slice(0, 200); text = ""; }
        else { const nl = raw.indexOf("\n"); metaLine = nl >= 0 ? raw.slice(0, nl) : ""; text = nl >= 0 ? raw.slice(nl + 1) : raw; }
      } catch (e) { metaLine = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
      const clean = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
      direct.push({ text: mask(clean), meta: metaLine.slice(0, 200), ms: Date.now() - t, sinceBrainSec: Math.round((t - brainAtMs) / 1000) });
    }
    result.direct = direct;
  } finally {
    // (viii) 片付け
    await sb.from("messages").delete().in("id", insertedIds);
    await sb.from("aix_action_items").delete().eq("conversation_id", YUMA).gte("created_at", T0);
    await sb.from("line_tasks").delete().eq("conversation_id", YUMA).gte("created_at", T0);
    const { data: ac } = await sb.from("automation_commands").select("id, payload").gte("created_at", T0);
    const acIds = ((ac ?? []) as Array<{ id: string; payload: Record<string, unknown> | null }>).filter((r) => r.payload?.source === "aix" && r.payload?.conversation_id === YUMA).map((r) => r.id);
    if (acIds.length) await sb.from("automation_commands").delete().in("id", acIds);
    result.cleanup = { messages: insertedIds.length, automation: acIds.length };
    await restoreYuma(true);
  }
  log(result);
}

async function main() {
  const scene = process.env.SCENE ?? "S4";
  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cases = (CASES[scene] ?? []).filter((c) => !only.length || only.includes(c.id));
  if (!existsSync(BACKUP)) { console.log("先に yuma-snapshot save"); process.exit(1); }
  const before = await yumaRow();
  const held = await otherLockHeld();
  if (held && process.env.FORCE !== "1") { console.log(`⚠ 他の実測エージェントの印がある（${held}）ので動かさない。FORCE=1 で無視`); process.exit(2); }
  if (before.draft_pending_at) console.log(`⚠ YUMA に draft_pending_at=${String(before.draft_pending_at)}（下書き作成中の可能性）`);
  const T0 = new Date().toISOString();
  console.log(`=== ${scene}: ${cases.length}件 × (bg-async 1 + 直接 ${REPS - 1}〜${REPS}) T0=${T0} BASE=${BASE} ===`);
  const log = (o: Record<string, unknown>) => {
    appendFileSync(OUT, JSON.stringify({ T0, ...o }) + "\n", "utf8");
    const d = o.direct as Array<{ text: string; meta: string }> | undefined;
    console.log(`\n【${o.case}】${o.kind ?? ""} valid=${String(o.valid)} bg=${String(o.bgKind)} brain=${JSON.stringify((o.brain as Record<string, unknown> | null) ? { a: (o.brain as Record<string, unknown>).action, m: (o.brain as Record<string, unknown>).reply_mode, s: (o.brain as Record<string, unknown>).decision_source, sc: (o.brain as Record<string, unknown>).scene } : null)} ${o.invalid ? `INVALID: ${o.invalid}` : ""}`);
    console.log(`   客: ${String(o.customer ?? "").replace(/\n/g, " / ").slice(0, 120)}`);
    console.log(`   実: ${String(o.real ?? "").replace(/\n/g, " / ").slice(0, 160)}`);
    if (o.bgDraft) console.log(`   bg: ${String(o.bgDraft).replace(/\n/g, " / ").slice(0, 220)}`);
    for (const [i, x] of (d ?? []).entries()) console.log(`   直${i + 1}: ${x.text.replace(/\n/g, " / ").slice(0, 220) || "(空) " + x.meta.slice(0, 80)}`);
  };
  const dry = process.env.DRY === "1";
  for (const c of cases) {
    try { await runCase(c, T0, log); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "OTHER_LOCK") { console.log("他の印を見つけたので止める（YUMA は触っていない）"); break; }
      log({ case: c.id, invalid: `例外: ${msg}` }); if (!dry) await restoreYuma(true).catch(() => {});
    }
  }
  if (!dry) await restoreYuma(false);
  console.log(`\n=== 完了。出力: ${OUT} ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
