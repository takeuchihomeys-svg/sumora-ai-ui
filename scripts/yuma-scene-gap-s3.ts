// 場面 S3「お客様が物件を持ってきた」の実物を YUMA に写し、「ブレインごと1回 → 生成側 3回」で今の生成を出して実送信と並べる
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
// ※ scripts/yuma-scene-gap.ts は S2 用（別エージェントが同時に書いたので、S3 はこのファイルに分けた）
//
// 【設計】(a) YUMA 再現 = bg-async でブレインを新しくしてから 60 秒以内に generate-reply を画面と同じ body で直接叩く。
//   設計知見の2件（「bg-async は AIX 誘導で止まる→直接」「直接叩くと古い AIX 判断が出る→ブレインごと」）は矛盾ではなく順番。
//   route.ts の stale rerun は「brain が fresh でない＋60秒超」の時だけなので、この順なら判断は写した場面のもの。
// 【前提の確認】毎回 ①messages の最新が写した発言か ②brain_analyzed_at ≥ 開始時刻か ③analyzed_msg_ts が写した発言の時刻か。
//   1つでも違えばその回は「無効」（設計知見「作れていない検証は結果が全部0」）。
// 【片付け】写した messages・aix_action_items・automation_commands を消し、conversations を控えから戻す。
// ⚠ 書き込みは YUMA（dd34f5b0…）だけ。実際のお客様の会話には読むだけ。
//
// 実行: npx tsx --env-file=.env.local scripts/yuma-scene-gap-s3.ts [REPS=3] [ONLY=1,2] [BACKUP=scripts/.yuma-backup.json]
//   事前に dev サーバ（npm run dev・3000）と yuma-snapshot.ts save。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { MSG_SEP } from "../app/lib/reply-context";
import { firstReplyStateOrNull, staffHasEngaged } from "../app/lib/conversation-status";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const BACKUP = process.env.BACKUP ?? "scripts/.yuma-backup.json";
const OUT = process.env.OUT ?? "scripts/.yuma-scene-gap-s3-out.json";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Case = { id: string; conv: string; /** この時刻以前の最後のお客様発言を対象にする */ upTo: string; actual: string; note?: string };
/** 場面 S3: お客様が物件を持ってきた（成約側・その時下書きが出た実物・scripts/audit-s3-property-brought.ts ⑥から） */
const CASES: Case[] = [
  { id: "S3-1 URL×4＋エリア追加の依頼", conv: "a0cfe4c4-cd3c-42f8-a218-6cc45be05081", upTo: "2026-09-11T14:26:00+00:00",
    actual: "かしこまりました！！\nお送り頂きました4件、募集状況確認させて頂きます！！\n\n北摂・東淀川・西淀川・東成・生野エリアからも広めの2LDKでYUMAさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\n\n管理会社営業時間外ですので明日\n募集状況確認出来次第ご連絡させて頂きます！！" },
  { id: "S3-2 画像×5＋URL×2＋初期費用の質問", conv: "d3f7f5f3-6c31-4c90-adab-e1300017319d", upTo: "2026-09-05T05:34:00+00:00",
    actual: "かしこまりました！！\nお送り頂きました物件全ての募集状況確認させて頂きます😊！！\n確認出来次第、最大限割引させて頂いた初期費用の御見積書を作成しお送りさせて頂きます！！" },
  { id: "S3-3 コピペ1＋「ここって物件あります？」", conv: "ad97cd40-26d2-4e22-8f0f-b18159786f1d", upTo: "2026-09-18T11:44:00+00:00",
    actual: "かしこまりました！！\n\nお送りいただきましたお部屋の募集状況確認させていただきます！！" },
  { id: "S3-4 画像1＋「空きそうにないです？」（AIX 物件確認した→募集終了）", conv: "b50fd451-2393-4826-b61f-34db7aefa55d", upTo: "2026-09-18T08:18:00+00:00",
    actual: "YUMAさんお世話になっております！！\nお送り頂きましたサンフォレスト中之島につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！\n\n引き続きYUMAさんのご条件に合ったお部屋をピックアップしてお送りさせて頂きます！！" },
];

type Msg = { id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null };
let insertedIds: string[] = [];
let backup: Record<string, unknown> | null = null;
let yumaPcId: string | null = null;

