// scripts/audit-final-check-vs-staff.ts
// 正解文（スタッフが実際に送った文）を最終チェックの決定論部分（runDeterministicChecks）に通し、
// 「スタッフの正解を何件止めてしまうか」をコード別に測る常設の回帰スクリプト。DB は読み取りのみ。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-final-check-vs-staff.ts [オプション]
//   --since=YYYY-MM-DD      この日以降の正解だけを対象にする
//   --threshold=0.10        総 block 率がこれを超えたら exit 1
//   --baseline=<path>       前回の結果（id→block コード配列）。これまで通っていた行が新たに block になったら exit 1
//   --write-baseline        今回の結果を --baseline（省略時 scripts/audit-final-check-baseline.json）に書く
//   --top=5                 コード別に表示する例の数
//   --json=<path>           行ごとの結果を書き出す（個人情報を含むので .gitignore 対象の場所に置く）
//   --cache=<path>          取得した生データを保存・再利用する（反復測定用。個人情報を含むのでリポジトリ外に置く）
//   --last-unit-only        旧測定（直前の顧客発言1通だけ）との比較専用
//   --raw                   後処理（applySurfaceFixes）をかけずに検査する
//   --draft                 送信文ではなく AI 下書き（下書き≠送信の行）を検査する（本当の誤りを止められているかの確認用）
// 終了コード: 0=合格 / 1=閾値・上限・回帰のいずれか超過 / 2=DB エラー
//
// ctx の組み立ては本番（page.tsx:3212 / generate-draft-bg-async:262）と同じ「未返信の顧客発言を MSG_SEP でつなぐ」形に固定する。
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { buildActionLedger, type LedgerAixRow, type LedgerTask } from "@/app/lib/action-ledger";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, MSG_SEP } from "@/app/lib/reply-context";
import { runDeterministicChecks, type FinalCheckContext, type CheckIssue } from "@/app/lib/final-check";
import { resolveAddressName, applySurfaceFixes } from "@/app/lib/validate-reply";
import { isConditionFormMessage } from "@/app/lib/line-reply-prompts";
import { isUsableExampleText } from "@/app/lib/example-hygiene";
import { SHOCHI_RE, HASTY_ADVERB_TEST_RE } from "@/app/lib/banned-phrasing";

type Msg = { sender: string; text: string; created_at: string; is_aix_generated: boolean | null };
type Example = { id: string; conversation_id: string; sent_reply: string; ai_draft: string | null; was_ai_modified: boolean | null; is_starred: boolean | null; created_at: string; sent_at: string | null };
type ConvData = { customer_name: string | null; /** property_customers.customer_name（生成側 fetchDbCustomerNames と同じ） */ pc_name?: string | null; msgs: Msg[]; aix: LedgerAixRow[]; tasks: LedgerTask[] };
type Raw = { fetchedAt: string; examples: Example[]; convs: Record<string, ConvData> };

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1], m[2] ?? "true");
}
const SINCE = args.get("since") ?? null;
// 2026-09-11 竹内方針1〜5 実装後: 本番同等モード 42/753＝5.6%（実装前 361/753＝47.9%）。最終目標 ≤10% を既定の閾値にする（ラチェット）
const THRESHOLD = Number(args.get("threshold") ?? "0.10");
const BASELINE = args.get("baseline") ?? "scripts/audit-final-check-baseline.json";
const WRITE_BASELINE = args.has("write-baseline");
const TOP = Number(args.get("top") ?? "5");
const JSON_OUT = args.get("json") ?? null;
const CACHE = args.get("cache") ?? null;
const LAST_UNIT_ONLY = args.has("last-unit-only");
const RAW = args.has("raw");
/** 送信文ではなく AI 下書き（ai_draft）を検査する（「本当の誤りを止められているか」の確認用。下書き≠送信の行だけ） */
const DRAFT = args.has("draft");

/** コード別の上限（率）。超えたら exit 1。
 *  竹内方針1〜5（2026-09-11）: 観測専用コード（必須要素・骨格系）と CONDITION_ECHO_MISSING の block は仕様として 0 件。
 *  置換後の BANNED（承知）と HASTY は 0 件。NAME_MISMATCH / CONFIRM_NO_OBJECT は 0.5% 以下 */
