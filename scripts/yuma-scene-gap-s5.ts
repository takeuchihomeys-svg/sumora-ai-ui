// 場面 S5（内覧の日程調整）の実物を YUMA に写し、「ブレインごと1回 → 生成側 3回」で今の生成を出して実送信と並べる
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
//
// 【設計】(a) YUMA 再現 ＝「ブレインごと1回（bg-async）＋生成側 REPS 回（generate-reply 直接・画面と同じ body）」の2段。
//   ・設計知見「bg-async は AIX 誘導で止まる→直接」「直接叩くと古い AIX 判断が出る→ブレインごと」は順番の話。
//     bg-async でブレインを新しくしてから直接叩けば判断は写した場面のもの（stale rerun は fresh でない＋60秒超の時だけ）。
//   ・場面は想像で作らず、元会話の対象発言までの直近 20 通を写す（created_at は平行移動・間隔を保つ／顧客名は YUMA に）。
//   ・毎回「前提が作れたか」（最新発言・brain_analyzed_at・analyzed_msg_ts）を確かめ、作れていない回は無効。
//   ・YUMA は他の実測と共用なので、①ai_draft_check に印 ②直近3分に他人の書き込みが無い、を確かめてから始める。
//     途中で他人の発言が混ざった回は前提チェック（最新発言が自分の物か）で無効になる。
//   ・書き込みは YUMA だけ。写した messages・aix_action_items・line_tasks・automation_commands は消し、
//     conversations は控え（scripts/.yuma-backup-S5.json）から戻す。
//
// 実行: npx tsx --env-file=.env.local scripts/yuma-scene-gap-s5.ts [REPS=3] [BASE_URL=http://localhost:3000] [ONLY=A,B]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SCENE = "S5";
const REPS = Number(process.env.REPS ?? 3);
const BACKUP = `scripts/.yuma-backup-${SCENE}.json`;
const OUT = process.env.OUT ?? `scripts/.yuma-scene-gap-${SCENE}.json`;
const COLS = "id, customer_name, status, ai_draft, ai_draft_check, suggested_aix_meta, last_brain_meta, brain_analyzed_at, brain_strategy, draft_pending_at, draft_attempted_at, last_message, last_sender, updated_at, has_viewed, suggested_next_aix, reply_mode_decision, property_customer_id";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK = `gap-lock:${SCENE}:${new Date().toISOString()}`;

type Sample = { key: string; messageId: string; findText?: string; status: string; label: string };
/** S5 内覧の日程調整（今月の実物・成約側を優先）。status はその時点の状態（aix_usage_logs.conversation_status） */
const SAMPLES: Sample[] = [
  { key: "A", messageId: "f6f682ba-6878-45d2-bd4c-424b1811b2c6", status: "proposing", label: "A ★「条件など含め好条件で気になるのですが内見などはできますか？？」（実送信: 手打ち『はい！！ご都合よろしいお日にちにお部屋ご案内させて頂きます』＋4分後 AIX内覧のご案内で日時）" },
  { key: "B", messageId: "293ad843-5b43-4a0d-ae09-060d289e5b88", status: "proposing", label: "B ★「明日って内見行ける時間ありますか？」（実送信: AIX内覧のご案内『はい😊！！9月2日ですと13:00〜14:00ご内覧可能です！！ご都合如何でしょうか』・そのまま送信）" },
  { key: "E", messageId: "", findText: "%では明日何時ごろオンライン内見できますか%", status: "proposing", label: "E ★「では明日何時ごろオンライン内見できますか？」（実送信: AIX内覧のご案内『はい😊！！9月3日ですと12:00〜16:00ご内覧可能です』・そのまま送信）" },
  { key: "C", messageId: "", findText: "%KANOASIAを優先に内見したいなら今日行けますか%", status: "proposing", label: "C ★「プロスパーコートではなくKANOASIAを優先に内見したいなら今日行けますか？」（AI は『内覧の詳細についてはご連絡させて頂きます』で止まった実物・実送信は本日13:00の具体案）" },
  { key: "D", messageId: "b8d50d27-55ae-4b77-9e7b-9b1f7c876ab9", status: "proposing", label: "D 「2階のお部屋って内覧出来るのはいつ頃でしょうか？💭」（実送信: 手打ち『退去済みのため現在ご内覧可能・ご都合よろしいお日にちにご案内』）" },
];