async function restore() {
  if (!backup) return;
  const { id: _i, customer_name: _n, updated_at: _u, ...rest } = backup;
  void _i; void _n; void _u;
  const { error } = await sb.from("conversations").update(rest).eq("id", YUMA);
  if (error) console.log(`⚠ 戻せない: ${error.message}`);
}
async function cleanup(t0: string) {
  if (insertedIds.length) { await sb.from("messages").delete().in("id", insertedIds); insertedIds = []; }
  const { data: items } = await sb.from("aix_action_items").select("id").eq("conversation_id", YUMA).gte("created_at", t0);
  if (items?.length) await sb.from("aix_action_items").delete().in("id", items.map((r) => (r as { id: string }).id));
  if (yumaPcId) {
    const { data: cmds } = await sb.from("automation_commands").select("id, payload").contains("customer_ids", [yumaPcId]).gte("created_at", t0);
    const ids = ((cmds ?? []) as Array<{ id: string; payload: Record<string, unknown> | null }>).filter((c) => c.payload?.source === "aix").map((c) => c.id);
    if (ids.length) await sb.from("automation_commands").delete().in("id", ids);
    if (cmds?.length) console.log(`   片付け: automation_commands ${ids.length}/${cmds.length}`);
  }
  await restore();
}
async function waitForDraft(timeoutMs = 240_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const { data } = await sb.from("conversations").select("ai_draft").eq("id", YUMA).maybeSingle();
    const d = String((data as { ai_draft?: string | null } | null)?.ai_draft ?? "");
    if (d === "[AIX誘導中]" || d === "[返信不要]") return d;
    if (d && d !== "__SHOWN__") return d;
  }
  return "";
}
const stripTrailer = (t: string) => t.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();

