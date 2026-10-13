// scripts/build-property-name-ledger.ts — 物件名の帳簿（出所と回数）を作り、読み取りの化けの癖の表を実例から作って、直しを全件で測る（読むだけ・LLM なし・$0）
//
// 2026-10-14 竹内さん「物件名はシリーズ名＋地名の形が多い…正しい物件名の帳簿…化けの癖の表」。直しの決まりは app/lib/property-name-fix.ts。
//   ① 帳簿: property_pickups（資料の文字 text）・aix_usage_logs.property_names（スタッフ staff・試験の bexam を除く）・sent_properties（vision 以外 shared／vision read）
//   ② 覚える地名: 資料の文字（text）の名前の漢字の並びのうち、2つ以上の建物に出る物（谷町・堀江・上町台 等。地名の表に無い物）
//   ③ 化けの癖: 読み取り（read だけの行）の名前のうち、信頼できる帳簿の名前で「漢字の並び以外が同じ」物が1つだけ → 並びの組（読み→正）を数える
//   ④ 測る: 読み取りの名前（read）全部に fixReadPropertyName を当て、known／fixed／uncertain／unchanged を数え、
//      直した物は「その会話の後のスタッフの本文・AIX・売上サポに、直した名前（正）か読んだ名前（誤）のどちらが出るか」で確かめる（誤って別の物件に寄せた数＝0 が目標）
// 実行: npx tsx --env-file=.env.local scripts/build-property-name-ledger.ts [--write] [--show=40]
//   --write で app/lib/property-name-confusions.ts を書き直す（生成物・コミットする）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const WRITE = process.argv.includes("--write");
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=40").split("=")[1]);

