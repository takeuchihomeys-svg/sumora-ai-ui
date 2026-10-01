// scripts/audit-image-label.ts — お客様の画像の見出し（image-label.ts）を過去の画像に当てて、前後を目で読む（読むだけ・DB は書かない）
// 2026-10-01 竹内「送られてきた画像が物件なのか、物件以外なのか分かるためにも、画像分析したのを今ある本人確認書類のように文字に出しといたら、文やAIXでの判断の質が上がる」
//
// 実行: npx tsx --env-file=.env.local scripts/audit-image-label.ts [--since=2026-05-01] [--sample=6] [--kind=unknown] [--full]
//   ・Vision の分類 × 新しい見出しの表
//   ・個人情報で書き起こしを捨てるようになる行（今は全文が残っている行＝埋め戻しの候補）
//   ・物件と分類された画像（floor_plan / property_photo / estimate）が物件以外・書類になった行（誤爆の確認・0件であること）
//   ・見出しごとの前後の見本
import { createClient } from "@supabase/supabase-js";
import { imageTextForSave, imageTypeForSave, ID_DOCUMENT_TEXT } from "@/app/lib/id-document-guard";
import { savedPersonalDocumentLabel } from "@/app/lib/personal-document-guard";
import { savedImageKind, imageKindGroup, IMAGE_KIND_LABEL, type ImageKind } from "@/app/lib/image-label";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = arg("since", "2026-05-01");
const sample = Number(arg("sample", "6"));
const onlyKind = arg("kind");
const full = process.argv.includes("--full");

type Row = { id: string; conversation_id: string; created_at: string; text: string; image_type: string | null };

/** 保存し直した後の本文の種類（見出し・書類の名前） */
function afterKey(text: string): string {
  if (text === "[画像]") return "（空のまま）";
  if (text === ID_DOCUMENT_TEXT) return "本人確認書類";
  const doc = savedPersonalDocumentLabel(text);
  if (doc) return `書類:${doc}`;
  const k = savedImageKind(text);
  return k ? IMAGE_KIND_LABEL[k] : "（見出しなし）";
}

async function main() {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, text, image_type")
      .eq("sender", "customer").like("text", "[画像]%").gte("created_at", since).order("created_at").range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  console.log(`=== お客様の画像 ${rows.length}件（${since}〜） ===`);

  const table = new Map<string, Map<string, number>>();
  const byKey = new Map<string, { r: Row; after: string }[]>();
  const privacy: { r: Row; after: string }[] = [];
  const misfire: { r: Row; after: string }[] = [];
  const typeChanged: { r: Row; newType: string }[] = [];
  let alreadyLabeled = 0;

  for (const r of rows) {
    // 保存済みの書類の名前（本人確認書類・収入証明書（…）・申込書）はそのまま（中身はもう無い）
    if (r.text === ID_DOCUMENT_TEXT || savedPersonalDocumentLabel(r.text) || savedImageKind(r.text)) { alreadyLabeled++; continue; }
    const body = r.text.replace(/^\[画像\]\s*/, "");
    const after = imageTextForSave(r.image_type, body);
    const newType = imageTypeForSave(r.image_type, body);
    const key = afterKey(after);
    const vt = r.image_type ?? "NULL";
    if (!table.has(vt)) table.set(vt, new Map());
    table.get(vt)!.set(key, (table.get(vt)!.get(key) ?? 0) + 1);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ r, after });
    if ((r.image_type ?? "") !== newType && newType) typeChanged.push({ r, newType });
    // 個人情報: 今は全文が残っていて、新しい形では書類の名前だけ／書き起こしを捨てる
    const dropsTranscript = after === ID_DOCUMENT_TEXT || !!savedPersonalDocumentLabel(after) || savedImageKind(after) === "pet_document";
    if (dropsTranscript && body.trim()) privacy.push({ r, after });
    // 誤爆: Vision が物件・見積書と分けた画像が、物件以外・書類・種類不明になった
    if (["floor_plan", "property_photo", "estimate"].includes(r.image_type ?? "")) {
      const k = savedImageKind(after);
      const g = k ? imageKindGroup(k as ImageKind) : null;
      if (dropsTranscript || g === "non_property" || g === "unknown") misfire.push({ r, after });
    }
  }
  console.log(`（保存済みの見出し・書類の名前 ${alreadyLabeled}件は対象外）\n`);

  console.log("■ Vision の分類 × 新しい見出し");
  for (const [vt, m] of [...table.entries()].sort((a, b) => b[1].size - a[1].size)) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${vt}（${total}）: ${[...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" ／ ")}`);
  }
  const totals = new Map<string, number>();
  for (const [k, v] of byKey) totals.set(k, v.length);
  console.log(`\n■ 見出しごとの件数: ${[...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" ／ ")}`);

  console.log(`\n■ 個人情報: 書き起こしを捨てるようになる行（今は全文が残っている）${privacy.length}件`);
  for (const { r, after } of privacy) {
    console.log(`  ${r.created_at.slice(0, 10)} ${r.id.slice(0, 8)} [${r.image_type ?? "NULL"}] → ${after}  ｜旧: ${JSON.stringify(r.text.slice(0, 70))}`);
  }

  console.log(`\n■ 誤爆の確認: 物件・見積書の分類が物件以外／書類／種類不明になった行 ${misfire.length}件`);
  for (const { r, after } of misfire) console.log(`  ${r.id.slice(0, 8)} [${r.image_type}] → ${after.split("\n")[0]}  ｜${JSON.stringify(r.text.slice(0, 90))}`);

  console.log(`\n■ image_type が変わる行 ${typeChanged.length}件`);
  for (const { r, newType } of typeChanged) console.log(`  ${r.id.slice(0, 8)} ${r.image_type ?? "NULL"} → ${newType}  ｜${JSON.stringify(r.text.slice(0, 60))}`);

  console.log("\n■ 見出しごとの前後の見本");
  for (const [key, list] of [...byKey.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (onlyKind && !key.includes(onlyKind)) continue;
    if (key === "（空のまま）") continue;
    console.log(`\n--- ${key}（${list.length}） ---`);
    const pick = full ? list : list.filter((_, i) => i % Math.max(1, Math.floor(list.length / sample)) === 0).slice(0, sample);
    for (const { r, after } of pick) {
      console.log(`  ${r.id.slice(0, 8)} [${r.image_type ?? "NULL"}]`);
      console.log(`    前: ${JSON.stringify(r.text.slice(0, 110))}`);
      console.log(`    後: ${JSON.stringify(after.slice(0, 110))}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