/** 画面（app/page.tsx generateReply）と同じ body を YUMA の今の messages から組む */
async function buildDirectBody(state: string, pc: Record<string, unknown> | null) {
  const { data } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(60);
  const msgs = ((data ?? []) as Msg[]).reverse();
  let lastStaffIdx = -1;
  msgs.forEach((m, i) => { if (m.sender === "staff") lastStaffIdx = i; });
  const unreplied = msgs.slice(lastStaffIdx + 1).filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]").slice(-10);
  let targetMessage = unreplied.length ? unreplied.map((m) => m.text as string).join(MSG_SEP) : (msgs[msgs.length - 1]?.text ?? "");
  const units = unreplied.length ? unreplied.map((m) => m.text as string) : (targetMessage ? [targetMessage] : []);
  if (targetMessage === "[画像]" || targetMessage === "[動画]" || !targetMessage.trim()) targetMessage = "（物件画像を送信）";
  const effectiveState = firstReplyStateOrNull(state, staffHasEngaged(msgs)) ?? state;
  // replyHint（page.tsx と同じ規則）
  const lines = targetMessage.split("\n").map((l) => l.trim()).filter(Boolean);
  const shortLines = lines.filter((l) => l.length <= 25);
  const COND = /[0-9０-９]+万|[0-9０-９]+LDK|[0-9０-９]+[KDk]|エリア|区|駅|間取り|家賃|広さ|㎡|ペット|駐車場|築/;
  const ACT = /含めて|を外|に変え|以上|以下|でも可|気にしな|上げて|下げて|緩め|広げ|に絞|でお願い|から探|も探/;
  const PICK = /ありませんか|ありますか|送って|ピックアップ|おすすめ|オススメ|出てます|教えて/;
  const staffRecent = msgs.filter((m) => m.sender === "staff").slice(-8).reverse();
  let estimateProp: string | null = null;
  for (const m of staffRecent) { const mm = /^【([^\s】]+)/.exec(m.text ?? ""); if (mm) { estimateProp = mm[1]; break; } }
  let hint = "";
  if (estimateProp) hint = `【見積書の物件名固定】直近に送った見積書の物件「${estimateProp}」を使うこと。会話に出てくる他の物件名は絶対に使わない`;
  if (targetMessage === "（物件画像を送信）") {
    hint = "【お客様が物件画像を送信】お客様が特定物件の空室確認を依頼している。「かしこまりました！！お送り頂きました物件の募集状況確認させていただきます！！確認出来次第ご連絡させて頂きます！！」と返信し、条件がまだ未確認の場合はあわせて条件ヒアリングフォームを送る（①入居時期 ②ご希望家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他）";
  } else if (effectiveState !== "first_reply") {
    if (shortLines.length >= 3) hint = (hint ? hint + "\n" : "") + `【お客様が列挙した条件・要望（返信で具体的に言及すること）】${shortLines.slice(0, 8).join("・")}`;
    else if (lines.some((l) => COND.test(l) && ACT.test(l)) || lines.some((l) => PICK.test(l))) hint = (hint ? hint + "\n" : "") + `【条件変更/ピックアップ依頼（追加質問禁止・変更内容を具体的に言葉にして即行動宣言）】${lines.join("・")}`;
  }
  const last25 = msgs.slice(-25);
  const lastStaff = last25.some((m) => m.sender === "staff") ? undefined : [...msgs].reverse().find((m) => m.sender === "staff");
  const finalMsgs = lastStaff ? [lastStaff, ...last25] : last25;
  const cond = pc ? formatConditions(pc) : undefined;
  return {
    message: targetMessage, customerMessages: units, state: effectiveState, conversationId: YUMA, customerName: "YUMA",
    customerConditions: cond || undefined, customerSummary: (pc?.ai_summary as string | null) ?? undefined,
    customerStructured: pc ? { move_in_time: pc.move_in_time ?? null, rent_max: pc.rent_max ?? null, desired_area: pc.desired_area ?? null, walk_minutes: pc.walk_minutes ?? null, floor_plan: pc.floor_plan ?? null, initial_cost_limit: pc.initial_cost_limit ?? null, building_age: pc.building_age ?? null, other_requests: pc.other_requests ?? pc.preferences ?? null } : undefined,
    replyHint: hint || undefined, hasViewed: false, activeTaskTypes: [] as string[],
    recentMessages: finalMsgs.map((m) => ({ sender: m.sender, text: m.text || "", imageUrl: m.image_url || undefined, createdAt: m.created_at, isAix: !!m.is_aix_generated })),
  };
}
/** page.tsx formatConditions と同じ */
function formatConditions(c: Record<string, unknown>): string {
  const L: string[] = [];
  if (c.desired_area) L.push(`エリア: ${c.desired_area}`);
  if (c.floor_plan) L.push(`間取り: ${c.floor_plan}`);
  const r: string[] = [];
  if (c.rent_min) r.push(`${Number(c.rent_min) / 10000}万円〜`);
  if (c.rent_max) r.push(`${Number(c.rent_max) / 10000}万円以内`);
  if (r.length) L.push(`家賃: ${r.join("")}`);
  if (c.walk_minutes) L.push(`駅徒歩: ${c.walk_minutes}分以内`);
  if (c.move_in_time) L.push(`入居: ${c.move_in_time}`);
  if (c.building_age) L.push(`築年数: ${c.building_age}年以内`);
  if (c.preferences) L.push(`希望: ${c.preferences}`);
  if (c.ng_points) L.push(`NG: ${c.ng_points}`);
  if (c.other_requests) L.push(`その他: ${c.other_requests}`);
  if (c.additional_conditions) {
    const a = String(c.additional_conditions).split("\n").map((l) => l.replace(/^【[^】]*】/, "").trim()).filter(Boolean).join("、");
    if (a) L.push(`追加条件: ${a}`);
  }
  return L.join("\n");
}
async function directGenerate(body: unknown): Promise<string> {
  try {
    const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (ct.includes("application/json")) return `【JSON】${raw.slice(0, 200)}`;
    const nl = raw.indexOf("\n");
    const meta = nl >= 0 ? raw.slice(0, nl) : "";
    const text = nl >= 0 ? raw.slice(nl + 1) : raw;
    const m = (() => { try { return JSON.parse(meta) as Record<string, unknown>; } catch { return null; } })();
    if (m && m.ok === false) return `【ok:false】${String(m.reason ?? m.error ?? "")} aix=${JSON.stringify(m.aix ?? null)}`;
    return stripTrailer(text);
  } catch (e) { return `【エラー】${e instanceof Error ? e.message : String(e)}`; }
}