async function all<T>(t: string, cols: string, f?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    let q = sb.from(t).select(cols).range(i, i + 999);
    if (f) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const fix = await import("../app/lib/property-name-fix");
  const { parseLoose } = await import("../app/lib/property-name-loose");
  const { toJapaneseKanji } = await import("../app/lib/ja-kanji");
  type Src = import("../app/lib/property-name-fix").LedgerSource;
  const rows: Array<{ name: string | null; source: Src; conv?: string | null; at?: string | null }> = [];
  const pk = await all<{ property_name: string | null; conversation_id: string | null; created_at: string }>("property_pickups", "property_name, conversation_id, created_at");
  for (const r of pk) rows.push({ name: r.property_name, source: "text", conv: r.conversation_id, at: r.created_at });
  const ax = await all<{ property_names: string[] | null; line_message_id: string | null; conversation_id: string | null; created_at: string; generated_text: string | null }>("aix_usage_logs", "property_names, line_message_id, conversation_id, created_at, generated_text", (q) => q.not("property_names", "is", null));
  for (const r of ax) { if (String(r.line_message_id ?? "").startsWith("bexam")) continue; for (const n of r.property_names ?? []) rows.push({ name: n, source: "staff", conv: r.conversation_id, at: r.created_at }); }
  const sp = await all<{ property_name: string | null; source: string | null; conversation_id: string | null; sent_at: string | null }>("sent_properties", "property_name, source, conversation_id, sent_at");
  for (const r of sp) rows.push({ name: r.property_name, source: r.source === "vision" ? "read" : "shared", conv: r.conversation_id, at: r.sent_at });
  const sip = await all<{ property_name: string | null; source: string | null; conversation_id: string | null; created_at: string | null }>("sent_image_properties", "property_name, source, conversation_id, created_at", (q) => q.eq("source", "vision"));
  for (const r of sip) rows.push({ name: r.property_name, source: "read", conv: r.conversation_id, at: r.created_at });
  const ledger = fix.buildLedger(rows);
  const trusted = ledger.filter(fix.ledgerTrusted);
  console.log(`■ 帳簿: 行 ${rows.length}（text ${pk.length}・staff ${rows.filter((r) => r.source === "staff").length}・shared ${rows.filter((r) => r.source === "shared").length}・read ${rows.filter((r) => r.source === "read").length}）→ 建物 ${ledger.length}・信頼できる ${trusted.length}`);

  // ② 覚える地名（資料の文字の名前の漢字の並び・2つ以上の建物・地名の表に無い）
  const places0 = fix.basePlaceSet();
  const tokCount = new Map<string, Set<string>>();
  for (const e of ledger) {
    if (!(e.counts.text ?? 0)) continue;
    for (const r of fix.kanjiRuns(e.name)) {
      if (Array.from(r.text).length < 2 || places0.has(r.text)) continue;
      const s = tokCount.get(r.text) ?? new Set(); s.add(e.key); tokCount.set(r.text, s);
    }
  }
  const learned = [...tokCount].filter(([t, s]) => s.size >= 2 && !fix.NOT_PLACE_RE.test(t)).map(([t]) => t).sort();
  console.log(`■ 資料の文字から覚えた地名の並び ${learned.length}（例 ${learned.slice(0, 30).join("・")}）`);

  // ③ 化けの癖（読みだけの行 × 信頼できる帳簿の1つの名前・漢字の並び以外が同じ）
  const RUN_RE = /[一-龯々〆]+(?:[ヶケヵノの][一-龯々]+)*/g;
  const strip = (s: string) => s.replace(RUN_RE, "＊").normalize("NFKC").replace(/[\s　・]/g, "").toLowerCase();
  const allPlaces = new Set([...places0, ...learned]);
  const readOnly = ledger.filter((e) => !fix.ledgerTrusted(e) && (e.counts.read ?? 0) > 0);
  const conf = new Map<string, { to: string; n: number; ex: string[]; keys: Set<string> }>();
  for (const e of readOnly) {
    const runs = fix.kanjiRuns(e.name);
    if (!runs.length) continue;
    const s = strip(e.name);
    const cands = trusted.filter((t) => t.marks === e.marks && strip(t.name) === s && fix.kanjiRuns(t.name).length === runs.length && t.key !== e.key);
    if (cands.length !== 1) continue;
    const truthRuns = fix.kanjiRuns(cands[0].name);
    runs.forEach((r, i) => {
      const to = truthRuns[i].text;
      if (r.text === to || fix.isKnownPlaceToken(r.text, allPlaces) || !fix.isKnownPlaceToken(to, allPlaces)) return;
      const k = `${r.text}→${to}`;
      const c = conf.get(k) ?? { to, n: 0, ex: [], keys: new Set<string>() }; c.n += e.counts.read ?? 1; c.keys.add(cands[0].key); if (c.ex.length < 2) c.ex.push(`${e.name}→${cands[0].name}`); conf.set(k, c);
    });
  }
  // 竹内さんが挙げた化け（10/14）: 実例に無くても種にする（1回＝帳簿で確かめる側）
  for (const [a, b] of [["梅出", "梅田"], ["戸原橋", "芦原橋"], ["令福", "今福"], ["速里", "遠里"], ["速里小野", "遠里小野"]] as const) if (!conf.has(`${a}→${b}`)) conf.set(`${a}→${b}`, { to: b, n: 1, ex: ["竹内さん 10/14"], keys: new Set(["seed"]) });
  // 同じ読みが2つの正に分かれる物は表に入れない（候補が1つに決まらない）
  const byFrom = new Map<string, string[]>();
  for (const k of conf.keys()) { const [a, b] = k.split("→"); byFrom.set(a, [...(byFrom.get(a) ?? []), b]); }
  // 似ていない組（同じシリーズの別の地名の建物＝「クリエオーレ私市山手→長橋」）を入れない: 1字違い・半分以下の違い（同じ長さ）・2つ以上の建物で見た物だけ
  const ed = (a: string, b: string) => { const x = [...a], y = [...b]; let p = Array.from({ length: y.length + 1 }, (_, j) => j); for (let i = 1; i <= x.length; i++) { const c = [i]; for (let j = 1; j <= y.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)); p = c; } return p[y.length]; };
  const alike = (a: string, b: string, keys: Set<string>) => { const la = [...a].length, lb = [...b].length, d = ed(a, b); return d <= 1 || (la === lb && d * 2 <= la) || keys.size >= 2; };
  const dropped = [...conf].filter(([k, v]) => !alike(k.split("→")[0], v.to, v.keys));
  const table = [...conf].filter(([k, v]) => byFrom.get(k.split("→")[0])!.length === 1 && alike(k.split("→")[0], v.to, v.keys)).map(([k, v]) => [k, { ...v, n: v.keys.has("seed") ? 1 : v.keys.size }] as const).sort((a, b) => b[1].n - a[1].n);
  console.log(`   似ていない組で外した ${dropped.length}: ${dropped.map(([k]) => k).join(" ")}`);
  // 字の化けの癖（同じ長さの組の、違う字どうし・見た建物の数）。2つ以上の建物で見た字の組だけ（渡→波・雑→難・賀→波）
  const charConf = new Map<string, Set<string>>();
  for (const [k, v] of conf) {
    if (v.keys.has("seed")) continue;
    const [a, b] = [[...k.split("→")[0]], [...v.to]];
    if (a.length !== b.length) continue;
    a.forEach((c, i) => { if (c !== b[i]) { const kk = `${c}→${b[i]}`; const s = charConf.get(kk) ?? new Set<string>(); for (const x of v.keys) s.add(x); charConf.set(kk, s); } });
  }
  const charTable = [...charConf].filter(([, s]) => s.size >= 2).map(([k, s]) => [k, s.size] as const).sort((a, b) => b[1] - a[1]);
  console.log(`■ 字の化けの癖（2つ以上の建物）${charTable.length}: ${charTable.map(([k, n]) => `${k}×${n}`).join(" ")}`);
  console.log(`■ 化けの癖の表 ${table.length}（2つの正に分かれて外した ${[...byFrom].filter(([, v]) => v.length > 1).length}）`);
  for (const [k, v] of table.slice(0, 40)) console.log(`   ${k} ×${v.n}  例 ${v.ex.join(" ／ ")}`);

  if (WRITE) {
    const body = `// app/lib/property-name-confusions.ts — 生成物（scripts/build-property-name-ledger.ts --write・${new Date().toISOString().slice(0, 10)}）。手で直さない
// 化けの癖の表（読み取りの地名の並び → 正しい地名・見た回数）と、資料の文字から覚えた地名の並び（2つ以上の建物に出る物）。
// 表の作り方: 照合できなかった読み取りの名前（source=vision）のうち、信頼できる帳簿の名前で「漢字の並び以外が同じ」物が1つだけの組から、
//   表に無い並び→表にある並び を、見た建物の数で数えた。同じ読みが2つの正に分かれる物・似ていない組（1字違いでも半分以下の違いでもなく、1つの建物でしか見ていない）は入れない。
export const CONFUSION_TOKENS: ReadonlyArray<readonly [string, string, number]> = [
${table.map(([k, v]) => `  [${JSON.stringify(k.split("→")[0])}, ${JSON.stringify(v.to)}, ${v.n}],`).join("\n")}
];
/** 字の化けの癖（読み → 正・見た建物の数・2つ以上だけ）。地名の並びが「似ている」かの判断に使う（渡→波・雑→難） */
export const CONFUSION_CHARS: ReadonlyArray<readonly [string, string, number]> = [
${charTable.map(([k, n]) => `  [${JSON.stringify(k.split("→")[0])}, ${JSON.stringify(k.split("→")[1])}, ${n}],`).join("\n")}
];
export const LEARNED_PLACE_TOKENS: ReadonlyArray<string> = ${JSON.stringify(learned)};
`;
    writeFileSync("app/lib/property-name-confusions.ts", body, "utf8");
    console.log("→ app/lib/property-name-confusions.ts を書いた（読み直して測るにはもう一度流す）");
  }

  // ④ 測る: 読み取りの名前（read だけの行の名前）に直しを当てる
  const res = { known: 0, fixed: 0, uncertain: 0, unchanged: 0 };
  const byRule = new Map<string, number>();
  const fixedList: Array<{ from: string; to: string; rule: string; n: number }> = [];
  const uncertainList: string[] = [];
  const readNames = new Map<string, number>();
  for (const r of rows) if (r.source === "read" && r.name) readNames.set(toJapaneseKanji(r.name.trim()), (readNames.get(toJapaneseKanji(r.name.trim())) ?? 0) + 1);
  for (const [name, n] of readNames) {
    const out = fix.fixReadPropertyName(name, ledger, {});
    res[out.status] += 1;
    if (out.status === "fixed") { byRule.set(out.rule ?? "", (byRule.get(out.rule ?? "") ?? 0) + 1); fixedList.push({ from: name, to: out.name, rule: out.rule ?? "", n }); }
    if (out.status === "uncertain") uncertainList.push(`${name}${out.candidates?.length ? ` ?→ ${out.candidates.join(" | ")}` : ""}`);
  }
  console.log(`\n■ 読み取りの名前 ${readNames.size}種類: 帳簿にある ${res.known}・直した ${res.fixed}・確かではない ${res.uncertain}・そのまま ${res.unchanged}`);
  console.log(`   直した決まり: ${[...byRule].map(([k, v]) => `${k} ${v}`).join("・")}`);

  // 確かめ: 同じ会話の、読んだ時より後のスタッフの名前（AIX・売上サポ・本文の 🌟/【】）に、直した名前か読んだ名前のどちらが出るか
  const convRows = new Map<string, Array<{ name: string; source: Src; at: string }>>();
  for (const r of rows) if (r.conv && r.name && r.source !== "read") { const a = convRows.get(r.conv) ?? []; a.push({ name: r.name, source: r.source, at: r.at ?? "" }); convRows.set(r.conv, a); }
  const readAt = new Map<string, Array<{ conv: string; at: string }>>();
  for (const r of rows) if (r.source === "read" && r.conv && r.name) { const k = toJapaneseKanji(r.name.trim()); const a = readAt.get(k) ?? []; a.push({ conv: r.conv, at: r.at ?? "" }); readAt.set(k, a); }
  const { matchLoose, isSameLoose } = await import("../app/lib/property-name-loose");
  // 正解の元: 同じ会話の 資料の文字（text）・グループに共有した資料（shared）・スタッフの入力（staff）。
  //   ⚠ スタッフの入力は AIX の物件名の先入れ（画像の読み取り）をそのまま送った物がある（「プレアール速里小野」）＝読んだ名前と同じ字のスタッフの名前は「誤」の証拠にしない
  let ok = 0, wrong = 0, unknown = 0, prefillOnly = 0;
  const wrongList: string[] = [];
  const verdictOf = new Map<string, string>();
  for (const f of fixedList) {
    let verdict: "ok" | "wrong" | "unknown" | "prefill" = "unknown";
    for (const { conv } of readAt.get(f.from) ?? []) {
      const xs = convRows.get(conv) ?? [];
      const hitTo = xs.some((x) => isSameLoose(matchLoose(x.name, f.to)));
      const hitFromDoc = xs.some((x) => x.source !== "staff" && isSameLoose(matchLoose(x.name, f.from)) && !isSameLoose(matchLoose(x.name, f.to)));
      const hitFromStaff = xs.some((x) => x.source === "staff" && isSameLoose(matchLoose(x.name, f.from)) && !isSameLoose(matchLoose(x.name, f.to)));
      if (hitTo) { verdict = "ok"; break; }
      if (hitFromDoc) verdict = "wrong";
      else if (hitFromStaff && verdict === "unknown") verdict = "prefill";
    }
    verdictOf.set(f.from, verdict);
    if (verdict === "ok") ok++; else if (verdict === "wrong") { wrong++; wrongList.push(`${f.from} → ${f.to}（${f.rule}）`); } else if (verdict === "prefill") prefillOnly++; else unknown++;
  }
  console.log(`   直した名前の確かめ（同じ会話の資料・共有・スタッフの名前）: 正 ${ok}・誤（資料・共有に読んだ名前の方が出る）${wrong}・スタッフが読んだ名前のまま送った（先入れ）${prefillOnly}・分からない ${unknown}`);
  for (const w of wrongList.slice(0, 30)) console.log(`   ✗ ${w}`);
  console.log(`\n■ 直した例（${Math.min(SHOW, fixedList.length)}/${fixedList.length}）`);
  for (const f of fixedList.slice(0, SHOW)) console.log(`   ${f.from} → ${f.to}  [${f.rule}] ${verdictOf.get(f.from)}`);
  console.log(`\n■ 確かではない例（${Math.min(SHOW, uncertainList.length)}/${uncertainList.length}）`);
  for (const u of uncertainList.slice(0, SHOW)) console.log(`   ${u}`);
  void parseLoose;
}
main().catch((e) => { console.error(e); process.exit(1); });
