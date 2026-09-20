// suggested_aix.action に AIX 一覧に無い語（"closing"）が入っている件（読み取りのみ）
//
// 2026-09-20 竹内「ブレインの判断通りにうごくか、ちゃんと AIX-META わたされているか」
//   YUMA の生成で suggested_aix = {"action":"closing","note":"内覧希望を頂いたので直近の複数候補日時を提示し…"}
//   が返った。"closing" は AIX_BUTTON_LABELS / AIX_ACTION_REPLY_DIRECTION のどちらにも無い。
//   さらに note の「候補日時を提示」は viewing_invite.forbid「具体的な候補日時・2択日程」と矛盾する。
//   → ①出所（DB の保存値か、その場の生成か）②同じ壊れ方が全会話に何件あるか を出す。
import { createClient } from "@supabase/supabase-js";
import { AIX_BUTTON_LABELS, AIX_ACTION_REPLY_DIRECTION, normalizeAixActionKey } from "../app/lib/aix-taxonomy";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const KNOWN = new Set([...Object.keys(AIX_BUTTON_LABELS), ...Object.keys(AIX_ACTION_REPLY_DIRECTION)]);

async function main() {
  // ⚠ 列名は実在するものだけ（route.ts のコメント: status はあるが state は無い／
  //   last_brain_meta はあるが brain_meta は無い）。存在しない列を select すると静かに0件になる。
  const { data: y, error: yErr } = await sb.from("conversations")
    .select("id, customer_name, status, suggested_aix_meta, last_brain_meta, brain_analyzed_at").eq("id", YUMA).maybeSingle();
  if (yErr) console.log(`   ⚠ select error: ${yErr.message}`);
  const row = (y ?? {}) as Record<string, unknown>;
  console.log(`=== YUMA の DB 上の suggested_aix_meta ===`);
  console.log(`   ${JSON.stringify(row.suggested_aix_meta)?.slice(0, 500)}`);
  console.log(`   brain_analyzed_at: ${row.brain_analyzed_at}\n`);

  const bm = row.last_brain_meta as Record<string, unknown> | null;
  if (bm && typeof bm === "object") {
    console.log(`=== YUMA の brain_meta（AIX に関わる所だけ）===`);
    for (const k of Object.keys(bm)) {
      const v = JSON.stringify(bm[k]);
      if (/aix|action|next|viewing|内覧/i.test(k) || /aix|候補日時|内覧/.test(v ?? "")) {
        console.log(`   ${k}: ${(v ?? "").slice(0, 300)}`);
      }
    }
    console.log(`   （brain_meta のキー全部: ${Object.keys(bm).join(", ")}）\n`);
  } else console.log(`=== YUMA の brain_meta: なし ===\n`);

  // 全会話で action が AIX 一覧に無い物を数える
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 12; p++) {
    const { data, error } = await sb.from("conversations").select("id, customer_name, status, suggested_aix_meta, last_brain_meta")
      .not("suggested_aix_meta", "is", null).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ select error: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  console.log(`=== suggested_aix_meta が入っている会話 ${rows.length}件 ===`);
  const bad = new Map<string, number>();
  const noteConflict: Array<{ id: string; action: string; note: string }> = [];
  let okN = 0;
  for (const r of rows) {
    const s = r.suggested_aix_meta as Record<string, unknown> | null;
    if (!s || typeof s !== "object") continue;
    const action = String(s.action ?? "");
    // note は next_steps / closing_strategy / reply_direction のどこに入っていても拾う
    const note = [s.note, s.next_steps, s.closing_strategy, s.reply_direction]
      .map((x) => (typeof x === "string" ? x : Array.isArray(x) ? x.join(" ") : "")).join(" ");
    if (action && !KNOWN.has(action)) bad.set(action, (bad.get(action) ?? 0) + 1);
    else if (action) okN++;
    // note が AIX の forbid と真逆のことを言っていないか（まずは内覧の候補日時だけ）
    if (/候補日時|日程を提示|日時を提示|複数候補/.test(note)) noteConflict.push({ id: String(r.id), action, note });
  }
  console.log(`   action が AIX 一覧にある: ${okN}件`);
  console.log(`   action が AIX 一覧に**無い**: ${[...bad.values()].reduce((a, b) => a + b, 0)}件`);
  for (const [k, n] of [...bad.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(4)}件  "${k.slice(0, 60)}"`);
  }
  console.log(`\n   note が「候補日時を提示」と言っている（AIX【内覧日調整】の担当）: ${noteConflict.length}件`);
  for (const c of noteConflict.slice(0, 8)) {
    console.log(`     [${c.action}] ${c.note.slice(0, 80)}`);
  }

  // ── action が AIX 一覧に無い時、生成側（normalizeAixActionKey）はどう扱うのか ──
  //   route.ts:3392 は rawAction = normalizeAixActionKey(brainMeta.action) を通す。
  //   null なら effectiveAction も null ＝ 推奨アクション行そのものが出ない（害なし）。
  //   問題は **部分一致で別の AIX に誤マップされる**場合（文章の中の語を拾って違う担当の direction/forbid が入る）。
  console.log(`\n=== action が AIX 一覧に無い物を normalizeAixActionKey に通すと ===`);
  let toNull = 0;
  const mapped: Array<{ raw: string; to: string }> = [];
  for (const r of rows) {
    const s = r.suggested_aix_meta as Record<string, unknown> | null;
    const action = String(s?.action ?? "");
    if (!action || KNOWN.has(action)) continue;
    const norm = normalizeAixActionKey(action);
    if (!norm) toNull++;
    else mapped.push({ raw: action, to: norm });
  }
  console.log(`   null になる（推奨アクション行が出ない＝害なし）: ${toNull}件`);
  console.log(`   別の AIX にマップされる                      : ${mapped.length}件`);
  for (const m of mapped.slice(0, 15)) {
    console.log(`     → ${m.to.padEnd(22)} ← "${m.raw.slice(0, 64)}"`);
  }
  if (mapped.length) console.log(`   ※ マップ先が場面に合っているかを目で読む（合っていなければ誤った direction/forbid が入る）`);

  // ── next_steps は「スタッフの操作手順」か「本文に書くこと」か ──
  // route.ts:4274 は next_steps[0] を「今回の返信で実行する」として生成プロンプトに渡す。
  // YUMA の Step1 は「カレンダーで直近の空き時間を複数確認する」＝ 社内操作で、本文の素材ではない。
  // どれくらいの Step1 が社内操作・AIX 操作なのかを数える（線を引く根拠）。
  const AIX_OP_RE = /AIX\s*(?:ボタン|【)|【AIX】|ボタンを押す|ボタン押す/;
  const INTERNAL_OP_RE = /カレンダー|スプレッドシート|社内|リマインド設定|アラート設定|メモ(?:を|に)残|CRM|管理画面/;
  let stepN = 0, aixOp = 0, internalOp = 0, both = 0;
  const samples: string[] = [];
  for (const r of rows) {
    const s = r.suggested_aix_meta as Record<string, unknown> | null;
    const steps = Array.isArray(s?.next_steps) ? (s!.next_steps as unknown[]).map(String) : [];
    if (!steps.length) continue;
    stepN++;
    const s1 = steps[0];
    const a = AIX_OP_RE.test(s1), i = INTERNAL_OP_RE.test(s1);
    if (a) aixOp++; if (i) internalOp++; if (a && i) both++;
    if ((a || i) && samples.length < 10) samples.push(s1);
    // Step2 以降も見る（「Step2以降を先取りするな」と渡している中身）
  }
  console.log(`\n=== next_steps がある会話 ${stepN}件 — その Step1 の中身 ===`);
  console.log(`   Step1 が AIX の操作（ボタンを押す等）: ${aixOp}件`);
  console.log(`   Step1 が社内操作（カレンダー確認等） : ${internalOp}件`);
  console.log(`   両方                                : ${both}件`);
  console.log(`   → この Step1 が「今回の返信で実行するのは Step1 のみ」として本文の素材に渡っている`);
  for (const s of samples) console.log(`     例: ${s.slice(0, 80)}`);

  // 全ステップ（Step2 以降も含む）で AIX 操作語を含む物
  let allSteps = 0, allAixOp = 0;
  for (const r of rows) {
    const s = r.suggested_aix_meta as Record<string, unknown> | null;
    const steps = Array.isArray(s?.next_steps) ? (s!.next_steps as unknown[]).map(String) : [];
    for (const st of steps) { allSteps++; if (AIX_OP_RE.test(st)) allAixOp++; }
  }
  console.log(`\n   全ステップ ${allSteps}件のうち AIX の操作手順: ${allAixOp}件（${((allAixOp / Math.max(1, allSteps)) * 100).toFixed(1)}%）`);

  // 実送信に AIX 操作語が出ているか（＝出口で落とす必要があるか。誤削除0の確認）
  const sent: string[] = [];
  for (let p = 0; p < 12; p++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 180 * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    if (r.length === 0) break;
    sent.push(...r.map((x) => x.text ?? ""));
    if (r.length < 1000) break;
  }
  console.log(`   実送信 ${sent.length}通のうち AIX 操作語を含む: ${sent.filter((t) => AIX_OP_RE.test(t)).length}通`);
  console.log(`   実送信 ${sent.length}通のうち 社内操作語を含む: ${sent.filter((t) => INTERNAL_OP_RE.test(t)).length}通`);
}
main().catch((e) => { console.error(e); process.exit(1); });
