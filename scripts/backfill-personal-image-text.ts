// 実行: npx tsx --env-file=.env.local scripts/backfill-personal-image-text.ts [--apply]
// 2026-10-01 竹内「①だけ行う」: 過去のお客様の画像のうち、個人情報（免許証・保険証の裏・保証会社の申込書・資格確認書 等）の書き起こしが
//   全文のまま残っていた12行を、新しく届く画像と同じ関数（id-document-guard.ts imageTextForSave / imageTypeForSave）で書類名だけにする。
//   --apply なしは確かめるだけ（何に変わるかを出す・書かない）。書類にならない行は書き換えない
import { createClient } from "@supabase/supabase-js";
import { imageTextForSave, imageTypeForSave } from "../app/lib/id-document-guard";

const IDS = ["60955d16-14f3-4351-ba93-e9553c27e8a6","92c48102-2cc4-4afe-9910-6c6b7b0ac8b8","fcd8b36b-e88e-4e2a-a690-dbdb344f457c","4d2b674b-cb3a-436d-b5ee-c94d4157c96e","6a0c7733-1187-4816-bba3-f0589e159ae2","cbf0e2ac-eb94-4dc9-aee0-875569a13034","a53f7c58-0534-4856-9dc4-88ab0d5ac029","4332f29c-71bb-458d-b93f-962726de32fd","f838a4d9-5b84-4447-818f-32fecf1ce47e","39548027-e872-4a26-91fe-e097d764f394","058d6dd0-fbc1-4d0c-9284-efa8b9fb547f","1719533d-bf3f-422d-a7bc-485ec75055a3"];

async function main() {
  const apply = process.argv.includes("--apply");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
  const { data, error } = await sb.from("messages").select("id, sender, text, image_type, created_at")
    .eq("sender", "customer").in("id", IDS);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ id: string; sender: string; text: string | null; image_type: string | null; created_at: string }>)
    ;
  console.log("見つかった行:", rows.length, "/", IDS.length);
  let changed = 0;
  for (const r of rows) {
    const content = String(r.text ?? "").replace(/^\[画像\]\s*/, "");
    const newText = imageTextForSave(r.image_type, content);
    const newType = imageTypeForSave(r.image_type, content);
    // 書類名だけ（「[画像] 本人確認書類」「[画像] 申込書」等・1行で短い）になる物だけを書き換える
    const isDocOnly = !newText.includes("\n") && newText.length <= 40;
    console.log(`${r.id.slice(0, 8)} ${r.created_at.slice(0, 10)} ${r.image_type ?? "-"} → ${newType}  「${newText}」 ${isDocOnly ? "" : "（書類にならない＝書き換えない）"}`);
    if (!isDocOnly || (newText === r.text && newType === r.image_type)) continue;
    if (apply) {
      const { error: e } = await sb.from("messages").update({ text: newText, image_type: newType }).eq("id", r.id);
      if (e) { console.error("  失敗:", e.message); continue; }
    }
    changed++;
  }
  console.log(apply ? `書き換えた: ${changed}行` : `書き換える予定: ${changed}行（--apply で実行）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
