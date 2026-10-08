// scripts/backfill-staff-writer.ts — 過去のスタッフの送信に書き手（竹内さん／従業員）を付ける（2026-10-08）
//   入力:
//     --device=<jsonl>  scripts/audit-staff-device-logs.ts --out の 1通1行（送った端末で決まった通・source='device'）＝一番強い
//     --in=<jsonl>      scripts/audit-staff-writer.ts --out の 1通1行（文の癖＋文脈）＝端末の記録が無い通（7/10 より前・照合できなかった通）だけに使う
//   既定は dry-run（数えるだけ）。--apply で messages.staff_writer / staff_writer_source / staff_writer_confidence を書く
//   グループの発言者（group_speaker）・人（manual）で決まった行は上書きしない。端末（device）は文の癖（style／style_context）を上書きする
//
//   文の癖の確からしさは端末で測った精度に合わせて付け直す（10/08・7/10〜10/08 の端末で決まった手打ち・直し 1,768通）:
//     従業員の向き: 確か 99%・たぶん 97%・文脈 96% → そのまま
//     竹内さんの向き: 確か 86%（手打ち 84%・直し 98%）→ 「たぶん」に下げる／たぶん 73%（手打ち 67%・直し 91%）→ 直しだけ「たぶん」・手打ちは書かない
//       （従業員も定型・下書きの「頂き」「出来」をそのまま打つ＝竹内さんの表記が出ても竹内さんとは限らない）
//     文脈の竹内さん 84%（手打ち 75%）→ 直しだけ「たぶん」
//     --raw-confidence で付け直さない（旧）
//   グループの発言者の行は migrate-schema のトリガーが入れる時に付く。過去分は --print-sql の SQL で
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-staff-writer.ts --out=<labels.jsonl>
//   npx tsx --env-file=.env.local scripts/audit-staff-device-logs.ts --edge=<dir> --labels=<labels.jsonl> --map=<map.json> --out=<device.jsonl>
//   npx tsx --env-file=.env.local scripts/backfill-staff-writer.ts --device=<device.jsonl> --in=<labels.jsonl> [--with-context]            # dry-run
//   npx tsx --env-file=.env.local scripts/backfill-staff-writer.ts --device=<device.jsonl> --in=<labels.jsonl> --with-context --apply      # 本番に書く
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const APPLY = process.argv.includes("--apply");
const WITH_CONTEXT = process.argv.includes("--with-context");
const RAW = process.argv.includes("--raw-confidence");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const GROUP_SQL = `-- グループの発言（過去分）: 発言者の LINE で決める
UPDATE messages SET staff_writer = 'takeuchi', staff_writer_source = 'group_speaker', staff_writer_confidence = 'sure'
  WHERE sender = 'staff' AND speaker_user_id = (SELECT value FROM hanbancyo_settings WHERE key = 'takeuchi_line_user_id')
    AND coalesce(staff_writer_source, '') <> 'manual';
UPDATE messages SET staff_writer = 'employee', staff_writer_source = 'group_speaker', staff_writer_confidence = 'sure'
  WHERE sender = 'staff' AND speaker_user_id = (SELECT value FROM hanbancyo_settings WHERE key = 'suzuki_line_user_id')
    AND coalesce(staff_writer_source, '') <> 'manual';
-- 戻す（端末・文の癖で付けた分だけ消す）:
-- UPDATE messages SET staff_writer = NULL, staff_writer_source = NULL, staff_writer_confidence = NULL WHERE staff_writer_source IN ('device','style','style_context');`;

type StyleRow = { id: string; src: string; writer: string | null; source: string | null; confidence: string };
type DeviceRow = { id: string; device: string; writer: string | null; confidence: string | null };
const readJsonl = <T>(p: string): T[] => (p ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);

/** 文の癖の判定を端末で測った精度に合わせて付け直す（null＝書かない） */
export function calibrateStyle(r: StyleRow): { writer: string; source: string; confidence: string } | null {
  if (!r.writer || !r.source || r.confidence === "unknown") return null;
  if (RAW) return { writer: r.writer, source: r.source, confidence: r.confidence };
  if (r.writer === "employee") return { writer: r.writer, source: r.source, confidence: r.confidence };
  // 竹内さんの向き
  if (r.source === "style" && r.confidence === "sure") return { writer: r.writer, source: r.source, confidence: "likely" };
  if (r.src === "edited") return { writer: r.writer, source: r.source, confidence: "likely" };
  return null;
}

async function main() {
  if (process.argv.includes("--print-sql")) { console.log(GROUP_SQL); return; }
  const device = readJsonl<DeviceRow>(arg("device", "")).filter((r) => r.writer && r.confidence);
  const deviceIds = new Set(readJsonl<DeviceRow>(arg("device", "")).map((r) => r.id)); // 端末で照合できた通（書き手が付かない端末＝事務所の PC 等も含む）
  const style = readJsonl<StyleRow>(arg("in", ""));
  const todo: Array<{ id: string; writer: string; source: string; confidence: string }> = [];
  for (const r of device) todo.push({ id: r.id, writer: r.writer!, source: "device", confidence: r.confidence! });
  let skippedByDevice = 0, dropped = 0;
  for (const r of style) {
    if (deviceIds.has(r.id)) { if (r.writer) skippedByDevice++; continue; }
    if (r.source === "style_context" && !WITH_CONTEXT) continue;
    const c = calibrateStyle(r); if (!c) { if (r.writer) dropped++; continue; }
    todo.push({ id: r.id, ...c });
  }
  const groups = new Map<string, string[]>();
  for (const r of todo) { const k = `${r.writer}|${r.source}|${r.confidence}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r.id); }
  console.log(`端末 ${device.length}行・文の癖の入力 ${style.length}行 → 書く ${todo.length}行（${APPLY ? "apply" : "dry-run"}${WITH_CONTEXT ? "・文脈も" : ""}${RAW ? "・付け直さない" : ""}）`);
  for (const [k, ids] of [...groups].sort()) console.log(`  ${k.padEnd(34)} ${ids.length}`);
  console.log(`  書かない: 端末で決まった通の文の癖 ${skippedByDevice}・精度が足りない竹内さんの向き ${dropped}・不明 ${style.filter((r) => !r.writer && !deviceIds.has(r.id)).length}`);
  if (!APPLY) { console.log(`\n（dry-run）グループの発言の SQL は --print-sql`); return; }
  let done = 0;
  for (const [k, ids] of groups) {
    const [writer, source, confidence] = k.split("|");
    // 端末は文の癖を上書きする／文の癖は空か文の癖の行だけ。グループの発言者・人の行は触らない
    const allowed = source === "device" ? "staff_writer_source.is.null,staff_writer_source.in.(style,style_context,device)" : "staff_writer_source.is.null,staff_writer_source.in.(style,style_context)";
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await sb.from("messages").update({ staff_writer: writer, staff_writer_source: source, staff_writer_confidence: confidence })
        .in("id", chunk).eq("sender", "staff").or(allowed);
      if (error) throw new Error(error.message);
      done += chunk.length;
    }
  }
  console.log(`書いた ${done}行（対象。グループの発言者・人の行は触っていない）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
