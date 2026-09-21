// 送る直前の関門（個人／グループの取り違え・送信停止の会話）が本番の送信経路で効くか（YUMA）
//
// 2026-09-21 竹内「LINEのグループにおくるはずが個人のLINEにおくらないように。グループに送るときはグループに送る」
//
// ⚠ 関門が効かなかった時に**誤って届いても害の無い宛先だけ**で試す:
//   ① 送信停止の会話 … YUMA（竹内さん本人のテスト用）に一時的に印を付けて送る → 止まるはず
//                      （止まらなければ YUMA に「テスト」が届くだけ）
//   ② 宛先の取り違え … YUMA の会話から**実在しない形だけのグループID**へ送る → 止まるはず
//                      （止まらなければ LINE が宛先不明で弾くだけ）
//   黒明さんの個人 ID には一切送らない。
// 実行: npx tsx --env-file=.env.local scripts/yuma-send-target-test.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const FAKE_GROUP = "C00000000000000000000000000000000";

async function send(to: string, conversationId: string) {
  const res = await fetch(`${BASE}/api/send-line-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INTERNAL_API_SECRET ?? ""}` },
    body: JSON.stringify({ line_user_id: to, message: "（送信の関門テスト）", conversation_id: conversationId, origin: "manual" }),
  });
  const j = await res.json().catch(() => ({})) as { ok?: boolean; errorCode?: string; error?: string };
  return { status: res.status, ...j };
}

async function main() {
  const { data: conv } = await sb.from("conversations").select("line_user_id, send_blocked_reason").eq("id", YUMA).maybeSingle();
  const yumaTo = String((conv as { line_user_id?: string } | null)?.line_user_id ?? "");
  if (!yumaTo) { console.log("YUMA の宛先が読めない"); return; }
  const results: Array<[string, boolean]> = [];

  // ① 送信停止の印
  await sb.from("conversations").update({ send_blocked_reason: "created_from_group" }).eq("id", YUMA);
  try {
    const r = await send(yumaTo, YUMA);
    console.log(`① 送信停止の会話 → HTTP ${r.status} ${r.errorCode ?? ""}\n   ${r.error ?? ""}`);
    results.push(["① 送信停止の会話から送ろうとしたら止まる", r.status === 409 && r.errorCode === "send_blocked"]);
  } finally {
    await sb.from("conversations").update({ send_blocked_reason: null }).eq("id", YUMA);
  }

  // ② 宛先の取り違え（個人の会話からグループへ）
  const r2 = await send(FAKE_GROUP, YUMA);
  console.log(`② 個人の会話からグループへ → HTTP ${r2.status} ${r2.errorCode ?? ""}\n   ${r2.error ?? ""}`);
  results.push(["② 個人の会話からグループIDへ送ろうとしたら止まる", r2.status === 409 && r2.errorCode === "target_mismatch"]);

  const { data: after } = await sb.from("conversations").select("send_blocked_reason").eq("id", YUMA).maybeSingle();
  console.log(`\n=== まとめ ===`);
  for (const [name, ok] of results) console.log(`   ${ok ? "✅" : "⚠"} ${name}`);
  console.log(`   YUMA の印を戻した: ${(after as { send_blocked_reason?: string | null } | null)?.send_blocked_reason ? "⚠ 残っている" : "✅"}`);
}
main().catch(async (e) => {
  await sb.from("conversations").update({ send_blocked_reason: null }).eq("id", YUMA);
  console.error(e); process.exit(1);
});
