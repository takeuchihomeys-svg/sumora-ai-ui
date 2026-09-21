// 建物名だけで「同じマンション」と言ってよいか、線を実測で確かめる（読み取りのみ）
//
// 2026-09-21 竹内「一度グループに送った物件（マンションごと）は送られんようになってるかな？」→ マンションごとに外す。
//
// ⚠ DUP_MIN_SCORE = 0.95 は「**号室が一致した上で**名前がどれだけ近ければ同じ物件か」で決めた線
//   （scripts/audit-property-dup-threshold.ts）。今回は**名前だけ**で判定するので、線を引き直す必要がある。
//   名前だけで 0.95 を使った時に「似ているが別のマンション」を巻き込まないかを、実際の物件名で数える。
//
// 外すのは出口の削除なので、**巻き込みが0件になる線**を採る（設計知見「誤削除0でなければ入れない」）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-building-name-threshold.ts
import { createClient } from "@supabase/supabase-js";
import { normalizePropertyName, similarity } from "../app/lib/property-name-match";
import { buildingWing } from "../app/lib/sent-property-filter";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 60);
const ROOM_TAIL_RE = /[\s　]+(\d{1,4})(?:号室?)?$/;

type Cand = { name?: string };

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("property_candidate_pools")
      .select("candidates, sent_at")
      .gte("sent_at", new Date(Date.now() - DAYS * 86400_000).toISOString())
      .order("sent_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; rows.push(...r); if (r.length < 1000) break;
  }

  // 建物名（号室を落とした形）の一覧
  const names = new Set<string>();
  for (const row of rows) {
    for (const c of ((row.candidates ?? []) as Cand[])) {
      const raw = String(c?.name ?? "").trim();
      if (!raw || raw === "物件") continue;
      const m = raw.match(ROOM_TAIL_RE);
      names.add(m ? raw.slice(0, m.index ?? 0).trim() : raw);
    }
  }
  const list = [...names];
  console.log(`=== 直近${DAYS}日に送った建物名 ${list.length}種類 ===\n`);

  // 正規化した後で**文字列としては違う**のに、似ている度が高いペアを探す
  //   （完全に同じ名前は問題にならない＝同じマンション）
  const norm = new Map<string, string>();
  for (const n of list) norm.set(n, normalizePropertyName(n));
  const uniqNorm = [...new Set(norm.values())].filter(Boolean);
  console.log(`   正規化した後: ${uniqNorm.length}種類（表記ゆれが ${list.length - uniqNorm.length}件まとまった）\n`);

  type Pair = { a: string; b: string; s: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < uniqNorm.length; i++) {
    for (let j = i + 1; j < uniqNorm.length; j++) {
      const a = uniqNorm[i], b = uniqNorm[j];
      // 長さが大きく違えば 0.8 にも届かない（総当たりを軽くする枝刈り）
      if (Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 0.3) continue;
      const s = similarity(a, b);
      if (s >= 0.80) pairs.push({ a, b, s });
    }
  }
  pairs.sort((x, y) => y.s - x.s);
  console.log(`=== ① 別の名前なのに似ているペア（0.80 以上）${pairs.length}組 ===\n`);

  for (const T of [0.80, 0.85, 0.90, 0.95, 0.97, 1.0]) {
    const hit = pairs.filter((p) => p.s >= T);
    console.log(`   線 ${T.toFixed(2)} … 同じマンション扱いになる「別名のペア」 ${hit.length}組`);
  }

  console.log(`\n=== ② 0.95 以上のペアを目で読む（これが巻き込む相手）===`);
  const at95 = pairs.filter((p) => p.s >= 0.95);
  if (at95.length === 0) console.log(`   0組 ＝ 名前だけで 0.95 を使っても別のマンションを巻き込まない`);
  for (const p of at95.slice(0, 30)) {
    console.log(`   ${p.s.toFixed(3)}  「${p.a}」 ↔ 「${p.b}」`);
  }

  console.log(`\n=== ③ 0.90〜0.95 のペア（線を下げたら巻き込む相手）===`);
  const at90 = pairs.filter((p) => p.s >= 0.90 && p.s < 0.95);
  if (at90.length === 0) console.log(`   0組`);
  for (const p of at90.slice(0, 15)) console.log(`   ${p.s.toFixed(3)}  「${p.a}」 ↔ 「${p.b}」`);

  console.log(`\n=== ④ 0.85〜0.90（参考）===`);
  for (const p of pairs.filter((p) => p.s >= 0.85 && p.s < 0.90).slice(0, 10)) {
    console.log(`   ${p.s.toFixed(3)}  「${p.a}」 ↔ 「${p.b}」`);
  }

  // ⑤ 棟・号館の表記を分けた後に、線ごとに何組残るか
  //    similarity は2文字の**集合**なので「ii」と「iii」が同じになる（1.000）。
  //    棟を別に取り出して違えば別建物にすると、この形が全部消えるはず。
  console.log(`\n=== ⑤ 棟・号館を分けた後（buildingWing が違えば別建物）===`);
  const afterWing = pairs.filter((p) => buildingWing(p.a) === buildingWing(p.b));
  console.log(`   0.80 以上のペア ${pairs.length}組 → 棟が同じ物だけ ${afterWing.length}組\n`);
  for (const T of [0.90, 0.95, 0.96, 0.97, 0.98, 1.0]) {
    const hit = afterWing.filter((p) => p.s >= T);
    const mark = hit.length === 0 ? "  ← ここなら巻き込み0" : "";
    console.log(`   線 ${T.toFixed(2)} … 巻き込む「別名のペア」 ${String(hit.length).padStart(3)}組${mark}`);
  }
  console.log(`\n   ─ 棟を分けても残るペア（0.90 以上・目で読む）─`);
  const rest = afterWing.filter((p) => p.s >= 0.90);
  if (rest.length === 0) console.log(`     0組`);
  for (const p of rest.slice(0, 20)) {
    console.log(`     ${p.s.toFixed(3)}  「${p.a}」(棟:${buildingWing(p.a) || "なし"}) ↔ 「${p.b}」(棟:${buildingWing(p.b) || "なし"})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
