// scripts/backfill-sent-image-facts.ts
// 送った画像1枚ごとの値（sent_image_properties.facts）を過去の行に埋める。既定は件数と費用を数えるだけ（dry-run）。
//
// 2026-09-25 竹内「候補の記憶を太くする」（別の調査の結論「点より先に材料を残す」）:
//   今までの読み取り（readPropertyImage）は家賃・敷金・礼金も読んでいたのに、残るのは sent_properties の家賃だけだった。
//   新しい読み取りは 管理費・間取り・㎡・駅と徒歩・築年月・AD も読み、画像ごとに facts に残す（sent-image-record.ts）。
//   この埋め戻しは過去の行を同じ関数（readPropertyImage → factsFromImageRead）で読み直す。
//
// ■ 決めたこと
//   ・読むのは DeepSeek だけ（readPropertyImage・Claude に切り替えない）。指示の文が先頭・画像が後＝キャッシュが効く形のまま
//   ・読むのは sent_image_properties の行＝こちらが送った物件の資料の画像だけ（見積書・本人確認書類は元から行を作らない）。
//     念のため お客様の画像の置き場（line-images/・customer/）の URL は数えず読まない
//   ・保存期間が終わった画像（売上サポの pickups/ は72時間・property-images は90日）は読めないので数えるだけ
//   ・--apply は YUMA（竹内さんのテスト用の会話）の行だけ。YUMA 以外の本番の行には書かない（件数と費用を報告して止める）
//
// 実行: npx tsx --env-file=.env.local scripts/backfill-sent-image-facts.ts [--days=90]
//       npx tsx --env-file=.env.local scripts/backfill-sent-image-facts.ts --apply --limit=2   （YUMA の行だけ）
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";
import { factsFromImageRead } from "../app/lib/candidate-facts";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "90"), 10);
const LIMIT = parseInt(String(args.limit ?? "2"), 10);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
// deepseek-flash の単価（USD / 100万トークン・scripts/audit-brain-cost-mode.ts と同じ）
const PRICE = { in: 0.15, cacheRead: 0.003, out: 0.6 };

async function all(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}
const isCustomerUpload = (u: string) => /\/line-images\/|\/customer\//.test(u);
const isPickupBlob = (u: string) => /blob\.vercel-storage\.com\/pickups\//.test(u);

async function main() {
  const now = Date.now();
  const since = new Date(now - DAYS * 864e5).toISOString();
  const rows = await all((a, b) => sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no, source, created_at, facts").is("facts", null).gte("created_at", since).order("created_at").range(a, b) as never);
  const cust = rows.filter((r) => isCustomerUpload(String(r.image_url)));
  const expiredPickup = rows.filter((r) => isPickupBlob(String(r.image_url)) && now - Date.parse(r.created_at) > 72 * 3600_000);
  const readable = rows.filter((r) => !isCustomerUpload(String(r.image_url)) && !(isPickupBlob(String(r.image_url)) && now - Date.parse(r.created_at) > 72 * 3600_000));
  // 1枚あたりの実測（直近の property_image_read）
  const logs = await all((a, b) => sb.from("llm_usage_logs").select("input_uncached, cache_read, output_tokens, status").eq("action", "property_image_read").eq("status", 200).order("created_at", { ascending: false }).range(a, Math.min(b, a + 499)) as never);
  const avg = (k: string) => logs.reduce((s, r) => s + (Number(r[k]) || 0), 0) / Math.max(1, logs.length);
  const per = (avg("input_uncached") * PRICE.in + avg("cache_read") * PRICE.cacheRead + avg("output_tokens") * PRICE.out) / 1e6;
  // 項目が増えた分の出力の増え（新しい JSON の項目 7つ ≒ 60トークン）を足して見積もる
  const perNew = per + (60 * PRICE.out) / 1e6;
  console.log(`送った画像の行（facts なし・${since.slice(0, 10)} 以降）: ${rows.length}`);
  console.log(`  お客様の置き場の URL（読まない）: ${cust.length}`);
  console.log(`  売上サポの画像で保存期間（72時間）切れ: ${expiredPickup.length}`);
  console.log(`  読める見込み: ${readable.length}（うち YUMA ${readable.filter((r) => r.conversation_id === YUMA).length}）`);
  console.log(`  1枚の実測（直近 ${logs.length}回の平均）: 入力 ${avg("input_uncached").toFixed(0)}・キャッシュ ${avg("cache_read").toFixed(0)}・出力 ${avg("output_tokens").toFixed(0)} トークン → 約 $${perNew.toFixed(5)}`);
  console.log(`  全部読んだ時の費用の見込み: 約 $${(readable.length * perNew).toFixed(2)}（DeepSeek・deepseek-flash）`);

  if (!args.apply) { console.log("（数えるだけ。YUMA の行で試す時は --apply --limit=N）"); return; }
  // YUMA の行だけ（新しい順に LIMIT 枚）
  const targets = readable.filter((r) => r.conversation_id === YUMA).slice(-LIMIT);
  console.log(`\n【YUMA だけ書く】${targets.length}枚`);
  for (const r of targets) {
    const read = await readPropertyImage(String(r.image_url), { timeoutMs: 80_000 });
    const item = read.items.length === 1 ? read.items[0] : null;
    if (!item) { console.log(`  × 読めない/一覧（items=${read.items.length}）`, String(r.property_name)); continue; }
    const f = factsFromImageRead(item);
    const facts = { ...f, src: "image", model: process.env.PROPERTY_IMAGE_MODEL ?? "deepseek-flash", backfill: true };
    const { error } = await sb.from("sent_image_properties").update({ facts, facts_read_at: new Date().toISOString() }).eq("image_url", r.image_url).eq("conversation_id", YUMA).is("facts", null);
    console.log(error ? `  NG ${error.message}` : `  ○ ${r.property_name} ${r.room_no ?? ""}: ${JSON.stringify(f)}  (tokens in ${read.usage?.input ?? "?"} out ${read.usage?.output ?? "?"})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
