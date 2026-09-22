// こちらが送った画像のうち「どの物件か」の記録が無い物を後から読んで埋める（DeepSeek）
//
// 2026-09-22 竹内（𝓡さん事例）「こっちが送った物件をお客さんが送ってくることもある。判断できるようにする」
//   照合（own-property-match）は、こちらが送った物件の記録が無いと働かない。
//   直近90日のこちらの画像 3,847枚のうち 1,866枚（48%）が記録なし（記録の仕組みができる前の送信）。
//
// ⚠ 書くのは画像ごとの対応表（sent_image_properties）だけ。sent_properties には書かない
//   （送った件数の数え方・物件出しの「一度送った建物を除く」判定に使われるので、古い誤読を混ぜない）。
// ⚠ 照合（会話に出ている物件名に寄せる）を通った物は照合済みの名前、通らない物は読んだ名前（source で区別）
// 実行: npx tsx --env-file=.env.local scripts/backfill-sent-image-properties.ts [--days=90] [--limit=10] [--conc=6] [--dry]
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";
import { resolveReadProperty } from "../app/lib/property-name-match";
import { extractPropertyLabels } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "90")), LIMIT = Number(arg("limit", "10")), CONC = Number(arg("conc", "6"));
const DRY = process.argv.includes("--dry");

async function knownNames(cid: string): Promise<string[]> {
  const known = new Set<string>();
  const { data: sp } = await sb.from("sent_properties").select("property_name").eq("conversation_id", cid).limit(100);
  for (const r of (sp ?? []) as Array<{ property_name: string | null }>) if (r.property_name) known.add(r.property_name.trim());
  const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(200);
  for (const l of extractPropertyLabels(((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n"))) known.add(l.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim());
  return [...known].filter((s) => s.length >= 2);
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const imgs: Array<{ image_url: string; conversation_id: string }> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("messages").select("image_url, conversation_id")
      .eq("sender", "staff").like("image_url", "https://%/property-images/%").gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as typeof imgs; imgs.push(...r); if (r.length < 1000) break;
  }
  const uniq = [...new Map(imgs.filter((x) => !x.image_url.startsWith("[")).map((x) => [x.image_url, x])).values()];
  const recorded = new Set<string>();
  for (let i = 0; i < uniq.length; i += 25) {
    const urls = uniq.slice(i, i + 25).map((x) => x.image_url);
    const [{ data: a }, { data: b }] = await Promise.all([
      sb.from("sent_image_properties").select("image_url").in("image_url", urls),
      sb.from("sent_properties").select("image_url").in("image_url", urls),
    ]);
    for (const r of [...(a ?? []), ...(b ?? [])] as Array<{ image_url: string }>) recorded.add(r.image_url);
  }
  const todo = uniq.filter((x) => !recorded.has(x.image_url)).slice(0, LIMIT);
  console.log(`直近${DAYS}日のこちらの画像 ${uniq.length}枚・記録なし ${uniq.length - recorded.size}枚 → 今回 ${todo.length}枚${DRY ? "（書かない）" : ""}`);

  const knownCache = new Map<string, string[]>();
  let written = 0, matched = 0, notProperty = 0, failed = 0, idx = 0, outTok = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < todo.length) {
      const t = todo[idx++];
      const r = await readPropertyImage(t.image_url, { timeoutMs: 80_000 });
      outTok += r.usage?.output ?? 0;
      if (!r.isProperty || r.items.length === 0) { if (r.raw.startsWith("{")) notProperty++; else failed++; continue; }
      if (!knownCache.has(t.conversation_id)) knownCache.set(t.conversation_id, await knownNames(t.conversation_id));
      const fixed = resolveReadProperty(r.items[0], knownCache.get(t.conversation_id)!);
      const named = fixed ?? r.items[0];
      if (fixed) matched++;
      if (DRY) { console.log(`  ${fixed ? "照合" : "読んだまま"}: ${named.propertyName} ${named.roomNumber}`); continue; }
      const { error } = await sb.from("sent_image_properties").upsert(
        { image_url: t.image_url, conversation_id: t.conversation_id, property_name: named.propertyName, room_no: named.roomNumber || null, source: fixed ? "backfill_matched" : "backfill_vision" },
        { onConflict: "image_url", ignoreDuplicates: true },
      );
      if (!error) written++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));
  console.log(`\n書いた ${written} ／ うち照合済み ${matched} ／ 物件資料でない（見積書等） ${notProperty} ／ 読めず ${failed}`);
  console.log(`${Math.round((Date.now() - t0) / 1000)}秒・出力 ${outTok} トークン（約 $${((outTok / 1e6) * 0.42).toFixed(3)}＋入力わずか）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
