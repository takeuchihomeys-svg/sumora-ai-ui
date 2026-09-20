// 「お待たせ致しました」は AIX でまだ出ているのか（読み取りのみ）
//
// 2026-09-20 竹内「AIX で送ったあとの AIX テンプレートの文の質を上げる」
//   直近21日の差分で **生成94件 / 実送信109件** あった。
//
// 前提（設計知見・竹内さんのルール）:
//   ・memory feedback_no_omatase: 「お待たせ致しました」は返信で一切使わない（自動返信化のため）
//   ・G32（greeting.ts）: 禁止語。返信生成は stripWaited で除去・final-check で BANNED_WORD block
//   ・設計知見「入口だけ直しても生成後の癖は残る — 出口の決定論も同じ関数で全経路に配る」:
//     テンプレート生成に stripWaited が1つも通っていなかったのを配線した、という記録がある
//
// 決めたいこと:
//   ① 直した後も生成に出ているか（日別で見る。直った日から0になっているか）
//   ② 実送信に何通あるか（実送信に大量にあるなら、この場面では**正しい形**の可能性）
//   ③ どの経路・どの AIX で出ているか
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const RE = /お待たせ(?:致|いた)?しました/;

async function page(table: string, select: string, order: string, days: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 14; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 60);

  // ── ① 実送信（messages）に何通あるか ──
  const msgs = await page("messages", "text, created_at, sender, is_aix_generated", "created_at", days);
  const staff = msgs.filter((m) => m.sender === "staff" && String(m.text ?? "").length > 5);
  const hit = staff.filter((m) => RE.test(String(m.text)));
  const aixHit = hit.filter((m) => m.is_aix_generated === true);
  console.log(`=== ① 実送信（直近${days}日 スタッフ ${staff.length}通）===`);
  console.log(`   「お待たせ致しました」を含む: ${hit.length}通 (${((hit.length / staff.length) * 100).toFixed(1)}%)`);
  console.log(`     うち AIX 由来: ${aixHit.length}通 ／ 手打ち: ${hit.length - aixHit.length}通`);

  // 日別（直った日から0になっているか）
  const byDay = new Map<string, { staff: number; hit: number }>();
  for (const m of staff) {
    const d = String(m.created_at).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, { staff: 0, hit: 0 });
    byDay.get(d)!.staff++;
    if (RE.test(String(m.text))) byDay.get(d)!.hit++;
  }
  console.log(`\n   --- 日別（直近21日）---`);
  for (const [d, v] of [...byDay.entries()].sort().slice(-21)) {
    const bar = "█".repeat(Math.min(30, v.hit));
    console.log(`     ${d}  ${String(v.hit).padStart(3)}/${String(v.staff).padStart(4)}通  ${bar}`);
  }

  // ── ② 生成文（ai_reply_examples.ai_draft）に何件あるか ──
  const ex = await page("ai_reply_examples", "ai_draft, sent_reply, entry_source, aix_action, created_at", "created_at", days);
  const drafts = ex.filter((r) => String(r.ai_draft ?? "") && String(r.ai_draft) !== "__SHOWN__" && String(r.ai_draft).length > 6);
  const dHit = drafts.filter((r) => RE.test(String(r.ai_draft)));
  console.log(`\n=== ② 生成文（${drafts.length}件）に含まれる: ${dHit.length}件 (${((dHit.length / drafts.length) * 100).toFixed(1)}%) ===`);
  const byDayD = new Map<string, { n: number; hit: number }>();
  for (const r of drafts) {
    const d = String(r.created_at).slice(0, 10);
    if (!byDayD.has(d)) byDayD.set(d, { n: 0, hit: 0 });
    byDayD.get(d)!.n++;
    if (RE.test(String(r.ai_draft))) byDayD.get(d)!.hit++;
  }
  console.log(`   --- 日別（直近21日）---`);
  for (const [d, v] of [...byDayD.entries()].sort().slice(-21)) {
    const bar = "█".repeat(Math.min(30, v.hit));
    console.log(`     ${d}  ${String(v.hit).padStart(3)}/${String(v.n).padStart(4)}件  ${bar}`);
  }

  // ── ③ どの経路・どの AIX か ──
  console.log(`\n=== ③ どこで出ているか（生成文）===`);
  const byKey = new Map<string, { n: number; hit: number }>();
  for (const r of drafts) {
    const k = `${r.entry_source ?? "?"} / ${r.aix_action ?? "-"}`;
    if (!byKey.has(k)) byKey.set(k, { n: 0, hit: 0 });
    byKey.get(k)!.n++;
    if (RE.test(String(r.ai_draft))) byKey.get(k)!.hit++;
  }
  for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1].hit - a[1].hit).slice(0, 12)) {
    if (v.hit === 0 && v.n < 20) continue;
    console.log(`     ${k.padEnd(34)} ${String(v.hit).padStart(4)}/${String(v.n).padStart(4)}件 (${((v.hit / v.n) * 100).toFixed(0)}%)`);
  }

  // ── ④ スタッフは消しているのか残しているのか ──
  const both = ex.filter((r) => {
    const d = String(r.ai_draft ?? ""), s = String(r.sent_reply ?? "");
    return d && s && d !== "__SHOWN__" && d.length > 6 && s.length > 6;
  });
  let kept = 0, removed = 0, added = 0;
  for (const r of both) {
    const a = RE.test(String(r.ai_draft)), b = RE.test(String(r.sent_reply));
    if (a && b) kept++;
    if (a && !b) removed++;
    if (!a && b) added++;
  }
  console.log(`\n=== ④ 生成に出た時、スタッフはどうしたか（差分が取れる ${both.length}件）===`);
  console.log(`   そのまま送った（残した）: ${kept}件`);
  console.log(`   消した                  : ${removed}件`);
  console.log(`   生成に無いのに足した      : ${added}件`);
  console.log(`   → 「残した」「足した」が多ければ、この場面では**スタッフが使う形**（禁止語の線が場面に合っていない）`);

  // ── ④-2 直った後に**また出た**物（再発の特定）──
  //   日別で見ると 9/10〜9/18 は生成0件だったのに 9/19・9/20 に出ている。
  //   出口（stripWaited）が効かない経路が残っているのか、新しい経路が増えたのかを実物で見る。
  const RECENT_FROM = process.env.RECENT_FROM ?? "2026-09-19";
  const recent = drafts.filter((r) => String(r.created_at) >= RECENT_FROM && RE.test(String(r.ai_draft)));
  console.log(`\n=== ④-2 ${RECENT_FROM} 以降の生成文に出ている物（再発の疑い）: ${recent.length}件 ===`);
  for (const r of recent) {
    const s = String(r.sent_reply ?? "");
    console.log(`\n   ── [${r.entry_source} / ${r.aix_action ?? "-"}] ${String(r.created_at).slice(0, 16)}`);
    console.log(`   生成  : ${String(r.ai_draft).replace(/\n/g, " ／ ").slice(0, 150)}`);
    console.log(`   実送信: ${s ? s.replace(/\n/g, " ／ ").slice(0, 150) : "（無し）"}`);
    console.log(`   → スタッフは ${s ? (RE.test(s) ? "そのまま送った" : "消した") : "不明"}`);
  }

  // ── ④-3 日別 × 経路（9/10 に何が変わったのか）──
  console.log(`\n=== ④-3 経路別の日別（9/1 以降・出ている経路だけ）===`);
  const keys = [...byKey.entries()].filter(([, v]) => v.hit > 0).map(([k]) => k);
  for (const k of keys.slice(0, 6)) {
    const line: string[] = [];
    for (const [d] of [...byDayD.entries()].sort().slice(-20)) {
      const inDay = drafts.filter((r) => String(r.created_at).slice(0, 10) === d && `${r.entry_source ?? "?"} / ${r.aix_action ?? "-"}` === k);
      const h = inDay.filter((r) => RE.test(String(r.ai_draft))).length;
      line.push(inDay.length === 0 ? "・" : h === 0 ? "0" : String(Math.min(9, h)));
    }
    console.log(`     ${k.padEnd(42)} ${line.join("")}`);
  }
  console.log(`     ${"（左が20日前・右が今日／・=その日その経路の生成なし）".padEnd(42)}`);

  // ── ④-4 「生成に無いのにスタッフが足した」のはどの経路か ──
  //   テンプレート経由（aix_template）は stripWaited が配線済みで生成0件。
  //   そこでスタッフが自分で足しているなら、**消したこと自体が実態と合っていない**証拠になる。
  console.log(`\n=== ④-4 スタッフが自分で足した ${added}件 の内訳 ===`);
  const addedBy = new Map<string, number>();
  const removedBy = new Map<string, number>();
  const keptBy = new Map<string, number>();
  for (const r of both) {
    const k = `${r.entry_source ?? "?"} / ${r.aix_action ?? "-"}`;
    const a = RE.test(String(r.ai_draft)), b = RE.test(String(r.sent_reply));
    if (!a && b) addedBy.set(k, (addedBy.get(k) ?? 0) + 1);
    if (a && !b) removedBy.set(k, (removedBy.get(k) ?? 0) + 1);
    if (a && b) keptBy.set(k, (keptBy.get(k) ?? 0) + 1);
  }
  const allKeys = new Set([...addedBy.keys(), ...removedBy.keys(), ...keptBy.keys()]);
  console.log(`   ${"経路".padEnd(42)} 残した  消した  足した`);
  for (const k of [...allKeys].sort((a, b) => ((addedBy.get(b) ?? 0) + (keptBy.get(b) ?? 0)) - ((addedBy.get(a) ?? 0) + (keptBy.get(a) ?? 0)))) {
    console.log(`   ${k.padEnd(42)} ${String(keptBy.get(k) ?? 0).padStart(5)}  ${String(removedBy.get(k) ?? 0).padStart(5)}  ${String(addedBy.get(k) ?? 0).padStart(5)}`);
  }
  console.log(`   → テンプレート経由（生成0件）で「足した」が多ければ、消したことが実態と合っていない`);

  // ── ⑤ 実物 ──
  console.log(`\n=== ⑤ 実送信の実物（8件）===`);
  for (const m of hit.slice(0, 8)) {
    console.log(`     ${String(m.created_at).slice(0, 10)} ${m.is_aix_generated ? "[AIX]" : "[手打]"} ${String(m.text).replace(/\n/g, " ／ ").slice(0, 120)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
