// ① 材料は本当に溜まるのか ② 渡したら文は変わるのか（YUMA・書き込みあり）
//
// 2026-09-20 竹内「これは次からちゃんとできるってことかな？ ちゃんと生成されるのか
//   実際送ってる AIX の物件ピックアップの文のように送られるのか テストして確認」
//
// ⚠ 書き込みを伴うので**テスト用の会話 YUMA だけ**で動かす（竹内さんの本人アカウント）。
//   入れた行は最後に消す（後片付けまでやる）。LINE へは何も送らない。
//
// 検証する経路（2026-09-20 に入れたもの）:
//   log-aix-usage が property_names / prop_statuses を受け取ったら sent_properties に書く
//   （prop_statuses の "vacating" → recruitment_status="move_out_planned" ＝ 退去予定がデータで残る）
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const MARK = "ZZテスト物件"; // 後で消すための目印（実在しない名前）

async function main() {
  console.log(`=== ① 材料は溜まるか（log-aix-usage → sent_properties）===\n`);

  const before = await sb.from("sent_properties").select("id, property_name, room_no, recruitment_status, source")
    .eq("conversation_id", YUMA).like("property_name", `${MARK}%`);
  console.log(`   実行前の目印つきの行: ${(before.data ?? []).length}件（0のはず）`);

  // 画面が AIX を押した後に呼ぶのと同じ形。退去予定（vacating）を1件混ぜる
  const body = {
    conversation_id: YUMA,
    aix_type: "property_send",
    conversation_status: "proposing",
    property_names: [`${MARK}A 403号室`, `${MARK}B 1005号室`],
    prop_statuses: ["available", "vacating"],
    generated_text: "（テスト）物件ピックアップの記録テスト",
  };
  const res = await fetch(`${BASE}/api/log-aix-usage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  console.log(`   log-aix-usage: ${res.status} ${JSON.stringify(json)?.slice(0, 120)}`);

  // waitUntil（バックグラウンド）で書かれるので少し待つ
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const { data } = await sb.from("sent_properties")
      .select("id, property_name, room_no, recruitment_status, source, sent_at")
      .eq("conversation_id", YUMA).like("property_name", `${MARK}%`);
    if ((data ?? []).length > 0) {
      console.log(`\n   ✅ sent_properties に入った（${((i + 1) * 1.5).toFixed(1)}秒後）:`);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        console.log(`      ${r.property_name} / 号室 ${r.room_no} / 募集状況 ${r.recruitment_status ?? "(null)"} / source ${r.source}`);
      }
      const moveOut = (data ?? []).filter((r) => (r as Record<string, unknown>).recruitment_status === "move_out_planned");
      console.log(`\n   退去予定（move_out_planned）として残った: ${moveOut.length}件`);
      console.log(`   → 竹内「文生成される部分毎回直さなくて済む（退去予定物件の部分等）」の材料が入った`);

      // ② 重複の判定が効くか（同じ物件をもう一度送ったことにする）
      console.log(`\n=== ② 同じ物件をもう一度送ったら重複として弾くか ===`);
      const res2 = await fetch(`${BASE}/api/log-aix-usage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, generated_text: "（テスト）2回目" }),
      });
      console.log(`   log-aix-usage(2回目): ${res2.status}`);
      await new Promise((r) => setTimeout(r, 6000));
      const { data: after2 } = await sb.from("sent_properties").select("id")
        .eq("conversation_id", YUMA).like("property_name", `${MARK}%`);
      console.log(`   2回目の後の行数: ${(after2 ?? []).length}件（2件のままなら重複を弾けている）`);

      // ③ 重複チェック API（Chrome 拡張・画面が使う）が同じ線で答えるか
      console.log(`\n=== ③ 重複チェック API が同じ物件を「既に送った」と答えるか ===`);
      const q = new URLSearchParams({ property_name: `${MARK}A`, room_no: "403", conversation_id: YUMA });
      const res3 = await fetch(`${BASE}/api/check-property-duplicate?${q}`);
      const j3 = await res3.json().catch(() => null) as Record<string, unknown> | null;
      console.log(`   同じ物件・同じ号室: is_duplicate=${j3?.is_duplicate} （true が正しい）`);
      const q2 = new URLSearchParams({ property_name: "全然ちがう物件", room_no: "403", conversation_id: YUMA });
      const res4 = await fetch(`${BASE}/api/check-property-duplicate?${q2}`);
      const j4 = await res4.json().catch(() => null) as Record<string, unknown> | null;
      console.log(`   別物件・同じ号室    : is_duplicate=${j4?.is_duplicate} （false が正しい＝旧実装は true だった）`);

      // 後片付け
      const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
      const { data: all } = await sb.from("sent_properties").select("id").eq("conversation_id", YUMA).like("property_name", `${MARK}%`);
      const allIds = ((all ?? []) as Array<{ id: string }>).map((r) => r.id);
      await sb.from("sent_properties").delete().in("id", allIds.length ? allIds : ids);
      await sb.from("aix_usage_logs").delete().eq("conversation_id", YUMA).eq("generated_text", "（テスト）物件ピックアップの記録テスト");
      await sb.from("aix_usage_logs").delete().eq("conversation_id", YUMA).eq("generated_text", "（テスト）2回目");
      const { data: left } = await sb.from("sent_properties").select("id").eq("conversation_id", YUMA).like("property_name", `${MARK}%`);
      console.log(`\n   後片付け: 残った目印つきの行 ${(left ?? []).length}件（0なら片付いた）`);
      return;
    }
  }
  console.log(`\n   ❌ 18秒待っても sent_properties に入らなかった（経路が動いていない）`);
  await sb.from("aix_usage_logs").delete().eq("conversation_id", YUMA).eq("generated_text", "（テスト）物件ピックアップの記録テスト");
}
main().catch((e) => { console.error(e); process.exit(1); });
