// 条件の復唱の手直し（app/lib/condition-echo-polish.ts）の全件監査（読み取りのみ・LLM は呼ばない）
//
// 2026-10-01 竹内「初回返信の条件を読み直すところ…スタッフが改善しているところ多いから、その点も実際のLINEを見て改善する」
//
// A. 下書き×実送信（ai_reply_examples）: 下書きに polishConditionEcho を当てて、実送信に近づいた／同じ／遠ざかったを数える
//    （近さ＝文字の編集距離。ピックアップの文を持つ組だけ。entry_source ごと・初回（はじめまして）ごと）
// B. 人が書いた実送信（messages・AI の下書きのまま送った通と AIX を除く）に当てて、変わってしまう通を全部出す
//    （人の文が正解なので、ここで変わる通は誤変換の候補。目で読む）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-echo-polish.ts [DAYS=400] [SHOW=1] [ZENIKI=0]
import { createClient } from "@supabase/supabase-js";
import { polishConditionEcho, areaTailOf, ZENIKI_KINDS } from "../app/lib/condition-echo-polish";
// 2026-10-01 竹内さんの決定で①「全域」は既定 ON。ZENIKI=0 で外して測る。AIX の組は報告の文にも当てる（aix/action と同じ）
const OPTS = process.env.ZENIKI === "0" ? { zenikiKinds: new Set<never>() } : {};
void ZENIKI_KINDS;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 400);
const SHOW = process.env.SHOW === "1";
const strip = (s: string) => (s ?? "").replace(/<<<FINAL_CHECK:[\s\S]*?>>>/g, "").trim();
const norm = (s: string) => (s ?? "").replace(/\s+/g, "");
// 名前の伏せ字はしない（前の版の伏せ字は前の文字まで食べて文が読めなかった）。コンソールに出すだけ
const mask = (s: string) => s.replace(/\n/g, " ／ ");

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const pickSent = (t: string) => t.split(/\n|(?<=[！!。])(?=[^！!。])/).map((s) => s.trim()).find((x) => /ピックアップ/.test(x) && /から/.test(x)) ?? null;

