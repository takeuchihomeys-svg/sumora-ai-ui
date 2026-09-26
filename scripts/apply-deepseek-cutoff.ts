// 「DeepSeek に渡す時刻の線」（2026-09-26 竹内）の本番DB: conversations.deepseek_cutoff_at ＋ 書くトリガー（migrate-schema/route.ts と同じ DDL）
// ＋ 過去の分の埋め戻し（今の status_manual_back_at と conversation_stage_history の戻しから）。
//
// 埋め戻しの線（どれも「申込の証拠があった後の戻し」だけ・一番新しい物＝多く切る側）:
//   戻しの時刻 E の候補 = status_manual_back_at ／ 状態の履歴で「申込以降の status → 申込前の status」／「申込以降」の解除（manual:post_apply_unmark）
//                        ／ 手の状態変更で段階が下がった物（trigger=manual）
//   申込の証拠 = E 以前に AIX【申込へ】・本人確認書類・収入証明書の記録がある、または E 以前に「申込以降の status → 申込前」の履歴がある
//   ⚠ 既に線がある会話は触らない（トリガーが書いた物が正）。出力は件数と会話ID 先頭8桁だけ
//
// 実行: npx tsx --env-file=.env.local scripts/apply-deepseek-cutoff.ts            … DDL を当てて、埋め戻しは件数を見るだけ
//       npx tsx --env-file=.env.local scripts/apply-deepseek-cutoff.ts --apply    … 埋め戻しも書く
import { createClient } from "@supabase/supabase-js";
import { DRAFT_SKIP_STATUSES, STATUS_STAGE_RANK } from "../app/lib/conversation-status";
import { resolvePostApply, deepseekSafeCutoff, NO_CUTOFF } from "../app/lib/post-apply";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.argv.includes("--apply");

