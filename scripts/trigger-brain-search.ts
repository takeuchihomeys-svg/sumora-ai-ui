// scripts/trigger-brain-search.ts
// ブレインの自動検索を1件積む（竹内さん「もともとの拡張ツールの検索を行えばよいだけ。自動での検索。APIで」）。
//
// 何をするか（/api/automation/trigger の brain:true と同じ形を DB に直接積む）:
//   automation_commands に batch_property_search を1行入れる
//     payload: { source: "web_brain", is_wide: false, rp_update_days, itandi_update_days, search_override? }
//     sites:   ["realnetpro", "itandi"]（両方。片方だけなら --site=realnetpro）
//   拾うのは拡張のブレインが ON の PC（/api/automation/pending?brain=1）。
//   拡張は検索して、1件ずつ印刷用PDFを押して売上番長へ送る（v2.6.32 以降）。
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/trigger-brain-search.ts --customer=<property_customers.id>
//   npx tsx --env-file=.env.local scripts/trigger-brain-search.ts --name=じゅな      # 名前で探す
//   npx tsx --env-file=.env.local scripts/trigger-brain-search.ts --name=じゅな --dry
//
// 決まり（守る事）:
//   ・認証情報はハードコード禁止（.env.local から読む）
//   ・自動の止めの印（automation_settings.paused）が立っていたら積まない
//   ・同じお客様の未実行・実行中があれば積まない（二重に走らせない）
//   ・--dry で「何を積むか」だけ出す（DB に書かない）

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);

function arg(key: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : null;
}
const dry = process.argv.includes("--dry");
const siteArg = arg("site");
const SITES = siteArg ? [siteArg] : ["realnetpro", "itandi"];

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    console.error("NEXT_PUBLIC_SUPABASE_URL がありません（--env-file=.env.local を付けて実行してください）");
    process.exit(1);
  }

  // ① お客様を決める（id か名前）
  type CustomerRow = { id: string; customer_name: string | null; desired_area: string | null; area_mode: string | null };
  const id = arg("customer");
  const name = arg("name");
  let customer: CustomerRow | null = null;
  if (id) {
    const { data, error } = await sb.from("property_customers")
      .select("id, customer_name, desired_area, area_mode").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    customer = data as CustomerRow | null;
  } else if (name) {
    const { data, error } = await sb.from("property_customers")
      .select("id, customer_name, desired_area, area_mode").ilike("customer_name", `%${name}%`).limit(5);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as CustomerRow[];
    if (!rows.length) { console.error(`「${name}」さんが見つかりません`); process.exit(1); }
    if (rows.length > 1) {
      console.error(`「${name}」さんが ${rows.length} 人います。--customer=<id> で指定してください:`);
      rows.forEach((r) => console.error(`  ${r.customer_name}  ${r.id}  ${r.desired_area ?? ""}`));
      process.exit(1);
    }
    customer = rows[0];
  } else {
    console.error("--customer=<id> か --name=<名前> を付けてください");
    process.exit(1);
  }
  if (!customer) { console.error("お客様が見つかりません"); process.exit(1); }

  // ② 止めの印（automation_settings.paused）
  const { data: st } = await sb.from("automation_settings").select("paused").eq("id", 1).maybeSingle();
  const paused = !!(st as { paused?: boolean } | null)?.paused;

  // ③ 同じお客様の未実行・実行中
  const { data: open } = await sb.from("automation_commands")
    .select("id, status, sites, payload")
    .in("status", ["pending", "running"])
    .contains("customer_ids", [customer.id])
    .limit(3);

  console.log("── 積む内容 ──");
  console.log("お客様:", customer.customer_name, customer.id);
  console.log("エリア:", customer.desired_area, `(${customer.area_mode ?? "-"})`);
  console.log("サイト:", SITES.join(" + "));
  console.log("止めの印(paused):", paused);
  console.log("同じお客様の未実行:", (open ?? []).length, (open ?? []).map((r) => r.status).join(","));

  if (paused) { console.error("\n⚠ 自動の物件検索は一時停止中です（automation_settings.paused）→ 積みません"); process.exit(2); }
  if ((open ?? []).length) { console.error("\n同じお客様の検索がまだ終わっていません（終わってから）"); process.exit(0); }
  if (dry) { console.log("\n--dry なので書きません"); return; }

  // ④ 積む（/api/automation/trigger の queueWebBrain と同じ形）
  const nowMs = Date.now();
  const { data: pc } = await sb.from("property_customers")
    .select("rp_update_days, itandi_update_days").eq("id", customer.id).maybeSingle();
  const rpDays = (pc as { rp_update_days?: number | null } | null)?.rp_update_days ?? null;
  const itandiDays = (pc as { itandi_update_days?: number | null } | null)?.itandi_update_days ?? null;

  const { data, error } = await sb.from("automation_commands").insert({
    command_type: "batch_property_search",
    customer_ids: [customer.id],
    sites: SITES,
    payload: {
      source: "web_brain",
      is_wide: false,
      rp_update_days: rpDays,
      itandi_update_days: itandiDays,
      requested_at: new Date(nowMs).toISOString(),
    },
    status: "pending",
  }).select("id").single();
  if (error) throw new Error(error.message);

  console.log("\n✅ 積みました:", (data as { id: string }).id);
  console.log("ブレインが ON の PC（拡張のヘッダーが「ブレイン」）が拾って検索し、印刷用PDFを1件ずつ押して売上番長へ送ります。");
}

main().catch((e) => { console.error("失敗:", e instanceof Error ? e.message : e); process.exit(1); });