type MsgRow = { id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; conversation_id: string };
type PcRow = Record<string, unknown>;

/** app/page.tsx formatConditions と同じ形（画面が渡す customerConditions） */
function formatConditions(c: PcRow): string {
  const lines: string[] = [];
  if (c.desired_area) lines.push(`エリア: ${c.desired_area}`);
  if (c.floor_plan) lines.push(`間取り: ${c.floor_plan}`);
  const rent: string[] = [];
  if (c.rent_min) rent.push(`${Number(c.rent_min) / 10000}万円〜`);
  if (c.rent_max) rent.push(`${Number(c.rent_max) / 10000}万円以内`);
  if (rent.length) lines.push(`家賃: ${rent.join("")}`);
  if (c.walk_minutes) lines.push(`駅徒歩: ${c.walk_minutes}分以内`);
  if (c.move_in_time) lines.push(`入居: ${c.move_in_time}`);
  if (c.building_age) lines.push(`築年数: ${c.building_age}年以内`);
  if (c.preferences) lines.push(`希望: ${c.preferences}`);
  if (c.ng_points) lines.push(`NG: ${c.ng_points}`);
  if (c.other_requests) lines.push(`その他: ${c.other_requests}`);
  if (c.additional_conditions) {
    const add = String(c.additional_conditions).split("\n").map((l) => l.replace(/^【[^】]*】/, "").trim()).filter(Boolean).join("、");
    if (add) lines.push(`追加条件: ${add}`);
  }
  return lines.join("\n");
}

/** app/page.tsx の genReplyHint と同じ（first_reply 以外） */
function buildReplyHint(target: string, contextMsgs: Array<{ sender: string; text: string }>): string | undefined {
  const lines = target.split("\n").map((l) => l.trim()).filter(Boolean);
  const short = lines.filter((l) => l.length <= 25);
  const COND = /[0-9０-９]+万|[0-9０-９]+LDK|[0-9０-９]+[KDk]|エリア|区|駅|間取り|家賃|広さ|㎡|ペット|駐車場|築/;
  const ACT = /含めて|を外|に変え|以上|以下|でも可|気にしな|上げて|下げて|緩め|広げ|に絞|でお願い|から探|も探/;
  const PICK = /ありませんか|ありますか|送って|ピックアップ|おすすめ|オススメ|出てます|教えて/;
  let hint = "";
  const recentStaff = contextMsgs.filter((m) => m.sender === "staff").slice(-8).reverse();
  const est = recentStaff.map((m) => (m.text || "").match(/^【([^\s】]+)/)?.[1]).find(Boolean);
  if (est) hint += `【見積書の物件名固定】直近に送った見積書の物件「${est}」を使うこと。会話に出てくる他の物件名は絶対に使わない`;
  if (short.length >= 3) hint = (hint ? hint + "\n" : "") + `【お客様が列挙した条件・要望（返信で具体的に言及すること）】${short.slice(0, 8).join("・")}`;
  else if (lines.some((l) => COND.test(l) && ACT.test(l)) || lines.some((l) => PICK.test(l))) hint = (hint ? hint + "\n" : "") + `【条件変更/ピックアップ依頼（追加質問禁止・変更内容を具体的に言葉にして即行動宣言）】${lines.join("・")}`;
  return hint || undefined;
}

