// scripts/fix-personal-image-text-stored.ts — 保存済みのお客様の画像の書き起こしのうち、今の個人情報の網に当たる物を見出しだけに書き直す（既定は数えるだけ・LLM なし・$0）
//
// 2026-10-15 竹内さん「書き直す」: 入口の網（id-document-guard.ts imageTextForSave / image-label.ts personalHintIn・本人確認書類・保険・重説・
//   手続きの画面・登記の写し・振込人・会員 ID 等）は新しく届く画像にしか効かない。網を足す前に保存された行は messages.text に全文が残り、
//   返信の生成・ブレイン（LLM）にそのまま渡っていた。新しく届く画像と同じ関数で作り直し、**書き起こしを捨てる結果になる行だけ**を書き直す。
//   ・お客様の行（sender=customer）だけ。スタッフの画像は触らない
//   ・作り直しても書き起こしが残る行（物件の資料・画面・写真・見積書・ペット/人物の写真 等）は触らない（＝今の本文のまま）
//   ・保存済みの見出しが物件・見積書の行は既定で触らない（見本で 0件を確かめる・--include-property で外せる）
// 実行: npx tsx --env-file=.env.local scripts/fix-personal-image-text-stored.ts [--show=20] [--apply]
//   --show は id の頭8桁と見出しの前後だけを出す（中身は出さない）。--apply は親（承認の後）が流す
import { createClient } from "@supabase/supabase-js";
import { imageTextForSave, imageTypeForSave } from "../app/lib/id-document-guard";
import { savedImageKind, stripImageLabel, imageKindGroup } from "../app/lib/image-label";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.argv.includes("--apply");
const INCLUDE_PROPERTY = process.argv.includes("--include-property");
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=0").split("=")[1]);
// 確かめる人が見つけた行（全期間の数に含まれる事を確かめる）
const KNOWN = ["d1d2bb1f", "4fde147b", "9f5fdba7", "2321d918", "1b397935", "2b64a778", "a6c0ee46", "7e670a1d"];

type Row = { id: string; sender: string | null; text: string | null; image_type: string | null; created_at: string };

/** 書き直した後の本文（書き直さないなら null） */
export function rewriteOf(r: Pick<Row, "text" | "image_type">): { text: string; type: string; oldHead: string; newHead: string } | null {
  const text = String(r.text ?? "");
  if (!/^\s*\[画像\]/.test(text)) return null;
  const body = text.replace(/^\s*\[画像\]\s*/, "");
  const content = stripImageLabel(body).trim();
  if (!content) return null; // 書き起こしが無い（見出しだけ・読み取り前）
  // 既に書類の名前だけ（「[画像] 本人確認書類」「[画像] 収入証明書（給与明細）」）＝書き起こしは残っていない
  if (!body.includes("\n") && body.length <= 40 && !/[:：]/.test(body)) return null;
  const newText = imageTextForSave(r.image_type, content);
  if (newText.includes("\n")) return null; // 作り直しても書き起こしが残る＝個人情報の網に当たらない
  if (newText === text.trim()) return null;
  const kind = savedImageKind(text);
  const oldHead = kind ? `【${kind}】` : `（見出しなし:${r.image_type ?? "-"}）`;
  return { text: newText, type: imageTypeForSave(r.image_type, content), oldHead, newHead: newText.replace(/^\[画像\]\s*/, "") };
}

async function main() {
  const rows: Row[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("id, sender, text, image_type, created_at").like("text", "[画像]%").order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const customer = rows.filter((r) => r.sender === "customer");
  const others = rows.filter((r) => r.sender !== "customer");
  console.log(`画像の行: 全 ${rows.length}（お客様 ${customer.length}・それ以外 ${others.length}）`);

  // スタッフ・その他の画像に網が当たる数（参考・書き直さない）
  const otherHits = others.filter((r) => rewriteOf(r)).length;
  console.log(`お客様以外の画像で網に当たる数（書き直さない・参考）: ${otherHits}`);

  const byPair = new Map<string, number>();
  const targets: Array<{ r: Row; w: NonNullable<ReturnType<typeof rewriteOf>> }> = [];
  let skippedProperty = 0;
  for (const r of customer) {
    const w = rewriteOf(r);
    if (!w) continue;
    const kind = savedImageKind(r.text);
    const g = kind ? imageKindGroup(kind) : null;
    if ((g === "property" || g === "estimate") && !INCLUDE_PROPERTY) { skippedProperty++; continue; }
    targets.push({ r, w });
    const key = `${w.oldHead} → ${w.newHead}`;
    byPair.set(key, (byPair.get(key) ?? 0) + 1);
  }
  console.log(`書き直す行（お客様）: ${targets.length}・保存の見出しが物件/見積書で外した行: ${skippedProperty}`);
  for (const [k, n] of [...byPair].sort((a, b) => b[1] - a[1])) console.log(`   ${n}  ${k}`);
  const ids = new Set(targets.map((t) => t.r.id.slice(0, 8)));
  console.log(`確かめる人の行: ${KNOWN.filter((k) => ids.has(k)).length}/${KNOWN.length} 含む${KNOWN.filter((k) => !ids.has(k)).length ? `（含まない: ${KNOWN.filter((k) => !ids.has(k)).join(",")}）` : ""}`);
  const byYm = new Map<string, number>();
  for (const t of targets) byYm.set(t.r.created_at.slice(0, 7), (byYm.get(t.r.created_at.slice(0, 7)) ?? 0) + 1);
  console.log(`月ごと: ${[...byYm].sort().map(([m, n]) => `${m}:${n}`).join(" ")}`);
  for (const t of targets.slice(0, SHOW)) console.log(`   ${t.r.id.slice(0, 8)} ${t.r.created_at.slice(0, 10)} ${t.r.image_type ?? "-"}→${t.w.type} ${t.w.oldHead} → ${t.w.newHead}`);

  if (!APPLY) { console.log("（数えただけ・--apply で書く）"); return; }
  let wrote = 0;
  for (const { r, w } of targets) {
    // 読んだ後に書き換わっていないかを本文の一致で確かめてから書く
    const { data, error } = await sb.from("messages").update({ text: w.text, image_type: w.type }).eq("id", r.id).eq("text", r.text ?? "").select("id");
    if (error) { console.log("  ✗", r.id.slice(0, 8), error.message); continue; }
    if (data && data.length) wrote++;
  }
  console.log(`書いた: ${wrote}/${targets.length}`);
}
if (process.argv[1] && /fix-personal-image-text-stored/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
