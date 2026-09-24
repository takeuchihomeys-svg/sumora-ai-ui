// 「画像でしか分からない希望」の材料がどこにあるか（読み取りのみ・名前は出さない）
// 条件欄 / お客様の会話 / 物件オススメの訴求点（property_selection_patterns.selling_points）/ AIX 物件オススメの送信文
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const IMG_RE = /水回り|バス.?トイレ|独立洗面|洗面台|洗濯機|室内干し|浴室乾燥|追い焚き|キッチン|対面|カウンター|IH|ガスコンロ|[2二3三]口|収納|WIC|ウォークイン|クローゼット|クロゼット|納戸|リビング|寝室|洋室|和室|間取り|南向き|日当たり|角部屋|[2二]階以上|1階|ロフト|バルコニー|ベランダ|広い|広め|天井|窓|独立|分かれ|分け/;
async function main() {
  const { data: sp } = await sb.from("property_selection_patterns").select("selling_points, selection_label, property_customer_id").not("selling_points", "is", null).order("created_at", { ascending: false }).limit(400);
  const freq = new Map<string, number>();
  for (const r of (sp ?? []) as Array<{ selling_points: unknown }>) for (const s of (Array.isArray(r.selling_points) ? r.selling_points : [])) freq.set(String(s), (freq.get(String(s)) ?? 0) + 1);
  console.log(`selling_points（直近400行）の上位:`, [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}×${v}`).join(" / "));
  const imgPts = [...freq.entries()].filter(([k]) => IMG_RE.test(k));
  console.log(`\nうち画像でしか分からない訴求点: ${imgPts.length}種類 `, imgPts.slice(0, 30).map(([k, v]) => `${k}×${v}`).join(" / "));

  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: msgs } = await sb.from("messages").select("conversation_id, text").eq("sender", "customer").gte("created_at", since).limit(5000);
  const hit = ((msgs ?? []) as Array<{ conversation_id: string; text: string }>).filter((m) => IMG_RE.test(m.text ?? "") && (m.text ?? "").length < 200);
  const convs = new Set(hit.map((m) => m.conversation_id));
  console.log(`\nお客様の発言（30日 ${msgs?.length ?? 0}通）で画像系の語を含む: ${hit.length}通・${convs.size}会話。例（本文は短く・名前なし）:`);
  hit.slice(0, 15).forEach((m) => console.log("  - " + m.text.replace(/\n/g, " ").slice(0, 70)));

  const { data: custs } = await sb.from("property_customers").select("preferences, ng_points, other_requests, additional_conditions").limit(1000);
  const cs = (custs ?? []) as Array<Record<string, string | null>>;
  const withImg = cs.filter((c) => IMG_RE.test([c.preferences, c.ng_points, c.other_requests, c.additional_conditions].filter(Boolean).join(" ")));
  console.log(`\n条件欄に画像系の希望がある物件顧客: ${withImg.length}/${cs.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