async function readYuma(): Promise<Record<string, unknown>> {
  const { data } = await sb.from("conversations").select(COLS).eq("id", YUMA).maybeSingle();
  return (data ?? {}) as Record<string, unknown>;
}
async function saveBackup() {
  const row = await readYuma();
  const { ai_draft_check: _c, ...rest } = row; void _c;
  writeFileSync(BACKUP, JSON.stringify({ ...rest, ai_draft_check: null }, null, 2), "utf8");
  console.log(`控えた: ${BACKUP}（status=${row.status} last_sender=${row.last_sender}）`);
  return row;
}
async function restore(keepLock: boolean) {
  const b = JSON.parse(readFileSync(BACKUP, "utf8")) as Record<string, unknown>;
  const { id: _i, customer_name: _n, updated_at: _u, property_customer_id: _p, ...rest } = b; void _i; void _n; void _u; void _p;
  if (keepLock) rest.ai_draft_check = LOCK;
  const { error } = await sb.from("conversations").update(rest).eq("id", YUMA);
  if (error) throw new Error(`戻せない: ${error.message}`);
}
/** 他の実測が YUMA を使っていないことを確かめて印を置く（直近3分に他人の書き込みが無い・印が無い） */
async function acquire(maxWaitMs = 40 * 60_000) {
  const t0 = Date.now();
  let told = false;
  while (Date.now() - t0 < maxWaitMs) {
    const { data } = await sb.from("conversations").select("ai_draft_check, draft_attempted_at").eq("id", YUMA).maybeSingle();
    const row = (data ?? {}) as { ai_draft_check?: string | null; draft_attempted_at?: string | null };
    const { data: ms } = await sb.from("messages").select("created_at").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1);
    const lastMsgAt = ((ms ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null;
    const recentMsg = lastMsgAt ? Date.now() - Date.parse(lastMsgAt) < 3 * 60_000 : false;
    const recentAttempt = row.draft_attempted_at ? Date.now() - Date.parse(row.draft_attempted_at) < 5 * 60_000 : false;
    // ai_draft_check は generate-reply が最終チェックの結果（JSON）を書く欄でもある。印は文字列 "gap-lock:" だけを見る
    const chk = typeof row.ai_draft_check === "string" ? row.ai_draft_check : "";
    const otherLock = chk.startsWith("gap-lock:") && chk !== LOCK;
    if (!recentMsg && !recentAttempt && !otherLock) {
      await sb.from("conversations").update({ ai_draft_check: LOCK }).eq("id", YUMA);
      await sleep(3000);
      const { data: re } = await sb.from("conversations").select("ai_draft_check").eq("id", YUMA).maybeSingle();
      if ((re as { ai_draft_check?: string | null } | null)?.ai_draft_check === LOCK) { if (told) console.log("  → 空いた。始める"); return; }
    }
    if (!told) { console.log(`YUMA を別の実測が使用中（印=${String(row.ai_draft_check ?? "なし").slice(0, 40)} 直近の発言=${lastMsgAt ?? "-"} attempted=${row.draft_attempted_at ?? "-"}）。空くまで待つ…`); told = true; }
    await sleep(30_000);
  }
  throw new Error("YUMA が空かない（40分待った）。止める");
}

async function cleanupSince(t0Iso: string, msgIds: string[], pcId: string | null) {
  const out: string[] = [];
  if (msgIds.length) { const { error } = await sb.from("messages").delete().in("id", msgIds); out.push(`messages ${msgIds.length}件${error ? `⚠${error.message}` : ""}`); }
  { const { data } = await sb.from("aix_action_items").select("id").eq("conversation_id", YUMA).gte("created_at", t0Iso);
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length) await sb.from("aix_action_items").delete().in("id", ids); out.push(`aix_action_items ${ids.length}件`); }
  { const { data } = await sb.from("line_tasks").select("id").eq("conversation_id", YUMA).gte("created_at", t0Iso);
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length) await sb.from("line_tasks").delete().in("id", ids); out.push(`line_tasks ${ids.length}件`); }
  if (pcId) {
    const { data } = await sb.from("automation_commands").select("id, customer_ids, payload").gte("created_at", t0Iso);
    const ids = ((data ?? []) as Array<{ id: string; customer_ids: unknown; payload: Record<string, unknown> | null }>)
      .filter((r) => (r.payload?.source === "aix") && JSON.stringify(r.customer_ids ?? "").includes(pcId)).map((r) => r.id);
    if (ids.length) await sb.from("automation_commands").delete().in("id", ids); out.push(`automation_commands ${ids.length}件`);
  }
  return out.join(" / ");
}

