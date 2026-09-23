// 「申込以降は別クラウド（DeepSeek）に回さない」の歯止めが、実際に効いていたかを数える（読み取りのみ）
//
// 2026-09-23 竹内「AIXの申込へボタンがトリガーにする。そうするとお客さんの個人情報（本人確認書類もここで届く）が渡らないのでより安全」
// 2026-09-23 竹内「否決となって再度物件提案中にもどる場合は渡してよい。申込からの審査中は渡らないようにする」
//
// 【従来】判定は conversations.status（DRAFT_SKIP_STATUSES）だけ。status は27.4%の会話でブレインの段階より遅れる。
// 【新】app/lib/post-apply.ts: status ∪ スタッフの印 ∪ （AIX【申込へ】押下 ∪ 本人確認書類の受信 が、スタッフが段階を戻した時刻より新しい）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-post-apply-gate.ts
import { createClient } from "@supabase/supabase-js";
import { resolvePostApply, loadPostApplyFacts } from "../app/lib/post-apply";
import { DRAFT_SKIP_STATUSES } from "../app/lib/conversation-status";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const convs = await all<{ id: string; status: string | null; is_post_apply: boolean | null; status_manual_back_at: string | null }>((a, b) => sb.from("conversations").select("id, status, is_post_apply, status_manual_back_at").range(a, b));
  const pushes = await all<{ conversation_id: string; created_at: string }>((a, b) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").order("created_at").range(a, b));
  const idDocs = await all<{ conversation_id: string; created_at: string }>((a, b) => sb.from("messages").select("conversation_id, created_at").eq("image_type", "id_document").eq("sender", "customer").order("created_at").range(a, b));
  const alt = await all<{ conversation_id: string | null; created_at: string; route: string | null; action: string | null }>((a, b) => sb.from("llm_usage_logs").select("conversation_id, created_at, route, action").ilike("model", "%deepseek%").order("created_at").range(a, b));

  const lastPush = new Map<string, string>(), lastId = new Map<string, string>();
  for (const p of pushes) lastPush.set(p.conversation_id, p.created_at);          // 古い順に読むので最後が残る
  for (const d of idDocs) lastId.set(d.conversation_id, d.created_at);
  const byId = new Map(convs.map((c) => [c.id, c]));

  console.log(`=== ① 今の会話 ${convs.length}件で「申込以降」になる根拠 ===`);
  const reasons = new Map<string, number>();
  for (const c of convs) {
    const r = resolvePostApply({ status: c.status, isPostApply: c.is_post_apply, applicationPushAt: lastPush.get(c.id) ?? null, idDocumentAt: lastId.get(c.id) ?? null, statusManualBackAt: c.status_manual_back_at });
    const k = r.postApply ? (r.reason ?? "") : r.movedBack ? "申込前（否決などで戻した）" : "申込前";
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...reasons].sort((x, y) => y[1] - x[1])) console.log(`   ${k.padEnd(22)} ${String(n).padStart(4)}件`);
  console.log(`   ⚠ status 以外の根拠で申込以降になる会話＝従来の歯止めが見落としていた会話。「戻した」は申込へ押下の後にスタッフが段階を戻した会話（再び回してよい）`);

  console.log(`\n=== ② DeepSeek へ実際に回った呼び出し ${alt.length}回（llm_usage_logs）で、その時点で申込以降だった物 ===`);
  const byRoute = new Map<string, { n: number; leaked: number; leakedConvs: Set<string>; byReason: Map<string, number> }>();
  for (const u of alt) {
    const k = u.route ?? "?";
    const e = byRoute.get(k) ?? { n: 0, leaked: 0, leakedConvs: new Set(), byReason: new Map() }; e.n++;
    const cid = u.conversation_id ?? "";
    const at = new Date(u.created_at).getTime();
    const c = byId.get(cid);
    // その時点の status・戻しの印は分からないので、押下・受信・戻しの時刻で「その時点で根拠があったか」を見る（status は今の値）
    const before = (iso: string | null | undefined) => (iso && new Date(iso).getTime() < at ? iso : null);
    const r = resolvePostApply({
      status: c && DRAFT_SKIP_STATUSES.has(c.status ?? "") ? c.status : null,
      isPostApply: false,
      applicationPushAt: before(lastPush.get(cid)),
      idDocumentAt: before(lastId.get(cid)),
      statusManualBackAt: before(c?.status_manual_back_at),
    });
    if (r.postApply && r.reason !== "status") { e.leaked++; e.leakedConvs.add(cid); e.byReason.set(r.reason ?? "", (e.byReason.get(r.reason ?? "") ?? 0) + 1); }
    byRoute.set(k, e);
  }
  for (const [k, e] of byRoute) {
    console.log(`   ${k.padEnd(22)} ${String(e.n).padStart(4)}回 → 申込へ押下・本人確認書類の後（戻す前）に回った ${e.leaked}回（${pct(e.leaked, e.n)}・${e.leakedConvs.size}会話）${[...e.byReason].map(([r, n]) => ` ${r}:${n}`).join("")}`);
  }
  console.log(`   ⚠ 新しい判定（post-apply.ts）なら、この回数は 0 になる（押下・受信の瞬間から Claude に戻る）`);

  // ── ③ 本物のクライアントで、本番と同じ loadPostApplyFacts を通す（会話IDは頭8桁だけ） ──
  console.log(`\n=== ③ 本番と同じ loadPostApplyFacts で実際の会話を判定（申込へ押下あり4件＋戻した会話2件＋YUMA）===`);
  const ids = [...lastPush.keys()].slice(-4);
  ids.push(...convs.filter((c) => c.status_manual_back_at && lastPush.has(c.id)).slice(0, 2).map((c) => c.id));
  ids.push("dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"); // YUMA（テスト用）
  for (const id of ids) {
    const f = await loadPostApplyFacts(sb, id);
    const r = resolvePostApply(f);
    const d = (iso: string | null | undefined) => (iso ? iso.slice(5, 10) : "—");
    console.log(`   ${id.slice(0, 8)}… status=${f.status} 印=${f.isPostApply} 申込へ=${d(f.applicationPushAt)} 本人確認=${d(f.idDocumentAt)} 戻し=${d(f.statusManualBackAt)} → 申込以降=${r.postApply}（${r.reason ?? (r.movedBack ? "戻した" : "—")}）`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
