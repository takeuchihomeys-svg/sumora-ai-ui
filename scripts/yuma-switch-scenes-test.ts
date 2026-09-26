// YUMA で「切り替えの場面（内覧後・申込後・番手待ち）」のブレインの判断を前後で比べる（段3・2026-09-26）
//
// 竹内「内覧終了して別の物件に切り替える…その物件も候補にしてほかも探す／申込して部屋抑えながらほかも探す。いつまで1つの物件にとらわれないか」
//
// やること（実物ごと）:
//   ① scripts/audit-switch-scenes.ts が REPLAY_OUT に書き出した実物（伏せ済み・直近12通・時刻は縮めた分）を YUMA の messages／aix_usage_logs に入れる
//   ② ブレインの判断を 前（HEAD の worktree）・後（作業コピー）で1回ずつ取る（analyzeConversation＝保存しない・Claude・使い回しあり）
//   ③ GEN=after|both の時だけ、置いた判断で返信本文を生成する（開発サーバ。試行錯誤は LLM_TEST_MODE=deepseek-all）
//   ④ 場面の発言を消す。最後に YUMA の副作用を始める前に戻す（yuma-done-state-test.ts と同じ片付け）
// 比べる物: スタッフの実際の動き（最初の AIX の類・探すと申込/見積/確認を両方したか）× ブレインの AIX の類（前・後）× 後の parallel_search。
//
// 前提: 前の木 .claude/worktrees/tmp-fix-before（git worktree add --detach … HEAD・node_modules は junction・.env.local を複写）
// 実行: npx tsx --env-file=.env.local scripts/yuma-switch-scenes-test.ts [ID ...]   （REPLAY=scripts/.switch-replay.json・GEN=・N=1・OUT=）
//        npx tsx --env-file=.env.local scripts/yuma-switch-scenes-test.ts --cleanup
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getCustomerState } from "../app/lib/customer-state-server";
import { resolveParallelSearchScene, parallelSearchInputsFromMessages } from "../app/lib/parallel-search";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const MAIN = process.cwd();
const BEFORE_DIR = join(MAIN, ".claude", "worktrees", "tmp-fix-before");
const BEFORE_URL = process.env.BEFORE_URL ?? "http://localhost:3101";
const AFTER_URL = process.env.AFTER_URL ?? "http://localhost:3100";
const N = Number(process.env.N ?? 1);
const GEN = (process.env.GEN ?? "").split(",").filter(Boolean); // "before" / "after"
const REPLAY = process.env.REPLAY ?? join(MAIN, "scripts", ".switch-replay.json");
const STATE = join(MAIN, "scripts", ".yuma-switch-state.json");
const OUT = process.env.OUT ?? join(MAIN, "scripts", ".yuma-switch-result.json");
const MSG_SEP = "\n⁣\n";

type ReplayMsg = { s: "staff" | "customer"; text: string; min: number; aix?: { type: string; property_names?: string[] } };
type Replay = { id: string; scene: string; conv8: string; status: string; staffMove: string; tracks: string[]; twoTracks: boolean; staffAix: string | null; staffText: string; loggedBrainAix: string | null; msgs: ReplayMsg[] };

const AIX_CLASS: Record<string, string> = {
  property_send: "探す", property_recommendation: "探す", condition_hearing: "探す", property_search: "探す",
  property_check_result: "確認", acknowledge_check: "確認",
  estimate_sheet: "見積", cost_explain: "見積", cost_breakdown: "見積",
  viewing_invite: "内覧", meeting_place: "内覧", greeting_viewing: "内覧",
  application_push: "申込", guarantor_info: "申込",
};
const cls = (a: string | null | undefined) => (a ? AIX_CLASS[a] ?? "他" : "なし");

/** このテストが conversations に最後に書いた値（片付けで、他の人の書いた値を戻さないため） */
const lastWritten: Record<string, unknown> = {};
async function writeConv(patch: Record<string, unknown>) {
  const { data } = await sb.from("conversations").update(patch).eq("id", Y).select(Object.keys(patch).join(", ")).maybeSingle();
  Object.assign(lastWritten, (data ?? patch) as Record<string, unknown>);
}
/** 始める前から無かった YUMA の発言（このテストの行以外）が、始める直前の最後の発言より後にあれば、別のテストが動いている */
async function foreignRows(s: State): Promise<number> {
  const { data } = await sb.from("messages").select("id").eq("conversation_id", Y).gt("created_at", s.lastMsgAt ?? s.t0);
  return ((data ?? []) as Array<{ id: string }>).filter((r) => !s.msgIds.includes(r.id)).length;
}
type State = { lastMsgAt?: string | null; t0: string; conv: Record<string, unknown>; bdl: Array<{ id: string; body_block_code: unknown }>; msgIds: string[]; aixIds: string[] };
const loadState = (): State | null => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : null);
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2), "utf8");

