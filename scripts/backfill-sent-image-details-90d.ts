// scripts/backfill-sent-image-details-90d.ts — 送った物件の資料の画像で、中身の行（image_details）が無い物を読み直す（本番 DB に書く）
//
// 2026-10-13 竹内さん承認「過去の物件資料の画像の読み直しをする（本番 DB への書き戻しも可）」
//   10/09 の調べ: 90日で送った資料の画像 4,045枚のうち中身の行が無い 3,407枚・置き場に残るのは見本で 9割。
//   中身の行（向き・ペット・設備・現況・入居可能日）が無いと、返信・ブレイン・事実の照らし（draft-fact-grounding）が資料の事実を使えない。
// 読み方は本番と同じ ensureImageDetail（売上サポの行の image_lines／文字層 → 無ければ書き写し→文字の読み取り・推論なし）。
//   ・申込以降・線より前は読まない（ensureImageDetail が送った時刻 sentAt で loadDeepseekCutoff を見る）
//   ・見積書（source=aix:estimate_sheet）は読まない（お客様の名前入り）
//   ・テスト・社内の会話は読まない
//   ・置き場から消えた画像は読まない（HEAD で 200 以外）
//   ・時間切れ（読めず）は1回だけ読み直す
//   ・書くのは読めた時だけ（ensureImageDetail は失敗を残さない）
// 実行: npx tsx --env-file=.env.local scripts/backfill-sent-image-details-90d.ts [--days=90] [--limit=50] [--conc=4] [--apply]
// 既定は数えるだけ（LLM も DB の書き込みもしない）。読んで書くのは --apply の時だけ（2026-10-13 レビュー）
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "90")), LIMIT = Number(arg("limit", "50")), CONC = Number(arg("conc", "4"));
const DRY = !process.argv.includes("--apply");

type Row = { image_url: string; conversation_id: string; created_at: string; source: string | null };

async function main() {
  const { ensureImageDetail } = await import("../app/lib/image-detail-store");
  const { isTestConversation } = await import("../app/lib/test-conversations");
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("sent_image_properties").select("image_url, conversation_id, created_at, source")
      .gte("created_at", since).like("image_url", "%/property-images/%").order("created_at", { ascending: false }).range(f, f + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const have = new Set<string>();
  const urls = [...new Set(rows.map((r) => r.image_url))];
  for (let i = 0; i < urls.length; i += 40) {
    const { data } = await sb.from("image_details").select("image_url").in("image_url", urls.slice(i, i + 40));
    for (const d of (data ?? []) as Array<{ image_url: string }>) have.add(d.image_url);
  }
  // お客様が送った画像（本人確認書類・申込書・支払いの控えなどがありうる）は読まない＝image-label の決まり（種類だけ）に任せる
  const customerUrls = new Set<string>();
  for (let i = 0; i < urls.length; i += 40) {
    const { data } = await sb.from("messages").select("image_url").eq("sender", "customer").in("image_url", urls.slice(i, i + 40));
    for (const d of (data ?? []) as Array<{ image_url: string }>) customerUrls.add(d.image_url);
  }
  const seen = new Set<string>();
  const skip = { have: 0, estimate: 0, test: 0, dup: 0, customer: 0 };
  const cands = rows.filter((r) => {
    if (seen.has(r.image_url)) { skip.dup++; return false; } seen.add(r.image_url);
    if (have.has(r.image_url)) { skip.have++; return false; }
    if (/estimate/i.test(r.source ?? "")) { skip.estimate++; return false; }
    if (isTestConversation(r.conversation_id)) { skip.test++; return false; }
    if (customerUrls.has(r.image_url)) { skip.customer++; return false; }
    return true;
  });
  console.log(`送った資料の画像 ${rows.length}（${DAYS}日）・読む候補 ${cands.length}・飛ばす ${JSON.stringify(skip)}`);
  const todo = cands.slice(0, LIMIT);
  if (DRY) { console.log(`（数えるだけ・読まない。読んで書く時は --apply）対象 ${todo.length}`); return; }

  const t0 = new Date().toISOString();
  const res = { ok: 0, gone: 0, cutoffOrFailed: 0, retried: 0 };
  const written: string[] = [];
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const r = todo[idx++];
      const head = await fetch(r.image_url, { method: "HEAD" }).catch(() => null);
      if (!head?.ok) { res.gone++; continue; }
      let d = await ensureImageDetail(r.image_url, r.conversation_id, { sentAt: r.created_at, timeoutMs: 60_000 });
      if (!d) { res.retried++; d = await ensureImageDetail(r.image_url, r.conversation_id, { sentAt: r.created_at, timeoutMs: 90_000 }); }
      if (d) { res.ok++; written.push(r.image_url); } else res.cutoffOrFailed++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, () => worker()));
  console.log(`\n読めて書いた ${res.ok}・置き場から消えた ${res.gone}・申込以降の線か読めず ${res.cutoffOrFailed}（読み直した ${res.retried}）`);
  console.log(`開始 ${t0}（費用は llm_usage_logs の property_image_* をこの時刻から数える）`);
  // 見本（書いた中身を目で読む）
  const { data } = await sb.from("image_details").select("image_url, kind, lines, model").in("image_url", written.slice(0, 5));
  for (const d of (data ?? []) as Array<{ image_url: string; kind: string; lines: unknown; model: string }>) {
    console.log(`  - ${d.image_url.slice(-30)} ${d.kind} ${d.model} ${(Array.isArray(d.lines) ? (d.lines as string[]) : []).slice(0, 8).join(" ／ ").slice(0, 300)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