async function all(table: string, select: string, build: (q: any) => any) {
  const out: any[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(sb.from(table).select(select)).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const ex = await all("ai_reply_examples", "id, ai_draft, sent_reply, entry_source, created_at",
    (q) => q.not("ai_draft", "is", null).not("sent_reply", "is", null).gte("created_at", since).order("created_at", { ascending: false }));
  const pairs = ex.map((r) => ({ ...r, ai_draft: strip(r.ai_draft), sent_reply: strip(r.sent_reply) }))
    .filter((r) => pickSent(r.ai_draft) && pickSent(r.sent_reply));

  console.log(`=== A. 下書き×実送信 ピックアップの文を持つ ${pairs.length}組（${DAYS}日）===`);
  type B = { n: number; changed: number; closer: number; same: number; farther: number };
  const buckets = new Map<string, B>();
  const ruleTally = new Map<string, { closer: number; same: number; farther: number }>();
  const showRows: string[] = [];
  for (const r of pairs) {
    const touched = pickSent(r.ai_draft) !== pickSent(r.sent_reply);
    const group = `${r.entry_source === "line_reply" ? "返信生成" : "AIX"}${/はじめまして/.test(r.sent_reply) ? "・初回" : ""}${touched ? "・直した" : "・そのまま"}`;
    const b = buckets.get(group) ?? { n: 0, changed: 0, closer: 0, same: 0, farther: 0 };
    b.n++;
    const p = polishConditionEcho(r.ai_draft, { ...OPTS, includeReports: r.entry_source !== "line_reply" });
    if (p.applied.length) {
      b.changed++;
      // 近さはピックアップの文どうしで測る（他の段落の書き直しに埋もれない）
      const d0 = lev(pickSent(r.ai_draft)!, pickSent(r.sent_reply)!);
      const d1 = lev(pickSent(p.text) ?? p.text, pickSent(r.sent_reply)!);
      const v = d1 < d0 ? "closer" : d1 > d0 ? "farther" : "same";
      b[v]++;
      for (const a of p.applied) {
        const k = `${a.replace(/×\d+$/, "")}${touched ? "（直した組）" : "（そのまま組）"}`;
        const t = ruleTally.get(k) ?? { closer: 0, same: 0, farther: 0 }; t[v]++; ruleTally.set(k, t);
      }
      if (SHOW || v === "farther") showRows.push(`[${v}] ${group} ${String(r.created_at).slice(0, 10)} ${p.applied.join(",")}\n   下書き: ${mask(pickSent(r.ai_draft)!)}\n   手直し: ${mask(pickSent(p.text) ?? "")}\n   実送信: ${mask(pickSent(r.sent_reply)!)}`);
    }
    buckets.set(group, b);
  }
  for (const [g, b] of [...buckets.entries()].sort()) console.log(`   ${g.padEnd(10)} 組${String(b.n).padStart(4)}  変わる${String(b.changed).padStart(4)}  近づく${String(b.closer).padStart(4)}  同じ${String(b.same).padStart(3)}  遠ざかる${String(b.farther).padStart(3)}`);
  console.log(`\n   規則ごと（近づく/同じ/遠ざかる）`);
  for (const [k, t] of ruleTally) console.log(`     ${k.padEnd(22)} ${t.closer}/${t.same}/${t.farther}`);

  console.log(`\n=== B. 人が書いた実送信（AI の下書きのまま・AIX を除く）に当てて変わる通 ===`);
  const drafts = new Set(pairs.map((p) => norm(p.ai_draft)));
  const msgs = await all("messages", "text, is_aix_generated, created_at",
    (q) => q.eq("sender", "staff").gte("created_at", since).ilike("text", "%ピックアップ%"));
  const human = msgs.filter((m) => m.text && !m.is_aix_generated && !drafts.has(norm(m.text)) && pickSent(m.text));
  let changed = 0;
  const byRule = new Map<string, number>();
  const hRows: string[] = [];
  for (const m of human) {
    const p = polishConditionEcho(m.text, OPTS);
    if (!p.applied.length) continue;
    changed++;
    for (const a of p.applied) { const k = a.replace(/×\d+$/, ""); byRule.set(k, (byRule.get(k) ?? 0) + 1); }
    hRows.push(`   ${String(m.created_at).slice(0, 10)} ${p.applied.join(",")}\n     前: ${mask(pickSent(m.text)!)}\n     後: ${mask(pickSent(p.text) ?? "")}`);
  }
  console.log(`   人の文 ${human.length}通 → 変わる ${changed}通`);
  for (const [k, n] of byRule) console.log(`     ${k.padEnd(22)} ${n}`);
  console.log(hRows.join("\n"));

  console.log(`\n=== C. 人の文の「から」の前の終わり方ごとの 全域あり／なし（これからの宣言の文）===`);
  const tails = new Map<string, { yes: number; no: number }>();
  for (const m of human) {
    const sent = pickSent(m.text)!;
    if (/(?:させて|して)(?:頂き|いただき)ました|致しました|いたしました/.test(sent)) continue;
    const t = areaTailOf(sent); if (!t) continue;
    const k = `${/はじめまして/.test(m.text) ? "初回" : "以降"}・${t.kind}`;
    const b = tails.get(k) ?? { yes: 0, no: 0 }; if (t.hasZeniki) b.yes++; else b.no++; tails.set(k, b);
  }
  for (const [k, b] of [...tails.entries()].sort()) console.log(`   ${k.padEnd(10)} 全域あり ${String(b.yes).padStart(3)} ／ なし ${String(b.no).padStart(3)}  (${Math.round(b.yes / (b.yes + b.no) * 100)}%)`);

  console.log(`\n=== A の実物（${SHOW ? "全部" : "遠ざかった物だけ"}）===`);
  console.log(showRows.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