async function callGenerateReply(body: Record<string, unknown>): Promise<{ text: string; meta: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) { try { return { text: "", meta: JSON.parse(raw) as Record<string, unknown> }; } catch { return { text: raw, meta: null }; } }
  const nl = raw.indexOf("\n");
  let meta: Record<string, unknown> | null = null;
  let text = raw;
  if (nl >= 0) { try { meta = JSON.parse(raw.slice(0, nl)) as Record<string, unknown>; text = raw.slice(nl + 1); } catch { meta = null; } }
  // トレーラー <<<FINAL_CHECK:{…}>>> から生成側の記録（tier・往復セル・最終チェックのコード）を取る（回ごとに残る）
  const fc = text.match(/<<<FINAL_CHECK:([\s\S]*?)>>>/);
  if (fc) { try { const j = JSON.parse(fc[1]) as Record<string, unknown>; meta = { ...(meta ?? {}), finalCheck: j }; } catch { /* 壊れていれば無視 */ } }
  text = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
  return { text, meta };
}

function pickNames(conv: Record<string, unknown>, pc: PcRow | null, msgs: MsgRow[]): string[] {
  const names = new Set<string>();
  for (const n of [conv.customer_name, pc?.customer_name]) if (typeof n === "string" && n.trim().length >= 2) names.add(n.trim());
  const freq = new Map<string, number>();
  for (const m of msgs) if (m.sender === "staff") {
    const hit = (m.text ?? "").match(/(?:^|\n)\s*([^\s\n、。！!]{1,10}?)\s*さん/);
    if (hit) freq.set(hit[1], (freq.get(hit[1]) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2) names.add(top[0]);
  return [...names].sort((a, b) => b.length - a.length);
}

async function main() {
  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const samples = SAMPLES.filter((s) => !only.length || only.includes(s.key));
  for (const s of samples) if (!s.messageId && s.findText) {
    const { data } = await sb.from("messages").select("id").eq("sender", "customer").ilike("text", s.findText).limit(1);
    s.messageId = ((data ?? []) as Array<{ id: string }>)[0]?.id ?? "";
  }
  const T0 = new Date().toISOString();
  console.log(`=== ${SCENE} YUMA 再現: ${samples.length}件 × (ブレイン1回 + 生成 ${REPS}回) ／ BASE=${BASE} ／ T0=${T0} ===\n`);
  try { await fetch(`${BASE}/api/generate-reply`, { method: "GET" }); } catch (e) { throw new Error(`dev サーバーに届かない（${BASE}）: ${e instanceof Error ? e.message : String(e)}`); }

  await acquire();
  const backup = await saveBackup();
  const pcIdForCleanup = typeof backup.property_customer_id === "string" ? backup.property_customer_id : null;

  const results: Array<Record<string, unknown>> = [];
  for (const s of samples) {
    if (!s.messageId) { console.log(`【${s.label}】発言 id が見つからない → 飛ばす\n`); continue; }
    console.log(`━━━ ${s.label}`);
    await acquire();
    await restore(true);
    const tStart = new Date().toISOString();
    const { data: tm } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated, conversation_id").eq("id", s.messageId).maybeSingle();
    const target = tm as MsgRow | null;
    if (!target) { console.log("  発言が無い → 飛ばす\n"); continue; }
    const { data: oc } = await sb.from("conversations").select("customer_name, has_viewed, property_customer_id, status").eq("id", target.conversation_id).maybeSingle();
    const origConv = (oc ?? {}) as Record<string, unknown>;
    let pc: PcRow | null = null;
    if (origConv.property_customer_id) {
      const { data } = await sb.from("property_customers").select("*").eq("id", origConv.property_customer_id as string).maybeSingle();
      pc = (data ?? null) as PcRow | null;
    }
    const { data: hist } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated, conversation_id")
      .eq("conversation_id", target.conversation_id).lte("created_at", target.created_at).order("created_at", { ascending: false }).limit(20);
    const orig = ((hist ?? []) as MsgRow[]).reverse();
    if (!orig.some((m) => m.id === target.id)) orig.push(target);
    const names = pickNames(origConv, pc, orig);
    const rename = (t: string) => names.reduce((acc, n) => acc.split(n).join("YUMA"), t);
    const delta = (Date.now() - 60_000) - Date.parse(target.created_at);
    const rows = orig.map((m) => ({
      conversation_id: YUMA, sender: m.sender,
      text: rename(m.text ?? "") || (m.image_url ? "[画像]" : ""),
      created_at: new Date(Date.parse(m.created_at) + delta).toISOString(),
      is_aix_generated: m.is_aix_generated ?? false,
    }));
    const ins = await sb.from("messages").insert(rows).select("id, created_at, text");
    if (ins.error) { console.log(`  写せない: ${ins.error.message}\n`); continue; }
    const insRows = (ins.data ?? []) as Array<{ id: string; created_at: string; text: string }>;
    const msgIds = insRows.map((r) => r.id);
    const insTarget = insRows.slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1)!;
    const targetText = rename(target.text ?? "");
    console.log(`  写した: ${rows.length}通（客${rows.filter((r) => r.sender === "customer").length}／店${rows.filter((r) => r.sender === "staff").length}・名前の置換 ${names.length}種）・対象=${targetText.replace(/\n/g, " / ").slice(0, 70)}`);

    await sb.from("conversations").update({
      status: s.status, last_sender: "customer", last_message: targetText.slice(0, 200), ai_draft: null, ai_draft_check: LOCK,
      draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null, has_viewed: !!origConv.has_viewed,
    }).eq("id", YUMA);
    let skipped = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${BASE}/api/generate-draft-bg-async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: YUMA, source: "direct" }) });
        skipped = String(((await res.json()) as Record<string, unknown>).skipped ?? "");
      } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
      if (skipped !== "in_progress") break;
      await sleep(20_000);
    }
    let bgDraft = "", row: Record<string, unknown> = {};
    const w0 = Date.now();
    while (Date.now() - w0 < 240_000) {
      await sleep(4000);
      row = await readYuma();
      const d = String(row.ai_draft ?? "");
      if (d) { bgDraft = d; break; }
      if (row.draft_attempted_at == null && row.brain_analyzed_at && String(row.brain_analyzed_at) >= tStart && Date.now() - w0 > 30_000) break;
    }
    const meta = (row.suggested_aix_meta ?? null) as Record<string, unknown> | null;
    const { data: latestMsg } = await sb.from("messages").select("id").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1);
    const latestOk = ((latestMsg ?? []) as Array<{ id: string }>)[0]?.id === insTarget.id;
    const brainOk = !!row.brain_analyzed_at && String(row.brain_analyzed_at) >= tStart;
    const tsOk = !!meta?.analyzed_msg_ts && Math.abs(Date.parse(String(meta.analyzed_msg_ts)) - Date.parse(insTarget.created_at)) < 1500;
    const valid = latestOk && brainOk && tsOk;
    const { data: bdl } = await sb.from("brain_decision_logs").select("suggested_action, suggested_reply_mode, decision_source, scene_evidence, digest, created_at").eq("conversation_id", YUMA).gte("created_at", tStart).order("created_at", { ascending: false }).limit(1);
    const log = ((bdl ?? []) as Array<Record<string, unknown>>)[0] ?? null;
    const se = meta?.scene_evidence as Record<string, unknown> | null;
    console.log(`  前提: 最新発言=${latestOk ? "○" : "✗"} brain_analyzed_at=${brainOk ? "○" : "✗"} analyzed_msg_ts=${tsOk ? "○" : "✗"} → ${valid ? "有効" : "無効"}（skipped=${skipped || "-"}・${Math.round((Date.now() - w0) / 1000)}秒）`);
    console.log(`  ブレイン: action=${String(meta?.action ?? "")} check=${String(meta?.check_pattern ?? "")} mode=${String(meta?.reply_mode ?? "")} src=${String(log?.decision_source ?? "-")} scene=${String(se?.scene ?? "-")} pending_pickup=${String(meta?.pending_pickup ?? "")} dropped=${String(meta?.dropped_direction ?? "")}`);
    console.log(`     方向: ${String(meta?.reply_direction ?? "").replace(/\n/g, " ").slice(0, 200)}`);
    console.log(`     note: ${String(meta?.note ?? "").slice(0, 100)} ／ reason: ${String(meta?.reason ?? "").slice(0, 120)}`);
    console.log(`  bg-async の下書き: ${bgDraft ? bgDraft.replace(/\n/g, " / ").slice(0, 240) : "（なし）"}`);

    const recent = rows.map((r) => ({ sender: r.sender, text: r.text, imageUrl: undefined, createdAt: r.created_at, isAix: !!r.is_aix_generated })).slice(-25);
    const body = {
      message: targetText, customerMessages: [targetText], state: s.status, conversationId: YUMA, customerName: "YUMA",
      customerConditions: pc ? (formatConditions(pc) || undefined) : undefined,
      customerSummary: (pc?.ai_summary as string | null) ?? undefined,
      customerStructured: pc ? { move_in_time: pc.move_in_time ?? null, rent_max: pc.rent_max ?? null, desired_area: pc.desired_area ?? null, walk_minutes: pc.walk_minutes ?? null, floor_plan: pc.floor_plan ?? null, initial_cost_limit: pc.initial_cost_limit ?? null, building_age: pc.building_age ?? null, other_requests: pc.other_requests ?? pc.preferences ?? null } : undefined,
      replyHint: buildReplyHint(targetText, recent),
      hasViewed: !!origConv.has_viewed, activeTaskTypes: [] as string[],
      recentMessages: recent,
    };
    const gens: Array<{ text: string; meta: Record<string, unknown> | null; via: string }> = [];
    const isRealDraft = bgDraft && !/^\s*(\[AIX誘導中\]|\[返信不要\]|__SHOWN__)/.test(bgDraft);
    if (isRealDraft) gens.push({ text: bgDraft.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim(), meta: null, via: "bg-async" });
    for (let k = gens.length; k < REPS; k++) {
      try { const g = await callGenerateReply(body); gens.push({ ...g, via: "direct" }); }
      catch (e) { gens.push({ text: "", meta: { error: e instanceof Error ? e.message : String(e) }, via: "direct" }); }
    }
    const tpoOf = (g: { meta: Record<string, unknown> | null }) => ((g.meta?.finalCheck as Record<string, unknown> | null)?.tpo_debug ?? null) as Record<string, unknown> | null;
    for (let i = 0; i < gens.length; i++) {
      const g = gens[i];
      const sa = (g.meta?.suggested_aix as Record<string, unknown> | null)?.action ?? (g.meta?.aix as Record<string, unknown> | null)?.action ?? null;
      const tpo = tpoOf(g);
      const tpair = tpo?.turnPair as Record<string, unknown> | null;
      const codes = ((g.meta?.finalCheck as Record<string, unknown> | null)?.issues as Array<{ code: string; severity: string }> | undefined)?.map((x) => `${x.code}:${x.severity}`) ?? [];
      console.log(`  生成[${i + 1}/${g.via}]${sa ? ` AIX=${String(sa)}` : ""}${g.meta && g.meta.ok === false && g.meta.reason ? ` (${String(g.meta.reason)})` : ""}${g.meta?.error ? ` ⚠${String(g.meta.error)}` : ""}`
        + `${tpo ? ` tier=${String(tpo.tier ?? "-")} cell=${tpair?.staff ?? "-"}/${tpair?.customer ?? "-"}/${tpair?.ruleId ?? "-"} action=${String(tpo.effectiveAction ?? tpo.rawAction ?? "-")} brainDir=${String(tpo.brainReplyDirection ?? "").slice(0, 60)}` : ""}${codes.length ? ` codes=${codes.join(",")}` : ""}:`);
      console.log(`     ${(g.text || "（本文なし）").replace(/\n/g, " / ")}`);
    }
    // 生成側の記録は ai_draft_check.tpo_debug（generate-reply が書く。reply_context_snapshot は送信時に page.tsx が転送する物で直接叩きでは空）
    const { data: snapRow } = await sb.from("conversations").select("ai_draft_check, suggested_aix_meta, last_brain_meta").eq("id", YUMA).maybeSingle();
    const chkObj = (snapRow as { ai_draft_check?: unknown } | null)?.ai_draft_check;
    const snap = (chkObj && typeof chkObj === "object" ? ((chkObj as Record<string, unknown>).tpo_debug as Record<string, unknown> | null) : null) ?? null;
    // 生成の間に別の実測が YUMA を戻していないか（ブレインの判断が写した発言のままか）。
    //   suggested_aix_meta は画面（page.tsx）が表示時に null にすることがあるので、generate-reply と同じく last_brain_meta も見る
    const sr = snapRow as { suggested_aix_meta?: Record<string, unknown> | null; last_brain_meta?: Record<string, unknown> | null } | null;
    const metaAfter = sr?.suggested_aix_meta ?? sr?.last_brain_meta ?? null;
    const metaStable = String(metaAfter?.analyzed_msg_ts ?? "") === String(meta?.analyzed_msg_ts ?? "");
    if (!metaStable) console.log(`  ⚠ 生成の途中でブレインの判断が差し替わった（analyzed_msg_ts ${String(meta?.analyzed_msg_ts)} → ${String(metaAfter?.analyzed_msg_ts)}）→ この回の生成側は無効`);
    const tp = snap?.turnPair as Record<string, unknown> | null;
    console.log(`  snapshot: turnPair=${tp?.staff ?? "-"}/${tp?.customer ?? "-"}/${tp?.ruleId ?? "-"} tier=${JSON.stringify(snap?.tier ?? null)}`);

    const cleaned = await cleanupSince(tStart, msgIds, pcIdForCleanup);
    console.log(`  片付け: ${cleaned}\n`);
    results.push({
      key: s.key, label: s.label, messageId: s.messageId, origConversation: target.conversation_id, status: s.status, valid, genValid: valid && metaStable, skipped,
      premise: { latestOk, brainOk, tsOk, metaStable },
      brain: { action: meta?.action ?? null, check_pattern: meta?.check_pattern ?? null, reply_mode: meta?.reply_mode ?? null, reply_direction: meta?.reply_direction ?? null, note: meta?.note ?? null, reason: meta?.reason ?? null, pending_pickup: meta?.pending_pickup ?? null, dropped_direction: meta?.dropped_direction ?? null, scene: se?.scene ?? null, decision_source: log?.decision_source ?? null, digest_dir: (log?.digest as Record<string, unknown> | null)?.dir ?? null, avoid_topics: meta?.avoid_topics ?? null, key_topics: meta?.key_topics ?? null, customer_questions: meta?.customer_questions ?? null },
      bgDraft, generations: gens.map((g) => { const t = tpoOf(g); return { via: g.via, text: g.text, suggested_aix: (g.meta?.suggested_aix as unknown) ?? null, reason: g.meta?.reason ?? null, tier: t?.tier ?? null, turnPair: t?.turnPair ?? null, effectiveAction: t?.effectiveAction ?? null, brainReplyDirection: t?.brainReplyDirection ?? null, codes: ((g.meta?.finalCheck as Record<string, unknown> | null)?.issues as unknown) ?? null }; }),
      snapshot: { turnPair: tp ?? null, tier: snap?.tier ?? null },
      copied: rows.map((r) => ({ sender: r.sender, text: r.text, created_at: r.created_at, isAix: r.is_aix_generated })),
    });
    writeFileSync(OUT, JSON.stringify({ T0, results }, null, 2), "utf8");
  }

  await restore(false);
  const after = await readYuma();
  console.log(`=== 元に戻した: status=${after.status} last_sender=${after.last_sender} ai_draft=${String(after.ai_draft ?? "null").slice(0, 30)} ai_draft_check=${after.ai_draft_check ?? "null"} brain_analyzed_at=${after.brain_analyzed_at} ===`);
  console.log(`記録: ${OUT}`);
}
main().catch(async (e) => {
  console.error(e);
  try { if (existsSync(BACKUP)) { await restore(false); console.log("（エラー時）元に戻した"); } } catch (e2) { console.error("戻せない:", e2); }
  process.exit(1);
});