// migrate-schema/route.ts の「conversations.deepseek_cutoff_at」節と同じ文（変える時は両方）
const STMTS = [
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deepseek_cutoff_at TIMESTAMPTZ;`,
  `CREATE OR REPLACE FUNCTION stamp_deepseek_cutoff()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  skip TEXT[] := ARRAY['applying','application','screening','contract','closed_won','closed_lost','lost','approved'];
  was_post BOOLEAN;
  prev_line TIMESTAMPTZ;
  last_rec TIMESTAMPTZ;
BEGIN
  IF COALESCE(NEW.status, '') = ANY(skip) OR COALESCE(NEW.is_post_apply, FALSE) THEN RETURN NEW; END IF;
  was_post := COALESCE(OLD.status, '') = ANY(skip) OR COALESCE(OLD.is_post_apply, FALSE);
  IF NOT was_post THEN
    IF NEW.status_manual_back_at IS NULL OR NEW.status_manual_back_at IS NOT DISTINCT FROM OLD.status_manual_back_at THEN RETURN NEW; END IF;
    prev_line := GREATEST(OLD.deepseek_cutoff_at, OLD.status_manual_back_at);
    SELECT GREATEST(
      (SELECT MAX(created_at) FROM aix_usage_logs WHERE conversation_id = NEW.id AND aix_type = 'application_push'),
      (SELECT MAX(created_at) FROM messages WHERE conversation_id = NEW.id AND sender = 'customer' AND image_type IN ('id_document', 'income_document'))
    ) INTO last_rec;
    was_post := last_rec IS NOT NULL AND (prev_line IS NULL OR last_rec >= prev_line);
  END IF;
  IF was_post THEN NEW.deepseek_cutoff_at := now(); END IF;
  RETURN NEW;
END;
$$;`,
  `DROP TRIGGER IF EXISTS trg_conversations_deepseek_cutoff ON conversations;`,
  `CREATE TRIGGER trg_conversations_deepseek_cutoff
BEFORE UPDATE OF status, is_post_apply, status_manual_back_at ON conversations
FOR EACH ROW EXECUTE FUNCTION stamp_deepseek_cutoff();`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

async function all<T>(b: (a: number, z: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await b(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const T = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

async function main() {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.replace(/\s+/g, " ").slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 2500));
  const chk = await sb.from("conversations").select("id, deepseek_cutoff_at").limit(1);
  console.log("select deepseek_cutoff_at:", chk.error ? `NG ${chk.error.message}` : "OK");
  if (chk.error) process.exit(1);

  type Conv = { id: string; status: string | null; is_post_apply: boolean | null; status_manual_back_at: string | null; deepseek_cutoff_at: string | null };
  const convs = await all<Conv>((a, z) => sb.from("conversations").select("id, status, is_post_apply, status_manual_back_at, deepseek_cutoff_at").range(a, z));
  const hist = await all<{ conversation_id: string; from_status: string | null; to_status: string | null; changed_at: string; trigger: string | null }>((a, z) => sb.from("conversation_stage_history").select("conversation_id, from_status, to_status, changed_at, trigger").range(a, z));
  const pushes = await all<{ conversation_id: string; created_at: string }>((a, z) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").range(a, z));
  const docs = await all<{ conversation_id: string; created_at: string }>((a, z) => sb.from("messages").select("conversation_id, created_at").eq("sender", "customer").in("image_type", ["id_document", "income_document"]).range(a, z));

  const recs = new Map<string, number[]>();
  for (const r of [...pushes, ...docs]) { const a = recs.get(r.conversation_id) ?? []; a.push(T(r.created_at)); recs.set(r.conversation_id, a); }
  const backs = new Map<string, Array<{ t: number; fromSkip: boolean }>>();
  const addBack = (cid: string, t: number, fromSkip: boolean) => { if (!Number.isFinite(t)) return; const a = backs.get(cid) ?? []; a.push({ t, fromSkip }); backs.set(cid, a); };
  for (const h of hist) {
    const from = (h.from_status ?? "").trim(), to = (h.to_status ?? "").trim();
    const fromSkip = DRAFT_SKIP_STATUSES.has(from), toSkip = DRAFT_SKIP_STATUSES.has(to);
    if (fromSkip && !toSkip) addBack(h.conversation_id, T(h.changed_at), true);
    else if (h.trigger === "manual:post_apply_unmark") addBack(h.conversation_id, T(h.changed_at), true);
    else if ((h.trigger ?? "").startsWith("manual") && !toSkip && (STATUS_STAGE_RANK[to] ?? 99) < (STATUS_STAGE_RANK[from] ?? -1)) addBack(h.conversation_id, T(h.changed_at), false);
  }
  for (const c of convs) if (c.status_manual_back_at) addBack(c.id, T(c.status_manual_back_at), false);

  const plan: Array<{ id: string; at: string; before: string; after: string }> = [];
  let alreadyHas = 0, nowPost = 0;
  for (const c of convs) {
    if (c.deepseek_cutoff_at) { alreadyHas++; continue; }
    if (DRAFT_SKIP_STATUSES.has((c.status ?? "").trim()) || c.is_post_apply) { nowPost++; continue; }
    const bs = (backs.get(c.id) ?? []).sort((x, y) => x.t - y.t);
    const rs = recs.get(c.id) ?? [];
    let line: number | null = null;
    for (const b of bs) {
      const evidence = b.fromSkip || rs.some((r) => r <= b.t) || bs.some((o) => o.fromSkip && o.t <= b.t);
      if (evidence) line = b.t;
    }
    if (line === null) continue;
    const facts = { status: c.status, isPostApply: c.is_post_apply, applicationPushAt: rs.length ? new Date(Math.max(...rs)).toISOString() : null, idDocumentAt: null, statusManualBackAt: c.status_manual_back_at };
    const before = deepseekSafeCutoff(facts);
    const after = deepseekSafeCutoff({ ...facts, deepseekCutoffAt: new Date(line).toISOString() });
    const lbl = (x: typeof before) => (x === null ? "申込中" : x === NO_CUTOFF ? "全部" : "線あり");
    plan.push({ id: c.id, at: new Date(line).toISOString(), before: `${lbl(before)}${resolvePostApply(facts).postApply ? "(下書き停止)" : ""}`, after: lbl(after) });
  }
  console.log(`\n会話 ${convs.length}件: 線あり済み ${alreadyHas}／今は申込以降 ${nowPost}／埋め戻し対象 ${plan.length}`);
  const tally = new Map<string, number>();
  for (const p of plan) { const k = `${p.before} → ${p.after}`; tally.set(k, (tally.get(k) ?? 0) + 1); }
  for (const [k, n] of tally) console.log(`   ${k}: ${n}件`);
  console.log(`   会話: ${plan.map((p) => p.id.slice(0, 8)).join(",")}`);
  if (!APPLY) { console.log("\n（--apply を付けると書く）"); return; }
  let ok = 0;
  for (const p of plan) {
    // トリガーは status 等の列の更新でしか動かないので、この列だけの更新は素直に入る
    const { error } = await sb.from("conversations").update({ deepseek_cutoff_at: p.at }).eq("id", p.id).is("deepseek_cutoff_at", null);
    if (error) console.log(`NG ${p.id.slice(0, 8)} ${error.message}`); else ok++;
  }
  console.log(`\n書いた: ${ok}/${plan.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
