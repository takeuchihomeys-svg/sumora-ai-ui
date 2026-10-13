// scripts/audit-sheet-vacancy-fields.ts — 物件資料の退去予定日・入居可能日の「取り違え」を、文字層のある売上サポの行（property_pickups）で数える（読むだけ・LLM なし・$0）
//
// 2026-10-13 竹内「退去予定日がどこに書いていて、空室がどこに書いているか…読み取る箇所を間違えていた部分等も」。
//   物差し（正解）は文字層を別の実装で読んだ listing-terms（property_pickups.terms.moveIn・リアプロの括弧の退去日 vacateMonthDay と入居時期 availableFrom/date）。
//   ① 読み口（ブレインの内覧の答え・vacancyDateFromMaterial）: 旧（行の最初の日付）と新（欄で読む）の退去予定日を、terms の退去日と比べる
//   ② 保存済みの読み取りの行（image_lines）: 「退去予定: 日付」が terms の入居時期と同じ＝入居時期を退去予定にした行を、欄に合わせる（alignVacancyLines）前と後で数える
// 実行: npx tsx --env-file=.env.local scripts/audit-sheet-vacancy-fields.ts [--days=90] [--show=10]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");

type Row = { id: number; property_name: string | null; room_no: string | null; pdf_text: string | null; image_lines: unknown; terms: { moveIn?: { kind?: string; current?: string | null; vacateMonthDay?: string; availableFrom?: string; date?: string; part?: string; raw?: string | null } } | null; created_at: string };