const CODE_CAPS: Record<string, number> = {
  PAIR_ELEMENT_MISSING: 0, REPLY_SKELETON_MISSING: 0, CONCERN_UNADDRESSED: 0, WE_DO_MISSING_DET: 0, GENERIC_ONLY_REPLY: 0,
  CONDITION_ECHO_MISSING: 0, HASTY_PROMISE: 0,
  NAME_MISMATCH: 0.005, CONFIRM_NO_OBJECT: 0.005,
  // 2026-09-12 竹内方針B: 目的語の無い/顧客発言に無い「承りました」の検査（正解6通で偽陽性0）
  UKETAMAWARI_OBJECT_UNANCHORED: 0.005,
  // 2026-09-12 竹内方針A-3: 断言検査の誤検出（願望形・時間枠・条件の並び・キャンセルのトラブル）が戻ったら検知する
  SCREENING_ASSURANCE: 0.005, MOVEIN_DATE_ASSERTION: 0.005, DISCLOSURE_ASSERTION: 0.005,
};

const norm = (s: string) => (s ?? "").replace(/\s+/g, "");
const head60 = (s: string) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
const SHOCHI_TEST_RE = new RegExp(SHOCHI_RE.source);

function sbClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / key が未設定（--env-file=.env.local を付ける）");
  return createClient(url, key);
}
/** 会話ごとの property_customers.customer_name（生成側と同じく呼び名の候補④に使う） */
async function fetchPcNames(convIds: string[]): Promise<Map<string, string | null>> {
  const sb = sbClient();
  const out = new Map<string, string | null>();
  const pcOf = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 100) {
    const { data, error } = await sb.from("conversations").select("id, property_customer_id").in("id", convIds.slice(i, i + 100));
    if (error) throw error;
    for (const c of (data ?? []) as Array<{ id: string; property_customer_id: string | null }>) if (c.property_customer_id) pcOf.set(c.id, c.property_customer_id);
  }
  const pcIds = [...new Set(pcOf.values())];
  const names = new Map<string, string | null>();
  for (let i = 0; i < pcIds.length; i += 100) {
    const { data, error } = await sb.from("property_customers").select("id, customer_name").in("id", pcIds.slice(i, i + 100));
    if (error) throw error;
    for (const p of (data ?? []) as Array<{ id: string; customer_name: string | null }>) names.set(p.id, p.customer_name);
  }
  for (const cid of convIds) out.set(cid, pcOf.has(cid) ? names.get(pcOf.get(cid)!) ?? null : null);
  return out;
}

