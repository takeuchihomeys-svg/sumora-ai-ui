// scripts/audit-sent-image-name-read.ts — 送った画像の「どの物件か」の読み取り（readPropertyImage）を推論なしにして漏れが無いかの監査
//
// 2026-09-29 竹内「更に節約できないか」: recordSentImageProperty が送った画像1枚ごとに readPropertyImage を
//   推論の既定の重さ（reasoning_effort を送っていなかった）で呼び、出力 1,900〜6,700・11〜30秒かかっていた。
//   推論なし・温度0 に変える前に、**本番で送った画像**を推論なしで読み直し、
//     物件名・号室 … sent_image_properties の照合済みの記録（source が vision 以外＝会話の物件名に寄せられた物）
//     家賃・管理費・間取り・募集状況・退去予定日 … sent_image_properties.facts（推論ありで読んだ値）
//   と1件ずつ見比べる。物件名は照合（resolveReadProperty）を通して同じ物件に寄るかで見る（本番と同じ判定）。
//   ⚠ DB には書かない（読むだけ）。鍵は表示しない。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-sent-image-name-read.ts [--n=40] [--days=10]
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";
import { resolveReadProperty } from "../app/lib/property-name-match";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const N = Number(arg("n", "40"));
const DAYS = Number(arg("days", "10"));
const room = (s: string | null | undefined) => String(s ?? "").trim().replace(/^0+(?=\d)/, "").replace(/号室$/, "");

type Facts = { rent?: number; admin_fee_yen?: number; floor_plan?: string; status?: string; vacancy_date?: string; room_no?: string };
type Row = { image_url: string; conversation_id: string; property_name: string; room_no: string | null; source: string; facts: Facts | null };

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) { console.error("DEEPSEEK_API_KEY が無い"); process.exit(1); }
  const { data, error } = await sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no, source, facts")
    .gte("created_at", new Date(Date.now() - DAYS * 86400_000).toISOString()).neq("source", "vision").not("facts", "is", null)
    .order("created_at", { ascending: false }).limit(400);
  if (error) throw new Error(error.message);
  const per = new Map<string, number>();
  const rows = ((data ?? []) as Row[])
    .filter((r) => (r.facts as { src?: string } | null)?.src === "image")
    .filter((r) => { const n = per.get(r.conversation_id) ?? 0; if (n >= 3) return false; per.set(r.conversation_id, n + 1); return true; })
    .slice(0, N);
  console.log(`── 監査: 過去 ${DAYS}日に送った画像 ${rows.length}枚（照合済み・推論ありの値あり）を推論なしで読み直す\n`);
  const t = { ok: 0, name: 0, room: 0, rent: 0, rentAsk: 0, admin: 0, adminAsk: 0, plan: 0, planAsk: 0, status: 0, statusAsk: 0, vac: 0, vacAsk: 0, out: 0, ms: 0 };
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < rows.length) {
      const r = rows[i++];
      const t0 = Date.now();
      const got = await readPropertyImage(r.image_url, { thinking: false });
      const ms = Date.now() - t0;
      const lines: string[] = [`■ ${r.image_url.slice(-40)} ${ms}ms 出力 ${got.usage?.output ?? "-"}`];
      if (got.items.length === 0) { lines.push(`   ⚠ 読めなかった: ${got.raw.slice(0, 100)}`); console.log(lines.join("\n")); continue; }
      t.ok++; t.ms += ms; t.out += got.usage?.output ?? 0;
      // 一覧の画像は号室が一致する物を採る（本番の照合も items[0] だが、比べる時は同じ部屋で見る）
      const it = got.items.find((x) => room(x.roomNumber) === room(r.room_no)) ?? got.items[0];
      const nameOk = !!resolveReadProperty({ propertyName: it.propertyName, roomNumber: it.roomNumber }, [r.property_name]);
      const roomOk = room(it.roomNumber) === room(r.room_no);
      if (nameOk) t.name++; if (roomOk) t.room++;
      lines.push(`   ${nameOk ? "＝" : "≠"} 物件 ${r.property_name} ${r.room_no ?? ""} ← 「${it.propertyName} ${it.roomNumber}」${roomOk ? "" : " ⚠号室"}${got.items.length > 1 ? `（${got.items.length}件）` : ""}`);
      const f = r.facts ?? {};
      const cmp = (label: string, a: unknown, b: unknown, key: "rent" | "admin" | "plan" | "status" | "vac") => {
        if (a === undefined || a === null || a === "") return;
        (t as Record<string, number>)[`${key}Ask`]++;
        const same = String(a).replace(/\s/g, "") === String(b ?? "").replace(/\s/g, "");
        if (same) (t as Record<string, number>)[key]++;
        else lines.push(`   〜 ${label}: 推論あり ${a} ／ 推論なし ${b ?? "（なし）"}`);
      };
      cmp("家賃", f.rent, it.rent, "rent");
      cmp("管理費", f.admin_fee_yen, it.adminFee, "admin");
      cmp("間取り", f.floor_plan, it.floorPlan, "plan");
      cmp("募集状況", f.status, it.status, "status");
      cmp("退去予定日", f.vacancy_date, it.vacancyDate, "vac");
      console.log(lines.join("\n"));
    }
  }));
  console.log(`\n=== まとめ ===`);
  console.log(`読めた ${t.ok}/${rows.length}・平均 ${t.ok ? Math.round(t.ms / t.ok) : 0}ms・出力 平均 ${t.ok ? Math.round(t.out / t.ok) : 0}`);
  console.log(`物件名（照合で同じ物件に寄る）${t.name}/${t.ok}・号室 ${t.room}/${t.ok}・家賃 ${t.rent}/${t.rentAsk}・管理費 ${t.admin}/${t.adminAsk}・間取り ${t.plan}/${t.planAsk}・募集状況 ${t.status}/${t.statusAsk}・退去予定日 ${t.vac}/${t.vacAsk}`);
  console.log(`（推論ありの値も読み違いがあり得る。〜 の行は画像を開いて目で確かめること）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