async function begin(): Promise<State> {
  const { data: conv } = await sb.from("conversations").select("*").eq("id", Y).maybeSingle();
  const { data: bdl } = await sb.from("brain_decision_logs").select("id, body_block_code").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(20);
  const s: State = { t0: new Date().toISOString(), conv: (conv ?? {}) as Record<string, unknown>, bdl: (bdl ?? []) as State["bdl"], msgIds: [], aixIds: [] };
  saveState(s);
  // 本番の brain-sweep（suggested_aix_meta IS NULL かつ last_sender=customer）に拾われないよう、判断の置き場を空にしない
  const { data: lm } = await sb.from("messages").select("created_at").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(1).maybeSingle();
  s.lastMsgAt = (lm as { created_at?: string } | null)?.created_at ?? null;
  saveState(s);
  await writeConv({ suggested_aix_meta: { action: "", reply_mode: "auto_reply", source: "cached", enforcement_level: "optional", analyzed_msg_ts: null } });
  return s;
}
async function dropSceneRows(s: State) {
  if (s.msgIds.length) { const { error } = await sb.from("messages").delete().in("id", s.msgIds); if (error) console.log(`⚠ messages を消せない: ${error.message}`); else s.msgIds = []; }
  if (s.aixIds.length) { const { error } = await sb.from("aix_usage_logs").delete().in("id", s.aixIds); if (error) console.log(`⚠ aix_usage_logs を消せない: ${error.message}`); else s.aixIds = []; }
  saveState(s);
}
async function cleanup(s: State) {
  await dropSceneRows(s);
  const t0 = s.t0;
  const { data: kal } = await sb.from("knowledge_apply_log").select("id, knowledge_id").eq("conversation_id", Y).gte("applied_at", t0);
  const kc = new Map<string, number>();
  for (const r of (kal ?? []) as Array<{ knowledge_id: string | null }>) if (r.knowledge_id) kc.set(r.knowledge_id, (kc.get(r.knowledge_id) ?? 0) + 1);
  let dec = 0;
  for (const [id, n] of kc) {
    const { data: k } = await sb.from("ai_reply_knowledge").select("used_count").eq("id", id).maybeSingle();
    const cur = Number((k as { used_count?: number } | null)?.used_count ?? 0);
    const { error } = await sb.from("ai_reply_knowledge").update({ used_count: Math.max(0, cur - n) }).eq("id", id);
    if (!error) dec += n;
  }
  const del = async (table: string, col: string) => {
    const { count, error } = await sb.from(table).delete({ count: "exact" }).eq("conversation_id", Y).gte(col, t0);
    console.log(`  ${table.padEnd(24)} ${error ? `⚠ ${error.message}` : `${count ?? 0}行消した`}`);
  };
  console.log("── 片付け ──");
  console.log(`  ai_reply_knowledge.used_count  ${kc.size}件で合計 ${dec} 戻した`);
  for (const [t, c] of [["knowledge_apply_log", "applied_at"], ["reply_mode_shadow_logs", "created_at"], ["closing_strategy_logs", "proposed_at"], ["brain_decision_logs", "created_at"], ["aix_action_items", "created_at"], ["line_tasks", "created_at"], ["aix_generate_log", "created_at"], ["sent_facts", "sent_at"]] as const) await del(t, c);
  for (const r of s.bdl) await sb.from("brain_decision_logs").update({ body_block_code: r.body_block_code }).eq("id", r.id);
  const { data: now } = await sb.from("conversations").select("*").eq("id", Y).maybeSingle();
  const patch: Record<string, unknown> = {};
  // 2026-09-26: 別のセッションが同時に YUMA でテストしていた（テストハイツの場面が混ざった）。その人の置いた値を戻して壊さないよう、
  //   このテストが書く列（判断の置き場・下書き）だけを、今の値がこのテストが最後に書いた値の時だけ戻す
  //   別のテストの発言が無い時は、変わった列を全部戻す（生成が書く ai_draft・ai_draft_check 等も。2026-09-26 に ai_draft を戻せなかった反省）
  const OWN_COLS = ["suggested_aix_meta", "brain_analyzed_at", "ai_draft", "draft_pending_at"];
  const concurrent = (await foreignRows(s)) > 0;
  if (concurrent) console.log("  ⚠ 別のテストの発言がある → このテストが書く列だけ戻す");
  for (const [k, v] of Object.entries((now ?? {}) as Record<string, unknown>)) {
    if (k === "updated_at" || k === "id") continue;
    if (!concurrent) { if (JSON.stringify(v) !== JSON.stringify(s.conv[k])) patch[k] = s.conv[k] ?? null; continue; }
    if (!OWN_COLS.includes(k)) continue;
    if (JSON.stringify(v) === JSON.stringify(s.conv[k])) continue;
    if (k in lastWritten && JSON.stringify(v) !== JSON.stringify(lastWritten[k])) { console.log(`  ⚠ ${k} は別の誰かが書き換えている → 戻さない`); continue; }
    patch[k] = s.conv[k] ?? null;
  }
  if (Object.keys(patch).length) {
    const { error } = await sb.from("conversations").update(patch).eq("id", Y);
    console.log(`  conversations            ${error ? `⚠ ${error.message}` : `戻した列: ${Object.keys(patch).join(", ")}`}`);
  } else console.log("  conversations            変わった列なし");
  const { count: left } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", Y).gte("created_at", t0.slice(0, 10));
  console.log(`  今日の YUMA の発言の残り  ${left ?? 0}（始める前からあった分を含む）`);
  unlinkSync(STATE);
}
async function insertScene(s: State, r: Replay) {
  const now = Date.now();
  for (const m of r.msgs) {
    const at = new Date(now - m.min * 60_000).toISOString();
    const { data, error } = await sb.from("messages").insert({ conversation_id: Y, sender: m.s, text: m.text, created_at: at, is_aix_generated: !!m.aix }).select("id").single();
    if (error) throw new Error(`messages insert: ${error.message}`);
    s.msgIds.push((data as { id: string }).id); saveState(s);
    if (m.aix) {
      const { data: a, error: e2 } = await sb.from("aix_usage_logs").insert({
        conversation_id: Y, aix_type: m.aix.type, property_names: m.aix.property_names?.length ? m.aix.property_names : null, generated_text: m.text, sent_at: at, created_at: at, conversation_status: "proposing",
      }).select("id").single();
      if (e2) throw new Error(`aix_usage_logs insert: ${e2.message}`);
      s.aixIds.push((a as { id: string }).id); saveState(s);
    }
  }
}
function runBrain(dir: string, out: string): Record<string, unknown> | null {
  const runner = join(dir, "scripts", "yuma-brain-decision.ts");
  const runnerSrc = readFileSync(join(MAIN, "scripts", "yuma-brain-decision.ts"), "utf8");
  if (!existsSync(runner) || readFileSync(runner, "utf8") !== runnerSrc) writeFileSync(runner, runnerSrc, "utf8");
  // ブレインは Claude で1回取って使い回す（名前にその木の brain-core と customer-state・parallel-search・move-out-context の中身のハッシュ）
  const h = createHash("sha1");
  for (const f of ["brain-core.ts", "customer-state.ts", "parallel-search.ts", "move-out-context.ts"]) { const p = join(dir, "app", "lib", f); if (existsSync(p)) h.update(readFileSync(p)); }
  const side = dir.includes("tmp-fix-before") ? "before" : "after";
  const env = { ...process.env, BRAIN_CACHE_LABEL: `switch-${side}-${h.digest("hex").slice(0, 8)}`, BRAIN_CACHE_DIR: join(MAIN, "scripts", ".brain-cache") };
  const r = spawnSync(`npx tsx --env-file=.env.local scripts/yuma-brain-decision.ts "${out}"`, { cwd: dir, shell: true, encoding: "utf8", timeout: 300_000, env });
  if (/brain reused/.test(r.stdout ?? "")) console.log(`  （ブレイン ${side === "before" ? "前" : "後"}: 保存した判断を使い回し）`);
  if (r.status !== 0) { console.log(`⚠ brain (${side}) 失敗: ${(r.stderr ?? "").slice(-600)}`); return null; }
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown> | null;
}
async function buildBody() {
  const { data: conv } = await sb.from("conversations").select("customer_name, status, has_viewed").eq("id", Y).maybeSingle();
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(60);
  const all = ((ms ?? []) as Array<Record<string, unknown>>).reverse();
  const lastStaffIdx = all.map((m, i) => (m.sender === "staff" ? i : -1)).filter((i) => i >= 0).at(-1);
  const after = lastStaffIdx !== undefined ? all.slice(lastStaffIdx + 1) : all;
  const unreplied = after.filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]").slice(-10).map((m) => String(m.text));
  const lastCust = [...all].reverse().find((m) => m.sender === "customer");
  const message = unreplied.length ? unreplied.join(MSG_SEP) : String(lastCust?.text ?? "");
  const c = (conv ?? {}) as Record<string, unknown>;
  return {
    message, customerMessages: unreplied.length ? unreplied : [message], state: String(c.status ?? "proposing"), conversationId: Y,
    customerName: String(c.customer_name ?? "YUMA"), hasViewed: !!c.has_viewed, activeTaskTypes: [] as string[],
    recentMessages: all.slice(-25).map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated })),
  };
}
async function generate(url: string, body: unknown) {
  const t0 = Date.now();
  const res = await fetch(`${url}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  const nl = raw.indexOf("\n");
  let text = raw;
  if (nl >= 0) { try { JSON.parse(raw.slice(0, nl)); text = raw.slice(nl + 1); } catch { /* 先頭が JSON でない */ } }
  const visible = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
  return { status: res.status, ms: Date.now() - t0, text: visible };
}

async function main() {
  const args = process.argv.slice(2);
  const leftover = loadState();
  if (args.includes("--cleanup")) { if (leftover) await cleanup(leftover); else console.log("控えが無い（片付け済み）"); return; }
  if (leftover) { console.log("前回の控えが残っている → 先に片付ける"); await cleanup(leftover); }
  if (!existsSync(BEFORE_DIR)) { console.log(`⚠ 前の木が無い: ${BEFORE_DIR}`); return; }
  const all = JSON.parse(readFileSync(REPLAY, "utf8")) as Replay[];
  const only = args.filter((a) => !a.startsWith("--"));
  const cases = only.length ? all.filter((r) => only.includes(r.id)) : all;
  for (const g of GEN) { const u = g === "before" ? BEFORE_URL : AFTER_URL; if (!(await fetch(u).then(() => true, () => false))) { console.log(`⚠ サーバーが無い: ${u}`); return; } }
  const results: Array<Record<string, unknown>> = [];
  const s = await begin();
  try {
    for (const r of cases) {
      console.log(`\n${"═".repeat(72)}\n【${r.id}】${r.scene}（実物 ${r.conv8}・スタッフ: ${r.staffAix ?? "手打ち"}＝${r.staffMove}・線 ${r.tracks.join("＋")}${r.twoTracks ? "・両方" : ""}）`);
      // 別のテストが YUMA に場面を入れている間は待つ（最大10分）。混ざるとブレインがその発言も読む
      for (let w = 0; (await foreignRows(s)) > 0; w++) {
        if (w >= 60) throw new Error("別のテストの発言が YUMA に残っている → 止める");
        if (w === 0) console.log("  別のテストの発言が YUMA にある → 消えるまで待つ");
        await new Promise((res) => setTimeout(res, 10_000));
      }
      await insertScene(s, r);
      const { data: ls } = await sb.from("conversations").select("last_sender").eq("id", Y).maybeSingle();
      if ((ls as { last_sender?: string } | null)?.last_sender !== s.conv.last_sender) throw new Error("last_sender が変わった（cron が拾う恐れ）→ 止める");
      // 後のブレインが見る今の状況と並行で探す場面（作業コピーの純関数で同じ値を出す）
      const cs = await getCustomerState(Y);
      const { data: last15 } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(15);
      const pctx = resolveParallelSearchScene({ state: cs, ...parallelSearchInputsFromMessages((last15 ?? []) as Array<{ sender: string; text: string | null; created_at: string }>) });
      console.log(`  今の状況: ${cs?.headline ?? "（読めない）"}／並行の場面: ${pctx.scene ?? "なし"}${pctx.evidence ? `（${pctx.evidence}）` : ""}${pctx.blockedBy ? ` 対象外=${pctx.blockedBy}` : ""}`);
      const tmpB = join(MAIN, "scripts", `.tmp-switch-brain-before.json`), tmpA = join(MAIN, "scripts", `.tmp-switch-brain-after.json`);
      const metaB = runBrain(BEFORE_DIR, tmpB);
      const metaA = runBrain(MAIN, tmpA);
      for (const f of [tmpB, tmpA]) if (existsSync(f)) unlinkSync(f);
      const brainOf = (m: Record<string, unknown> | null) => m ? {
        action: (m.action as string) || null, alt: (m.alt_actions as string[] | undefined) ?? null, parallel: (m.parallel_search as Record<string, unknown> | undefined) ?? null,
        dir: String(m.reply_direction ?? "").slice(0, 140),
      } : null;
      const b = brainOf(metaB), a = brainOf(metaA);
      console.log(`  ブレイン 前: ${JSON.stringify(b)}\n  ブレイン 後: ${JSON.stringify(a)}`);
      const res: Record<string, unknown> = { stage: cs?.stage ?? null, parallelScene: pctx.scene, id: r.id, scene: r.scene, staffMove: r.staffMove, staffAix: r.staffAix, twoTracks: r.twoTracks, tracks: r.tracks, before: b, after: a, gens: {} };
      for (const side of GEN) {
        // FORCE_PARALLEL=1: 後の判断に「並行で探す on」を置いて（=2 は待ちの局面 wait も外す＝材料が生成に届く経路だけの確かめ）、生成の材料（buildParallelSearchReplyNote）と最終チェックの免除だけを確かめる（ブレインは呼ばない）
        const meta = side === "before" ? metaB
          : (process.env.FORCE_PARALLEL === "1" || process.env.FORCE_PARALLEL === "2") && metaA ? { ...metaA, ...(process.env.FORCE_PARALLEL === "2" && metaA.engagement_stance === "wait" ? { engagement_stance: null } : {}), parallel_search: { on: true, reason: "他の物件とも比べている", scene: "after_viewing" }, alt_actions: [...((metaA.alt_actions as string[] | undefined) ?? []), "property_send"] } : metaA;
        // 使い回した判断は analyzed_msg_ts が前に場面を入れた時刻のまま → 生成が「古い判断」（T2）と読み、並行で探す・AIX を使わない。
        //   今入れた場面の最後のお客様の発言の時刻にそろえる（2026-09-26 FORCE_PARALLEL=2 の回で T2 になった反省）
        const { data: lc } = await sb.from("messages").select("created_at").eq("conversation_id", Y).eq("sender", "customer").order("created_at", { ascending: false }).limit(1).maybeSingle();
        const metaNow = meta && (lc as { created_at?: string } | null)?.created_at ? { ...meta, analyzed_msg_ts: (lc as { created_at: string }).created_at } : meta;
        await writeConv({ suggested_aix_meta: metaNow, brain_analyzed_at: new Date().toISOString(), ai_draft: null, draft_pending_at: null });
        const body = await buildBody();
        const texts: string[] = [];
        for (let i = 0; i < N; i++) {
          const g = await generate(side === "before" ? BEFORE_URL : AFTER_URL, body);
          texts.push(g.text);
          console.log(`  ── ${side === "before" ? "前" : "後"}#${i + 1} (${(g.ms / 1000).toFixed(1)}s)${/お待たせ/.test(g.text) ? " ⚠お待たせ" : ""}\n     ${g.text.replace(/\n/g, " ／ ")}`);
        }
        (res.gens as Record<string, string[]>)[side] = texts;
      }
      console.log(`  スタッフの実送信: ${r.staffText.replace(/\n/g, " ／ ").slice(0, 200)}`);
      results.push(res);
      writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
      await dropSceneRows(s);
    }
  } finally {
    await cleanup(s);
  }
  // まとめ
  const row = (x: Record<string, unknown>) => {
    const b = x.before as { action: string | null } | null, a = x.after as { action: string | null; parallel: { on?: boolean } | null } | null;
    const staff = String(x.staffMove);
    return { id: x.id, staff, two: x.twoTracks, before: cls(b?.action), after: cls(a?.action), mB: cls(b?.action) === staff, mA: cls(a?.action) === staff, par: a?.parallel ? (a.parallel.on ? "on" : "off") : "-" };
  };
  const rows = results.map(row);
  console.log("\n── まとめ（AIX の類の一致: スタッフの最初の動き）──");
  for (const x of rows) console.log(`  ${String(x.id).padEnd(14)} スタッフ=${x.staff}${x.two ? "(両方)" : ""}  前=${x.before}${x.mB ? "○" : "×"}  後=${x.after}${x.mA ? "○" : "×"}  並行=${x.par}`);
  const twoRows = rows.filter((x) => x.par !== "-");
  console.log(`  一致 前 ${rows.filter((x) => x.mB).length}/${rows.length}・後 ${rows.filter((x) => x.mA).length}/${rows.length}`);
  console.log(`  並行で探す（場面の中 ${twoRows.length}件）: スタッフが両方した回で on ${twoRows.filter((x) => x.two && x.par === "on").length}/${twoRows.filter((x) => x.two).length}・片方だけの回で off ${twoRows.filter((x) => !x.two && x.par === "off").length}/${twoRows.filter((x) => !x.two).length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