async function fetchRaw(): Promise<Raw> {
  const sb = sbClient();
  const examples: Example[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from("ai_reply_examples")
      .select("id, conversation_id, sent_reply, ai_draft, was_ai_modified, is_starred, created_at, sent_at")
      .eq("entry_source", "line_reply").or("was_ai_modified.eq.true,is_starred.eq.true").not("conversation_id", "is", null)
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (SINCE) q = q.gte("created_at", SINCE);
    const { data, error } = await q;
    if (error) throw error;
    examples.push(...((data ?? []) as Example[]));
    if (!data || data.length < 1000) break;
  }
  const convIds = [...new Set(examples.map((e) => e.conversation_id))];
  const convs: Record<string, ConvData> = {};
  const names = new Map<string, string | null>();
  for (let i = 0; i < convIds.length; i += 100) {
    const { data, error } = await sb.from("conversations").select("id, customer_name").in("id", convIds.slice(i, i + 100));
    if (error) throw error;
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null }>) names.set(c.id, c.customer_name);
  }
  // PostgREST は1リクエスト最大1000行なので messages は会話ごとに取る（desc limit 1000 → reverse）
  const queue = [...convIds];
  const worker = async () => {
    for (let cid = queue.shift(); cid; cid = queue.shift()) {
      const [m, a, t] = await Promise.all([
        sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(1000),
        sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, generated_text, property_names, estimate_sent, template_name").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(300),
        sb.from("line_tasks").select("task_type, status, created_at, completed_at, result").eq("conversation_id", cid).limit(300),
      ]);
      if (m.error) throw m.error;
      if (a.error) throw a.error;
      if (t.error) throw t.error;
      convs[cid] = {
        customer_name: names.get(cid) ?? null,
        msgs: ((m.data ?? []) as Msg[]).reverse().filter((x) => typeof x.text === "string"),
        aix: (a.data ?? []) as LedgerAixRow[],
        tasks: (t.data ?? []) as LedgerTask[],
      };
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const pcNames = await fetchPcNames(convIds);
  for (const cid of convIds) if (convs[cid]) convs[cid].pc_name = pcNames.get(cid) ?? null;
  return { fetchedAt: new Date().toISOString(), examples, convs };
}

type RowResult = {
  id: string; cid: string; codes: string[]; rule: string | null;
  cust: string; sent: string; evidence: Record<string, string>;
  surfaceChanged: boolean; policyDiff: string[]; typo: string[];
};

(async () => {
  let raw: Raw;
  try {
    if (CACHE && fs.existsSync(CACHE)) {
      raw = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Raw;
      // 旧キャッシュ（pc_name なし）は DB 名だけ補って書き戻す
      const missing = Object.keys(raw.convs).filter((cid) => raw.convs[cid].pc_name === undefined);
      if (missing.length) {
        const pc = await fetchPcNames(missing);
        for (const cid of missing) raw.convs[cid].pc_name = pc.get(cid) ?? null;
        fs.writeFileSync(CACHE, JSON.stringify(raw));
      }
    } else {
      raw = await fetchRaw();
      if (CACHE) fs.writeFileSync(CACHE, JSON.stringify(raw));
    }
  } catch (e) {
    console.error("[audit] DB エラー:", e instanceof Error ? e.message : e);
    process.exit(2);
  }
  const examples = SINCE ? raw.examples.filter((e) => e.created_at >= SINCE) : raw.examples;
  let excluded = 0, unmatched = 0, noCustomer = 0;
  const rows: RowResult[] = [];
  for (const e of examples) {
    // 生成失敗文・テスト送信は読む側で除外（行は削除しない・example-hygiene と同じ判定）
    if (!isUsableExampleText(e.sent_reply)) { excluded++; continue; }
    const conv = raw.convs[e.conversation_id];
    if (!conv) { unmatched++; continue; }
    const msgs = conv.msgs;
    // 送信文の特定: 空白を除いた先頭60字の一致 → 無ければ ±10分以内の最寄りのスタッフ送信
    const head = norm(e.sent_reply).slice(0, 60);
    let idx = msgs.findIndex((x) => x.sender === "staff" && head.length >= 8 &&
      (norm(x.text).startsWith(head) || (head.startsWith(norm(x.text).slice(0, 60)) && norm(x.text).length >= 20)));
    if (idx < 0) {
      const t = Date.parse(e.sent_at ?? e.created_at);
      let best = -1, bd = 10 * 60 * 1000;
      msgs.forEach((x, i) => { if (x.sender !== "staff") return; const d = Math.abs(Date.parse(x.created_at) - t); if (d <= bd) { bd = d; best = i; } });
      idx = best;
    }
    if (idx < 0) { unmatched++; continue; }
    // 10分以内に続くスタッフ送信（分割送信）は1回の送信として先頭まで遡る
    let start = idx;
    while (start > 0 && msgs[start - 1].sender === "staff" && Date.parse(msgs[start].created_at) - Date.parse(msgs[start - 1].created_at) <= 10 * 60 * 1000) start--;
    const before = msgs.slice(0, start);
    // 未返信の顧客メッセージの連続（本番と同じく MSG_SEP でつなぐ）
    const custUnits: string[] = [];
    for (let j = before.length - 1; j >= 0 && before[j].sender !== "staff"; j--) if (before[j].sender === "customer") custUnits.unshift(before[j].text);
    if (custUnits.length === 0) { noCustomer++; continue; }
    if (LAST_UNIT_ONLY) custUnits.splice(0, custUnits.length - 1);
    const cust = custUnits.join(MSG_SEP);
    const sendAt = Date.parse(msgs[idx].created_at);
    const recent = before.slice(-10).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated }));
    const lastStaffMsg = [...before].reverse().find((x) => x.sender === "staff");
    const aixRows = conv.aix.filter((r) => Date.parse(r.created_at ?? "") < sendAt - 1000);
    const ledgerTasks = conv.tasks.filter((t) => Date.parse(t.created_at ?? "") < sendAt);
    const ledger = buildActionLedger({
      recentAixRows: aixRows,
      messages: before.slice(-30).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated })),
      lineTasks: ledgerTasks, lastCustomerAt: before[before.length - 1]?.created_at ?? null, now: sendAt,
    });
    const staff = classifyLastStaffTurn(lastStaffMsg?.text ?? "", { recentAixRows: aixRows, lastStaffAt: lastStaffMsg?.created_at ?? null, ledger });
    const sub = analyzeSubstance(cust, custUnits, { staffAskedQuestion: staff.kind === "question_to_customer" });
    const customer = classifyCustomerResponse(sub, staff, { ledger, isConditionPresented: isConditionFormMessage(cust) });
    const lastStaffIdx = before.map((x) => x.sender).lastIndexOf("staff");
    const priorCustomerText = lastStaffIdx < 0 ? "" : [...before.slice(0, lastStaffIdx)].reverse().find((x) => x.sender === "customer")?.text ?? "";
    // 呼び名は生成側と同じ resolveAddressName（送信時点より前の全メッセージ・表示名）
    const addr = resolveAddressName({ messages: before.map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at })), displayName: conv.customer_name ?? "", pcName: conv.pc_name ?? "" });
    const name = addr.name;
    const pair = resolveTurnPair(staff, customer, sub, lastStaffMsg?.text ?? "", { ledger, customerName: name, priorCustomerText });
    const ctx: FinalCheckContext = { lastCustomerMessage: cust, recentMessages: recent, customerName: name, nameAliases: addr.aliases, ledger, ledgerStrict: true, substance: sub, pairContext: pair, now: sendAt };
    // 既定では生成の後処理と同じ applySurfaceFixes（別名の統一・承知→かしこまりました・すぐに除去・誤字）を通してから検査する
    const policyDiff: string[] = [];
    if (SHOCHI_TEST_RE.test(DRAFT ? (e.ai_draft ?? "") : e.sent_reply)) policyDiff.push("承知→かしこまりました");
    if (HASTY_ADVERB_TEST_RE.test(DRAFT ? (e.ai_draft ?? "") : e.sent_reply)) policyDiff.push("すぐに除去");
    const src = DRAFT ? (e.ai_draft ?? "") : e.sent_reply;
    if (DRAFT && (!src.trim() || !isUsableExampleText(src) || norm(src) === norm(e.sent_reply))) continue;
    const text = RAW ? src : applySurfaceFixes(src, { customerName: name, aliases: addr.aliases, now: sendAt, fillName: true, customerMessage: cust }).text;
    const surfaceChanged = text !== src;
    let issues: CheckIssue[];
    try { issues = runDeterministicChecks(text, ctx); }
    catch (err) { console.warn("[audit] 検査エラー:", e.id, err instanceof Error ? err.message : err); continue; }
    const blocks = issues.filter((i) => i.severity === "block");
    const evidence: Record<string, string> = {};
    for (const b of blocks) if (!evidence[b.code]) evidence[b.code] = String(b.evidence ?? "").slice(0, 60);
    rows.push({
      id: e.id, cid: e.conversation_id, codes: [...new Set(blocks.map((b) => b.code))], rule: pair.rule?.id ?? null,
      cust: head60(cust.split(MSG_SEP).join(" ／ ")), sent: head60(src), evidence, surfaceChanged, policyDiff,
      typo: issues.filter((i) => i.code.startsWith("TYPO_")).map((i) => i.code),
    });
  }

  const n = rows.length;
  const blocked = rows.filter((r) => r.codes.length > 0);
  const rate = n ? blocked.length / n : 0;
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log(`正解 ${examples.length} 件（除外 ${excluded}: 生成失敗文・空文 / 照合できず ${unmatched} / 直前に顧客発言なし ${noCustomer}）→ 測定 ${n} 件`);
  console.log(`モード: ${LAST_UNIT_ONLY ? "単発（直前の顧客発言1通）" : "本番同等（未返信の顧客発言を連結）"}${RAW ? "・後処理なし" : ""}${DRAFT ? "・AI下書き（下書き≠送信の行）" : ""}`);
  console.log(`block ${blocked.length}/${n} = ${pct(rate)}（閾値 ${pct(THRESHOLD)}）`);
  const byCode = new Map<string, RowResult[]>();
  for (const r of blocked) for (const c of r.codes) byCode.set(c, [...(byCode.get(c) ?? []), r]);
  console.log("\n■ コード別（block を含む行数）");
  for (const [c, rs] of [...byCode].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${c.padEnd(30)} ${String(rs.length).padStart(4)}  ${pct(rs.length / n)}`);
  const byRule = new Map<string, { n: number; b: number }>();
  for (const r of rows) { const k = r.rule ?? "(セルなし)"; const v = byRule.get(k) ?? { n: 0, b: 0 }; v.n++; if (r.codes.length) v.b++; byRule.set(k, v); }
  console.log("\n■ セル別（block 行 / 行数）");
  for (const [k, v] of [...byRule].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(30)} ${String(v.b).padStart(4)}/${String(v.n).padEnd(4)} ${pct(v.b / v.n)}`);
  if (TOP > 0) {
    console.log(`\n■ コード別の例（上位${TOP}件・本文は先頭60字のみ）`);
    for (const [c, rs] of [...byCode].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  [${c}]`);
      for (const r of rs.slice(0, TOP)) console.log(`    ${r.id.slice(0, 8)} 顧客「${r.cust}」\n             送信「${r.sent}」\n             evidence「${r.evidence[c] ?? ""}」`);
    }
  }
  const surface = rows.filter((r) => r.surfaceChanged).length;
  const policy = rows.filter((r) => r.policyDiff.length > 0);
  const typoRows = rows.filter((r) => r.typo.length > 0);
  console.log(`\n■ 後処理（applySurfaceFixes）で変わった行: ${surface}`);
  console.log(`■ 方針上わざとスタッフ文と違えている差（承知→かしこまりました／すぐに除去）: ${policy.length} 行`);
  console.log(`■ 誤字 warning（スタッフ実文の誤字）: ${typoRows.length} 行（${pct(n ? typoRows.length / n : 0)}）`);

  const typoByCode = new Map<string, number>();
  for (const r of typoRows) for (const c of r.typo) typoByCode.set(c, (typoByCode.get(c) ?? 0) + 1);
  if (typoByCode.size) console.log(`   内訳: ${[...typoByCode].map(([c, k]) => `${c} ${k}`).join(" / ")}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ n, rate, rows }, null, 1));

  let fail = false;
  if (rate > THRESHOLD) { console.log(`\n✗ 総 block 率 ${pct(rate)} が閾値 ${pct(THRESHOLD)} を超えた`); fail = true; }
  for (const [c, cap] of Object.entries(CODE_CAPS)) {
    const k = (byCode.get(c) ?? []).length;
    if (k / Math.max(n, 1) > cap) { console.log(`✗ ${c} の block ${k} 件（${pct(k / n)}）が上限 ${pct(cap)} を超えた`); fail = true; }
  }
  if (fs.existsSync(BASELINE) && !WRITE_BASELINE) {
    const base = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as { rows: Record<string, string[]> };
    const regressed = rows.filter((r) => r.codes.length > 0 && base.rows[r.id] !== undefined && base.rows[r.id].length === 0);
    if (regressed.length) {
      console.log(`✗ baseline で通っていた ${regressed.length} 行が新たに block:`);
      for (const r of regressed.slice(0, 20)) console.log(`    ${r.id.slice(0, 8)} ${r.codes.join(",")} 送信「${r.sent}」`);
      fail = true;
    } else console.log("✓ baseline に対する回帰なし");
  }
  if (WRITE_BASELINE) {
    const out = { generatedAt: new Date().toISOString(), mode: LAST_UNIT_ONLY ? "last_unit" : "production", rate, n, rows: Object.fromEntries(rows.map((r) => [r.id, r.codes])) };
    fs.writeFileSync(BASELINE, JSON.stringify(out, null, 1));
    console.log(`baseline を書き出し: ${BASELINE}`);
  }
  process.exit(fail ? 1 : 0);
})();
