// scripts/audit-final-check-persist.ts — 最終チェックの「修正前→最後」で減らない種類を実物で読む（読み取りのみ・LLM なし）
//
// 2026-10-07 竹内「最終チェックはちゃんと機能しているか」（見張りの「最終チェックの段ごとの指摘（28日）」で
//   条件提示の RULE_VIOLATION 9→9・AIX property_send の RULE_VIOLATION 6→6・FABRICATED_NAME 5→5・質問の MISSED_QUESTION 4→4 等）
//
// 番ごとに、最後に残った指摘について:
//   ・引用（evidence）が下書きの本文にあるか（無ければ書き直しに渡らない＝no_passable の道）
//   ・書き直しの回数・結果
//   ・スタッフの実送信に引用が残ったか（直されずに届いた）
//   ・お客様の今の番の文
// を並べる。分類（誤発火／直せない／問題が出た）は目で読んで決める（--detail で全文）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-final-check-persist.ts [--days=28] [--code=RULE_VIOLATION] [--scene=条件] [--detail]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "28"));
const CODE = arg("code");
const SCENE = arg("scene");
const DETAIL = process.argv.includes("--detail");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "").replace(/[\s　！!。、「」『』…]+/g, "");
const one = (s: string, n = 160) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);

async function main() {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const turns: Row[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("line_watch_turns")
      .select("id, conversation_id, scene_key, customer_turn_at, customer_last_at, draft_first, draft_last, final_check, staff_texts, staff_aix, verdict, verdict_detail")
      .gte("customer_turn_at", since).not("final_check", "is", null).order("customer_turn_at").range(p * 1000, p * 1000 + 999);
    if (error) throw error;
    turns.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const rows = turns.filter((t) => t.conversation_id !== YUMA && !String(t.scene_key ?? "").startsWith("対象外"));
  // お客様の今の番の文
  //   PostgREST は1回 1000 行までなので番ごとに読む
  const custMap = new Map<number, string>();
  for (const r of rows) {
    const { data } = await sb.from("messages").select("text").eq("conversation_id", r.conversation_id).eq("sender", "customer")
      .gte("created_at", r.customer_turn_at).lte("created_at", r.customer_last_at ?? r.customer_turn_at).order("created_at").limit(20);
    custMap.set(r.id, (data ?? []).map((m) => m.text).join(" / "));
  }
  const custText = (r: Row) => custMap.get(r.id) ?? "";

  type Agg = { n: number; evInDraft: number; evAbsent: number; revised: number; staffKept: number; staffSent: number; samples: Row[] };
  const agg = new Map<string, Agg>();
  for (const r of rows) {
    const fc = r.final_check ?? {};
    const pre: string[] = Array.isArray(fc.pre) ? fc.pre : [];
    // 画面の印（__SHOWN__ 等）は本文ではない → 文の版を使う
    const pick = (x: unknown) => { const t = String(x ?? ""); return /^__\w+__$/.test(t.trim()) ? "" : t; };
    const draft = pick(r.draft_last) || pick(r.draft_first);
    const staff = (Array.isArray(r.staff_texts) ? r.staff_texts : []).map((x: Row) => typeof x === "string" ? x : x?.text ?? "").join("\n");
    for (const it of Array.isArray(fc.issues) ? fc.issues : []) {
      const code = String(it.code ?? "");
      if (CODE && code !== CODE) continue;
      if (SCENE && !String(r.scene_key ?? "").includes(SCENE)) continue;
      if (!pre.some((p) => p.startsWith(code + ":"))) continue; // 修正前にもあった＝減らなかった物
      const k = `${r.scene_key ?? "（場面なし）"}|${code}`;
      const a = agg.get(k) ?? { n: 0, evInDraft: 0, evAbsent: 0, revised: 0, staffKept: 0, staffSent: 0, samples: [] };
      a.n++;
      const ev = String(it.evidence ?? "");
      const inDraft = !!ev && norm(draft).includes(norm(ev).slice(0, 60));
      if (inDraft) a.evInDraft++; else a.evAbsent++;
      if (Number(fc.revision_count ?? 0) > 0) a.revised++;
      if (staff.trim()) { a.staffSent++; if (inDraft && norm(staff).includes(norm(ev).slice(0, 40))) a.staffKept++; }
      a.samples.push({ id: r.id, conv: r.conversation_id.slice(0, 8), at: r.customer_turn_at, cust: custText(r), ev, inDraft, draft, staff, rc: fc.revision_count, ro: fc.revision_outcome, verdict: r.verdict, aix: r.staff_aix });
      agg.set(k, a);
    }
  }
  // 2026-10-07 直しの当て直し（--sim）: 最後に残った RULE_VIOLATION のうち、final-check-staff-standard ②で外れる物と残る物
  if (process.argv.includes("--sim")) {
    const { isMissingElementRuleFlag } = await import("../app/lib/final-check-staff-standard");
    let drop = 0, keep = 0;
    for (const r of rows) {
      const pick = (x: unknown) => { const t = String(x ?? ""); return /^__\w+__$/.test(t.trim()) ? "" : t; };
      const d = norm(pick(r.draft_last) || pick(r.draft_first));
      for (const it of Array.isArray(r.final_check?.issues) ? r.final_check.issues : []) {
        if (it.code !== "RULE_VIOLATION") continue;
        const ev = String(it.evidence ?? "");
        const hit = isMissingElementRuleFlag(String(it.pass ?? ""), it.code, ev, !!ev && d.includes(norm(ev).slice(0, 60)));
        if (hit) drop++; else keep++;
        console.log(`${hit ? "外す" : "残す"} #${r.id} ${String(r.scene_key ?? "")} ${one(ev, 140)}`);
      }
    }
    console.log(`RULE_VIOLATION: 外す ${drop}・残す ${keep}\n`);
  }
  console.log(`=== 修正前にも最後にもある指摘（${DAYS}日・YUMA 除く・${rows.length}番） ===`);
  console.log("場面|code\t件\t引用が本文に有/無\t書き直した\tスタッフ送信あり/引用が残った");
  const sorted = [...agg].sort((a, b) => b[1].n - a[1].n);
  for (const [k, a] of sorted) console.log(`${k}\t${a.n}\t${a.evInDraft}/${a.evAbsent}\t${a.revised}\t${a.staffSent}/${a.staffKept}`);
  if (!DETAIL) return;
  for (const [k, a] of sorted) {
    console.log(`\n■ ${k}（${a.n}）`);
    for (const s of a.samples) {
      console.log(`- #${s.id} ${s.conv} ${s.at.slice(5, 16)} 書き直し${s.rc}/${s.ro} 見張り=${s.verdict}`);
      console.log(`  お客様: ${one(s.cust, 200)}`);
      console.log(`  指摘: ${one(s.ev, 260)}  [本文に${s.inDraft ? "有" : "無"}]`);
      console.log(`  下書き: ${one(s.draft, 400)}`);
      console.log(`  スタッフ: ${one(s.staff, 300) || "(文字なし)"}${s.aix ? ` AIX=${JSON.stringify(s.aix).slice(0, 80)}` : ""}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