async function main() {
  const days = Number(arg("days", "90")), show = Number(arg("show", "10"));
  const { vacancyDateFromMaterial, vacancyDateFromMaterialLegacy } = await import("../app/lib/viewing-check-first");
  const { moveInFactOfPickup } = await import("../app/lib/aix-material-facts");
  const { alignVacancyLines, readSheetVacancy, sheetDateKey } = await import("../app/lib/sheet-vacancy");
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let f = 0; ; f += 500) {
    const { data, error } = await sb.from("property_pickups").select("id, property_name, room_no, pdf_text, image_lines, terms, created_at").gte("created_at", since).not("pdf_text", "is", null).range(f, f + 499);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 500) break;
  }
  const { parseListingTerms } = await import("../app/lib/listing-terms");
  // 保存の terms は多くの行で空 → 文字層をその場で listing-terms で読む（リアプロの「現況/入居時期」の行だけ正解にする＝括弧の退去日と入居時期が欄で分かる）
  for (const r of rows) { const t = parseListingTerms(r.pdf_text, { today: r.created_at }); r.terms = { moveIn: t.moveIn as NonNullable<Row["terms"]>["moveIn"] }; }
  const rpOnly = !process.argv.includes("--all");
  if (rpOnly) { const n0 = rows.length; rows.splice(0, rows.length, ...rows.filter((r) => /現況\s*\/\s*入居時期/.test(r.pdf_text ?? ""))); console.log(`リアプロの「現況/入居時期」の行だけ（正解が欄で決まる） ${rows.length}/${n0}`); }
  const mdOfTerms = (r: Row) => { const v = r.terms?.moveIn?.vacateMonthDay; return v && /^\d{2}-\d{2}$/.test(v) ? `${parseInt(v.slice(0, 2), 10)}月${parseInt(v.slice(3), 10)}日` : null; };
  const moveInKeyOfTerms = (r: Row) => { const m = r.terms?.moveIn as { date?: string; day?: number; part?: string } | undefined; if (!m?.date) return null; const x = m.date.match(/^\d{4}-(\d{2})/); if (!x) return null; return m.day ? `${+x[1]}/${m.day}` : m.part ? `${+x[1]}/${m.part}` : null; };
  const c = { rows: rows.length, withVacOrMoveIn: 0, legacyRight: 0, legacyWrong: 0, legacyMissing: 0, newRight: 0, newWrong: 0, newMissing: 0, legacyWrongIsMoveIn: 0, newWrongIsMoveIn: 0, newUnknownWhereLegacyWrong: 0, newFromNote: 0 };
  const noteShows: string[] = [];
  const lc = { linesWithVac: 0, vacEqMoveInBefore: 0, vacEqMoveInAfter: 0, changed: 0, vacAddedAfter: 0 };
  const shows: string[] = [];
  for (const r of rows) {
    const truth = mdOfTerms(r);
    const tMoveKey = moveInKeyOfTerms(r);
    const il = Array.isArray(r.image_lines) ? (r.image_lines as unknown[]).map(String) : [];
    const fact = moveInFactOfPickup({ pdf_text: r.pdf_text, image_lines: il, terms: null });
    const mat = [...(fact?.lines ?? []), ...il.filter((l) => !(fact?.lines ?? []).includes(l))];
    // 旧の材料（欄で分けた行を添える前）＝ moveInFactOfPickup の旧の形は「資料の文字のまま」の行だけ
    const matLegacy = mat.filter((l) => !/^(現況|退去予定|入居可能日|内覧可能日):/.test(l) || il.includes(l));
    const legacy = vacancyDateFromMaterialLegacy(matLegacy);
    const now = vacancyDateFromMaterial(mat);
    if (!truth && !tMoveKey && !legacy && !now) continue;
    c.withVacOrMoveIn++;
    const judge = (v: string | null) => (v === truth ? (v ? "right" : "none") : v ? "wrong" : "missing");
    const jl = judge(legacy), jn = judge(now);
    if (jl === "right") c.legacyRight++; else if (jl === "wrong") c.legacyWrong++; else if (jl === "missing") c.legacyMissing++;
    // listing-terms は括弧の退去日しか読まない → 括弧の外（カギ所在・特記の「9月末退去予定」）で見つけた日付は「文で見つけた」として別に数える（目で読んで全部正しかった）
    const rv = readSheetVacancy(mat.join("\n"));
    if (jn === "wrong" && !truth && rv.vacateFrom && !/括弧/.test(rv.vacateFrom)) { c.newFromNote++; if (noteShows.length < show) noteShows.push(`#${r.id} ${r.property_name} ${now}（${rv.vacateFrom}）`); }
    else if (jn === "right") c.newRight++; else if (jn === "wrong") c.newWrong++; else if (jn === "missing") c.newMissing++;
    const keyOf = (s: string | null) => (s ? sheetDateKey(s.replace("日", "").replace("月", "/")) : null);
    if (jl === "wrong" && tMoveKey && keyOf(legacy) === tMoveKey) c.legacyWrongIsMoveIn++;
    if (jn === "wrong" && tMoveKey && keyOf(now) === tMoveKey) c.newWrongIsMoveIn++;
    if (jl === "wrong" && !now) c.newUnknownWhereLegacyWrong++;
    if ((jl !== jn) && shows.length < show) shows.push(`#${r.id} ${r.property_name} ${r.room_no ?? ""} terms「${r.terms?.moveIn?.raw ?? ""}」 正解=${truth ?? "なし"} 旧=${legacy ?? "なし"} 新=${now ?? "なし"}`);
    // 保存済みの行
    if (il.some((l) => /^退去予定\s*[:：]/.test(l))) {
      lc.linesWithVac++;
      const vacKey = (ls: string[]) => ls.filter((l) => /^退去予定\s*[:：]/.test(l)).map((l) => sheetDateKey(l.replace(/^[^:：]+[:：]\s*/, ""))).filter(Boolean) as string[];
      const al = alignVacancyLines(il, r.pdf_text);
      if (tMoveKey && vacKey(il).includes(tMoveKey)) lc.vacEqMoveInBefore++;
      if (tMoveKey && vacKey(al.lines).includes(tMoveKey)) lc.vacEqMoveInAfter++;
      if (al.changed) lc.changed++;
    } else if (readSheetVacancy(r.pdf_text).vacate) lc.vacAddedAfter++;
  }
  console.log(`売上サポの行（文字層あり・${days}日）${c.rows}行・退去日か入居時期のある行 ${c.withVacOrMoveIn}`);
  console.log(`① 読み口の退去予定日（正解＝listing-terms の括弧の退去日）`);
  console.log(`   旧: 正しい ${c.legacyRight}・誤り ${c.legacyWrong}（うち入居時期の日付を退去日に ${c.legacyWrongIsMoveIn}）・取りこぼし ${c.legacyMissing}`);
  console.log(`   新: 正しい ${c.newRight}・誤り ${c.newWrong}（うち入居時期 ${c.newWrongIsMoveIn}）・取りこぼし ${c.newMissing}・旧の誤りを「分からない」にした ${c.newUnknownWhereLegacyWrong}・括弧の外の文で見つけた ${c.newFromNote}`);
  for (const s of noteShows) console.log("    文で見つけた: " + s);
  console.log(`② 保存済みの読み取りの行: 退去予定の行あり ${lc.linesWithVac}・入居時期を退去予定にした行 前 ${lc.vacEqMoveInBefore} → 後 ${lc.vacEqMoveInAfter}・行が変わる ${lc.changed}／退去予定の行が無いが文字層に退去日がある ${lc.vacAddedAfter}`);
  for (const s of shows) console.log("  - " + s);
}
main().catch((e) => { console.error(e); process.exit(1); });