async function main() {
  const reps = Number(process.env.REPS ?? 3);
  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const cases = CASES.filter((_, i) => !only.length || only.includes(i + 1));
  backup = JSON.parse(readFileSync(BACKUP, "utf8")) as Record<string, unknown>;
  const { data: yc } = await sb.from("conversations").select("property_customer_id, brain_analyzed_at, status").eq("id", YUMA).maybeSingle();
  yumaPcId = (yc as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
  console.log(`=== 場面 S3：${cases.length} 実物 × ブレイン1回＋生成 ${reps}回（YUMA・dev ${BASE}）===`);
  console.log(`   控え: ${BACKUP}（status=${backup.status} brain_analyzed_at=${backup.brain_analyzed_at}）／ 現在 status=${(yc as { status?: string } | null)?.status}\n`);
  const results: Array<Record<string, unknown>> = [];

  for (const c of cases) {
    const t0 = new Date().toISOString();
    console.log(`\n━━━ ${c.id} ━━━`);
    // 元会話（読むだけ）
    const { data: srcConv } = await sb.from("conversations").select("customer_name, property_customer_id").eq("id", c.conv).maybeSingle();
    const srcName = String((srcConv as { customer_name?: string } | null)?.customer_name ?? "");
    const { data: srcMsgs } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", c.conv).lte("created_at", c.upTo).order("created_at", { ascending: false }).limit(20);
    const src = ((srcMsgs ?? []) as Msg[]).reverse();
    const target = [...src].reverse().find((m) => m.sender === "customer");
    if (!target) { console.log("   対象のお客様発言が見つからない → 飛ばす"); continue; }
    const targetIdx = src.indexOf(target);
    const window = src.slice(0, targetIdx + 1);
    const { data: exRows } = await sb.from("ai_reply_examples").select("conversation_state, sent_at, ai_draft").eq("conversation_id", c.conv).gte("sent_at", target.created_at).order("sent_at").limit(1);
    const ex = ((exRows ?? []) as Array<{ conversation_state: string | null; sent_at: string; ai_draft: string | null }>)[0];
    const state = ex?.conversation_state ?? "proposing";
    const pcId = (srcConv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    const { data: pcRow } = pcId ? await sb.from("property_customers").select("*").eq("id", pcId).maybeSingle() : { data: null };
    const pc = (pcRow ?? null) as Record<string, unknown> | null;
    console.log(`   元: ${window.length}通（客 ${window.filter((m) => m.sender === "customer").length}）対象=${target.created_at} state=${state} 条件=${pc ? "あり" : "なし"} 当時の下書き=${ex?.ai_draft ? "あり" : "なし"}`);

    // (i) 控えに戻す → (ii) 写す（対象 = now−60秒 に平行移動・名前は YUMA に）
    await restore();
    const shift = Date.now() - 60_000 - Date.parse(target.created_at);
    const rows = window.map((m) => ({
      conversation_id: YUMA, sender: m.sender, image_url: m.image_url, is_aix_generated: !!m.is_aix_generated,
      text: srcName && srcName.length >= 2 ? (m.text ?? "").split(srcName).join("YUMA") : (m.text ?? ""),
      created_at: new Date(Date.parse(m.created_at) + shift).toISOString(),
    }));
    const ins = await sb.from("messages").insert(rows).select("id, created_at");
    if (ins.error) { console.log(`   写せない: ${ins.error.message}`); continue; }
    insertedIds = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    const targetTs = rows[rows.length - 1].created_at;
    // (iii)(iv) status を合わせて armConversation → bg-async
    await sb.from("conversations").update({ status: state, last_sender: "customer", last_message: rows[rows.length - 1].text, ai_draft: null, ai_draft_check: null, draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null }).eq("id", YUMA);
    let skipped = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${BASE}/api/generate-draft-bg-async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: YUMA, source: "direct" }) });
        skipped = String(((await res.json()) as Record<string, unknown>).skipped ?? "");
      } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
      if (skipped !== "in_progress") break;
      await sleep(20_000);
    }
    const draft = await waitForDraft();
    // (v) 前提の確認
    const { data: after } = await sb.from("conversations").select("brain_analyzed_at, suggested_aix_meta, suggested_next_aix, ai_draft, status").eq("id", YUMA).maybeSingle();
    const a = (after ?? {}) as Record<string, unknown>;
    const meta = (a.suggested_aix_meta ?? {}) as Record<string, unknown>;
    const { data: latest } = await sb.from("messages").select("id").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1);
    const latestOk = ((latest ?? []) as Array<{ id: string }>)[0]?.id === insertedIds[insertedIds.length - 1];
    const analyzedOk = !!a.brain_analyzed_at && String(a.brain_analyzed_at) >= t0;
    const tsOk = Math.abs(Date.parse(String(meta.analyzed_msg_ts ?? "")) - Date.parse(targetTs)) < 2000;
    const valid = latestOk && analyzedOk && tsOk;
    console.log(`   前提: 最新発言=${latestOk ? "○" : "×"} brain_analyzed_at=${analyzedOk ? "○" : "×"}(${a.brain_analyzed_at}) analyzed_msg_ts=${tsOk ? "○" : "×"}(${meta.analyzed_msg_ts}) → ${valid ? "有効" : "無効"} skipped=${skipped || "-"}`);
    const { data: dl } = await sb.from("brain_decision_logs").select("suggested_action, suggested_reply_mode, suggested_check_pattern, enforcement_level, decision_source, analysis_mode, scene_evidence, digest").eq("conversation_id", YUMA).gte("created_at", t0).order("created_at", { ascending: false }).limit(1);
    const log = ((dl ?? []) as Array<Record<string, unknown>>)[0] ?? null;
    const digest = (log?.digest ?? {}) as Record<string, unknown>;
    const brain = {
      action: meta.action ?? null, reply_mode: meta.reply_mode ?? null, check_pattern: meta.check_pattern ?? null, source: meta.source ?? null,
      note: meta.note ?? null, reason: meta.reason ?? null, dir: digest.dir ?? null, pending_pickup: meta.pending_pickup ?? digest.pending_pickup ?? null,
      dropped_direction: meta.dropped_direction ?? null, scene: (log?.scene_evidence as Record<string, unknown> | null)?.scene ?? (meta.scene_evidence as Record<string, unknown> | null)?.scene ?? null,
      log_action: log?.suggested_action ?? null, log_mode: log?.suggested_reply_mode ?? null, decision_source: log?.decision_source ?? null, analysis_mode: log?.analysis_mode ?? null,
      metaKeys: Object.keys(meta).join(","),
    };
    console.log(`   ブレイン: action=${String(brain.action || "(なし)")} mode=${String(brain.reply_mode)} check=${String(brain.check_pattern ?? "-")} scene=${String(brain.scene ?? "-")} src=${String(brain.decision_source ?? "-")}/${String(brain.analysis_mode ?? "-")}`);
    console.log(`     方向: ${String(brain.dir ?? "(なし)").replace(/\n/g, " / ").slice(0, 200)}`);
    console.log(`     note: ${String(brain.note ?? "").replace(/\n/g, " / ").slice(0, 160)}`);
    console.log(`   bg-async の下書き: ${draft ? draft.replace(/\n/g, " ⏎ ").slice(0, 300) : "（出なかった）"}`);
    // (vii) 生成側 REPS
    const gens: string[] = [];
    const bgIsDraft = !!draft && !/^\[(AIX誘導中|返信不要)\]$/.test(draft);
    if (bgIsDraft) gens.push(stripTrailer(draft));
    const body = await buildDirectBody(state, pc);
    console.log(`   直接 body: message=${body.message.replace(/\n/g, "⏎").slice(0, 80)}… units=${body.customerMessages.length} state=${body.state} hint=${body.replyHint ? body.replyHint.slice(0, 40) + "…" : "なし"} recent=${body.recentMessages.length}`);
    while (gens.length < reps) {
      const g = await directGenerate(body);
      gens.push(g);
      console.log(`   生成[${gens.length}]: ${g.replace(/\n/g, " ⏎ ").slice(0, 300)}`);
    }
    results.push({ id: c.id, conv: c.conv, target: target.created_at, state, valid, premise: { latestOk, analyzedOk, tsOk, skipped }, brain, bgDraft: draft, gens, actual: c.actual, customerTurn: window.filter((m) => m.sender === "customer").map((m) => (m.text ?? "").split(srcName).join("YUMA")) });
    writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
    // (viii) 片付け
    await cleanup(t0);
    console.log(`   片付け完了（messages ${window.length}・restore）`);
  }
  console.log(`\n=== 出力: ${OUT}（生成本文の全文はこちら）===`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (insertedIds.length) { await sb.from("messages").delete().in("id", insertedIds); console.log(`最終片付け: ${insertedIds.length}件`); } await restore(); });
