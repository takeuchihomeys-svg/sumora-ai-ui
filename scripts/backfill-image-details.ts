// こちらが送った画像の「中身」を後から読んで image_details に残す（2026-09-21）
//
// 竹内「引用とあれば引用先の画像を読み取れるように」
//   これから送る画像は send-line-message が送信時に読む。**既に送ってある画像**はここで埋める。
//   優先順: ①既にお客様が引用した画像（今まさに文を作る場面） ②直近に送った画像（これから引用される）
//
// 実行: npx tsx --env-file=.env.local scripts/backfill-image-details.ts [--days=5] [--limit=60] [--conc=5]
import { createClient } from "@supabase/supabase-js";
import { readPropertyImageDetail } from "../app/lib/property-image-read";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "5"));
const LIMIT = Number(arg("limit", "60"));
const CONC = Number(arg("conc", "5"));

type Row = { image_url: string; conversation_id: string; created_at: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  // ① 引用された画像（お客様が既に指している）
  const { data: quotes } = await sb.from("messages")
    .select("quoted_message_id, conversation_id, created_at")
    .eq("sender", "customer").not("quoted_message_id", "is", null)
    .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(300);
  const qids = [...new Set(((quotes ?? []) as Array<{ quoted_message_id: string }>).map((r) => r.quoted_message_id))];
  const quoted: Row[] = [];
  for (let i = 0; i < qids.length; i += 100) {
    const { data } = await sb.from("messages")
      .select("image_url, conversation_id, created_at, sender, text").in("line_message_id", qids.slice(i, i + 100));
    for (const r of (data ?? []) as Array<Row & { sender: string; text: string | null }>) {
      if (r.sender === "staff" && r.image_url) quoted.push({ image_url: r.image_url, conversation_id: r.conversation_id, created_at: r.created_at });
    }
  }
  // ② 直近に送った画像
  const recent: Row[] = [];
  for (let p = 0; p < 10; p++) {
    const { data, error } = await sb.from("messages")
      .select("image_url, conversation_id, created_at").eq("sender", "staff").not("image_url", "is", null)
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as Row[]; recent.push(...r); if (r.length < 1000) break;
  }
  const seen = new Set<string>();
  const targets = [...quoted, ...recent].filter((r) => { if (seen.has(r.image_url)) return false; seen.add(r.image_url); return true; });

  // 既に読んである物は飛ばす
  const done = new Set<string>();
  const urls = targets.map((t) => t.image_url);
  for (let i = 0; i < urls.length; i += 20) {
    const { data } = await sb.from("image_details").select("image_url").in("image_url", urls.slice(i, i + 20));
    for (const r of (data ?? []) as Array<{ image_url: string }>) done.add(r.image_url);
  }
  const todo = targets.filter((t) => !done.has(t.image_url)).slice(0, LIMIT);
  console.log(`引用された画像 ${quoted.length} ／ 直近${DAYS}日の送信画像 ${recent.length} ／ 読む対象 ${todo.length}（読み済み ${done.size}）`);

  let ok = 0, estimate = 0, failed = 0, inTok = 0, outTok = 0;
  const t0 = Date.now();
  let idx = 0;
  async function worker(w: number) {
    while (idx < todo.length) {
      const my = idx++;
      const t = todo[my];
      const r = await readPropertyImageDetail(t.image_url, { timeoutMs: 90_000 });
      inTok += r.usage?.input ?? 0; outTok += r.usage?.output ?? 0;
      if (r.kind === "other" && r.lines.length === 0) { failed++; console.log(`  [${w}] ${my + 1}/${todo.length} ✗ 読めず ${r.raw.slice(0, 60)}`); continue; }
      if (r.kind !== "property") estimate++; else ok++;
      const { error } = await sb.from("image_details").upsert(
        { image_url: t.image_url, conversation_id: t.conversation_id, kind: r.kind, lines: r.lines, model: "deepseek-flash" },
        { onConflict: "image_url" },
      );
      console.log(`  [${w}] ${my + 1}/${todo.length} ${r.kind} 行=${r.lines.length}${error ? ` ⚠ ${error.message}` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, (_, i) => worker(i + 1)));
  const cost = (inTok / 1e6) * 0.28 + (outTok / 1e6) * 0.42;
  console.log(`\n資料として読めた ${ok} ／ 見積書など ${estimate} ／ 読めず ${failed}`);
  console.log(`${Math.round((Date.now() - t0) / 1000)}秒・入力${inTok} 出力${outTok}・約$${cost.toFixed(3)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
