// scripts/fix-owner-approved-1006.ts — 竹内さんが 10/06 に直してよいとした2人の条件を直す（既定は見るだけ・--apply で書く）
// 実行: npx tsx --env-file=.env.local scripts/fix-owner-approved-1006.ts [--apply]
//   R:   「区なおして良い」→ 希望エリアを足す形（元の忍ヶ丘駅周辺＋旭区・都島区・城東区・阿倍野区・今里）。浪速区は 10/04 にスタッフが画面で入れた物で、
//        10/04 以降のお客様の発言に浪速区の依頼は無い（物件のリンク・見積・入居可能日・エアコン・お礼・検討します）
//   ゆいと: 「ゆいとさん物件 ゆいとさん物置 と2つに分ける」→ 住まい（親）から物置の節と帯の行を外し、子「ゆいと（物置）」を作る
//        （住まいの家賃の上限 9万は 10/04 にスタッフが戻し済み。子は 9/23「仕事用…茨木、豊中」＋9/24「家賃2万以下…物置として使いたい」）
//   どちらも条件の履歴（property_condition_history）に書き手 screen_edit で残す（竹内さんの判断で直した）
import { createClient } from "@supabase/supabase-js";
import { recordConditionHistory } from "../app/lib/condition-history";

const apply = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const R_PC = "80545aaf-775f-4eee-873e-c5c6f87fcb75";
const R_AREA = "忍ヶ丘駅周辺（車で30~40分圏内）・今里・大阪市都島区・大阪市城東区・大阪市阿倍野区・大阪市旭区";
const Y_PC = "23f2f823-bfcb-430e-b0f1-48c8daf0a9e7";

async function main() {
  // ── R ──
  const { data: r } = await sb.from("property_customers").select("desired_area, area_mode").eq("id", R_PC).single();
  console.log("R 今:", r, "→", { desired_area: R_AREA, area_mode: "ward" });
  if (apply && r && r.desired_area !== R_AREA) {
    const { error } = await sb.from("property_customers").update({ desired_area: R_AREA, area_mode: "ward", updated_at: new Date().toISOString() }).eq("id", R_PC);
    if (error) throw new Error(error.message);
    await recordConditionHistory(sb, R_PC, r as Record<string, unknown>, { desired_area: R_AREA }, "screen_edit");
    console.log("R: 直した");
  }
  // ── ゆいと ──
  const { data: y } = await sb.from("property_customers").select("customer_name, status, account, assignee, rent_max, other_requests, additional_conditions").eq("id", Y_PC).single();
  if (!y) throw new Error("ゆいとの行が無い");
  const other = String(y.other_requests ?? "").split("・").map((x) => x.trim()).filter((x) => x && !/物置/.test(x)).join("・") || null;
  const add = String(y.additional_conditions ?? "").split("\n").filter((l) => !/物置として使いたい|家賃: 〜2万/.test(l)).join("\n").trim() || null;
  const kidLine = `[10/6 ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16)}|auto] 別の探し物「物置」として分けました（ゆいと（物置））・家賃〜2万`;
  const parentUpd = { other_requests: other, additional_conditions: add ? `${add}\n${kidLine}` : kidLine };
  console.log("ゆいと（住まい）今:", { rent_max: y.rent_max, other_requests: y.other_requests, additional_conditions: y.additional_conditions }, "→", parentUpd);
  const { data: kids } = await sb.from("property_customers").select("id, customer_name").eq("parent_customer_id", Y_PC);
  const child = {
    customer_name: "ゆいと（物置）", profile_label: "物置", parent_customer_id: Y_PC,
    status: (y.status as string | null) ?? "hot", account: y.account ?? null, assignee: y.assignee ?? null,
    desired_area: "茨木・豊中", rent_max: 20000,
    other_requests: "仕事用で家賃安ければ安いほどいい・物置として使いたい",
  };
  console.log("ゆいと（物置）:", kids?.length ? `既にある ${JSON.stringify(kids)}` : child);
  if (apply) {
    const { error } = await sb.from("property_customers").update({ ...parentUpd, updated_at: new Date().toISOString() }).eq("id", Y_PC);
    if (error) throw new Error(error.message);
    await recordConditionHistory(sb, Y_PC, y as Record<string, unknown>, { other_requests: other }, "screen_edit");
    if (!kids?.length) {
      const { data: ins, error: e2 } = await sb.from("property_customers").insert(child).select("id").single();
      if (e2 || !ins) throw new Error(e2?.message ?? "作れない");
      await recordConditionHistory(sb, String(ins.id), {}, child, "screen_edit");
      console.log("ゆいと（物置）を作った:", ins.id);
    }
    console.log("ゆいと: 直した");
  } else console.log("\n（見るだけ。書く時は --apply）");
}
main().catch((e) => { console.error(e); process.exit(1); });
