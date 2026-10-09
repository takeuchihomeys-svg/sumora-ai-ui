// scripts/audit-r12-omatase-gap.ts — 「お待たせ致しました」を竹内さんが**何からどれだけ空いた時**に書くか（読むだけ・LLM なし）
//
// 2026-10-08 竹内「3時間にする。何時間が良いかな？」: 今の決まり（AIX は前の文から3時間以上空いた時だけ）を維持しつつ、
//   竹内さんの実送信（messages.staff_writer='takeuchi'・全期間・AIX と手打ち）で、経過時間ごとの使用率を出し、
//   竹内さんの使い方を一番よく説明する時間の線と基準（何からの経過か）を探す。
//
// 単位: 竹内さんの「送信のかたまり」（こちらの送信が 10分以内で続く束）の中の、文の通（8字超・画像なし）のうち
//   ① かたまりの最初の文の通（AIX／手打ち）
//   ② AIX の直後の手打ちの2通目（同じかたまりの中・AIX の後の最初の手打ち）＝「見積書の2通目」等
// 基準（経過の起点）:
//   prev_any   = かたまりの前の最後の通（お客様／こちら どちらでも）＝「前の文」
//   prev_cust  = かたまりの前の最後のお客様の発言
//   prev_staff = かたまりの前の最後のこちらの送信
//   promise    = かたまりの前の最後のこちらの約束（確認します／出来次第ご連絡 等・7日以内）
// 実行: npx tsx --env-file=.env.local scripts/audit-r12-omatase-gap.ts [--show=20]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=0").split("=")[1]);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
const ms = (s: string) => Date.parse(s);
/** 冒頭（最初の2行）の「お待たせ」 */
const WAITED_HEAD = /^(?:[^\n]{0,24}\n)?[^\n]{0,24}お待たせ(?:致|いた)?し(?:ました|ております)/;
const PROMISE_RE = /(?:次第|でき次第|出来次第)[^\n]{0,14}(?:ご連絡|ご案内|お送り|ご報告)|確認(?:させて頂き|させていただき|いたし|致し|し)ます|お調べ(?:させて頂き|させていただき|いたし|致し|し)ます|ピックアップ(?:させて頂き|させていただき|いたし|致し|し)ます|お探し(?:させて頂き|させていただき|いたし|致し|し)ます|(?:お見積|御見積)[^\n]{0,10}(?:作成|お作り)/;
const BURST_MS = 10 * 60_000;
type M = { conversation_id: string; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null; text: string | null; sender: string; image_url: string | null };
const isResult = (u: { kind: string; aix: string }) => (u.kind.startsWith("AIX（") && (u.aix === "property_send" || u.aix === "property_check_result")) || (u.kind.startsWith("AIX の直後") && u.aix === "estimate_sheet");
type U = { kind: string; aix: string; waited: boolean; g: Record<string, number | null>; text: string; at: string; conv: string };

const BINS: Array<[number, string]> = [[15, "〜15分"], [30, "15〜30分"], [60, "30分〜1時間"], [120, "1〜2時間"], [180, "2〜3時間"], [240, "3〜4時間"], [360, "4〜6時間"], [720, "6〜12時間"], [1440, "12〜24時間"], [Infinity, "1日〜"]];
const binOf = (min: number) => BINS.find(([u]) => min < u)![1];
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

(async () => {
  const tk = await readAll((f, t) => sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").order("created_at").range(f, t));
  const convs = [...new Set(tk.map((r) => r.conversation_id as string))];
  const msgs: M[] = [];
  for (let i = 0; i < convs.length; i += 80) msgs.push(...await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated, text, sender, image_url").in("conversation_id", convs.slice(i, i + 80)).order("created_at").range(f, t)));
  const logs: any[] = [];
  for (let i = 0; i < convs.length; i += 80) logs.push(...await readAll((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").in("conversation_id", convs.slice(i, i + 80)).order("created_at").range(f, t)));
  const logBy = new Map<string, any[]>(); for (const l of logs) { if (!logBy.has(l.conversation_id)) logBy.set(l.conversation_id, []); logBy.get(l.conversation_id)!.push(l); }
  const by = new Map<string, M[]>(); for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const aixTypeOf = (conv: string, at: number) => {
    const c = (logBy.get(conv) ?? []).filter((l) => Math.abs(ms(l.created_at) - at) < 15 * 60_000).sort((a, b) => Math.abs(ms(a.created_at) - at) - Math.abs(ms(b.created_at) - at));
    return c[0]?.aix_type ?? "?";
  };
  const isText = (m: M) => !m.image_url && (m.text ?? "").trim().length > 8;
  const units: U[] = [];
  for (const [conv, arr] of by) {
    arr.sort((a, b) => ms(a.created_at) - ms(b.created_at));
    let i = 0;
    while (i < arr.length) {
      if (arr[i].sender === "customer") { i++; continue; }
      // かたまり
      let j = i; while (j + 1 < arr.length && arr[j + 1].sender !== "customer" && ms(arr[j + 1].created_at) - ms(arr[j].created_at) <= BURST_MS) j++;
      const burst = arr.slice(i, j + 1);
      const start = ms(burst[0].created_at);
      const before = arr.slice(0, i);
      const lastAny = before[before.length - 1];
      const lastCust = [...before].reverse().find((m) => m.sender === "customer");
      const lastStaff = [...before].reverse().find((m) => m.sender !== "customer");
      const lastPromise = [...before].reverse().find((m) => m.sender !== "customer" && PROMISE_RE.test(m.text ?? "") && start - ms(m.created_at) < 7 * 86400_000);
      const g = {
        prev_any: lastAny ? (start - ms(lastAny.created_at)) / 60_000 : null,
        prev_cust: lastCust ? (start - ms(lastCust.created_at)) / 60_000 : null,
        prev_staff: lastStaff ? (start - ms(lastStaff.created_at)) / 60_000 : null,
        promise: lastPromise ? (start - ms(lastPromise.created_at)) / 60_000 : null,
      };
      const texts = burst.filter(isText);
      const first = texts[0];
      if (first && first.staff_writer === "takeuchi") {
        units.push({ kind: first.is_aix_generated ? "AIX（かたまりの最初）" : "手打ち（かたまりの最初）", aix: first.is_aix_generated ? aixTypeOf(conv, ms(first.created_at)) : "", waited: WAITED_HEAD.test(first.text ?? ""), g, text: first.text ?? "", at: first.created_at, conv });
      }
      // AIX の直後の手打ちの2通目
      const aixIdx = burst.findIndex((m) => m.is_aix_generated);
      if (aixIdx >= 0) {
        const second = burst.slice(aixIdx + 1).find((m) => isText(m) && !m.is_aix_generated);
        const aixWaited = burst.slice(0, aixIdx + 1).some((m) => /お待たせ/.test(m.text ?? ""));
        if (second && second.staff_writer === "takeuchi" && second !== first) {
          units.push({ kind: `AIX の直後の2通目（AIX の文に「お待たせ」${aixWaited ? "あり" : "なし"}）`, aix: aixTypeOf(conv, ms(burst[aixIdx].created_at)), waited: WAITED_HEAD.test(second.text ?? ""), g, text: second.text ?? "", at: second.created_at, conv });
        }
      }
      i = j + 1;
    }
  }
  console.log(`竹内さんの会話 ${convs.length}・通 ${msgs.length}・単位 ${units.length}（「お待たせ」 ${units.filter((u) => u.waited).length}）\n`);
  const groups: Array<[string, (u: U) => boolean]> = [
    ["全部", () => true],
    ["AIX（かたまりの最初）", (u) => u.kind.startsWith("AIX（")],
    ["手打ち（かたまりの最初）", (u) => u.kind.startsWith("手打ち")],
    ["AIX の直後の2通目（全部）", (u) => u.kind.startsWith("AIX の直後")],
    ["見積書の2通目", (u) => u.kind.startsWith("AIX の直後") && u.aix === "estimate_sheet"],
    ["結果を届ける場面（AIX 物件ピックアップした・物件確認した の1通目＋見積書の2通目）", isResult],
  ];
  for (const [gname, f] of groups) {
    const us = units.filter(f);
    console.log(`\n■ ${gname}: ${us.length}件・「お待たせ」 ${us.filter((u) => u.waited).length}（${pct(us.filter((u) => u.waited).length, us.length)}）`);
    for (const basis of ["prev_any", "prev_cust", "prev_staff", "promise"]) {
      const row: string[] = [];
      for (const [, label] of BINS) {
        const b = us.filter((u) => u.g[basis] != null && binOf(u.g[basis]!) === label);
        row.push(`${label} ${b.filter((u) => u.waited).length}/${b.length}(${pct(b.filter((u) => u.waited).length, b.length)})`);
      }
      const none = us.filter((u) => u.g[basis] == null);
      console.log(`  [${basis}] ${row.join("｜")}｜起点なし ${none.filter((u) => u.waited).length}/${none.length}`);
    }
    // 線ごとの説明力（「線以上なら書く」で竹内さんの書く/書かないを何%当てるか・F1）
    for (const basis of ["prev_any", "prev_cust", "prev_staff", "promise"]) {
      const out: string[] = [];
      let best = { t: 0, acc: 0, f1: 0 };
      for (const th of [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12, 24]) {
        let tp = 0, fp = 0, fn = 0, tn = 0;
        for (const u of us) { const v = u.g[basis]; const pred = v != null && v >= th * 60; if (pred && u.waited) tp++; else if (pred) fp++; else if (u.waited) fn++; else tn++; }
        const acc = (tp + tn) / Math.max(1, us.length); const prec = tp / Math.max(1, tp + fp); const rec = tp / Math.max(1, tp + fn); const f1 = (2 * prec * rec) / Math.max(1e-9, prec + rec);
        if (f1 > best.f1) best = { t: th, acc, f1 };
        out.push(`${th}h 当て${Math.round(acc * 100)}% 適合${Math.round(prec * 100)}% 再現${Math.round(rec * 100)}% F1 ${f1.toFixed(2)}`);
      }
      console.log(`  線[${basis}] 最良 F1 ${best.t}h（${best.f1.toFixed(2)}・当て${Math.round(best.acc * 100)}%）｜ ${out.join(" / ")}`);
    }
    // AIX の種類ごと
    if (gname.startsWith("AIX")) {
      const types = new Map<string, U[]>(); for (const u of us) { if (!types.has(u.aix)) types.set(u.aix, []); types.get(u.aix)!.push(u); }
      for (const [t, a] of [...types].sort((x, y) => y[1].length - x[1].length).slice(0, 12)) {
        const w = a.filter((u) => u.waited);
        const lt3 = a.filter((u) => (u.g.prev_any ?? Infinity) < 180); const ge3 = a.filter((u) => (u.g.prev_any ?? Infinity) >= 180);
        console.log(`    ${t}: ${w.length}/${a.length}（${pct(w.length, a.length)}）｜前の文から3時間未満 ${lt3.filter((u) => u.waited).length}/${lt3.length}・以上 ${ge3.filter((u) => u.waited).length}/${ge3.length}`);
      }
    }
  }
  // 約束の有無 × 前の文から3時間
  console.log("\n■ 約束（7日以内）の有無 × 前の文からの経過（AIX の最初＋2通目）");
  const ax = units.filter((u) => u.kind.startsWith("AIX"));
  for (const p of [true, false]) for (const lt of [true, false]) {
    const a = ax.filter((u) => (u.g.promise != null) === p && ((u.g.prev_any ?? Infinity) < 180) === lt);
    console.log(`  約束${p ? "あり" : "なし"}・前の文から${lt ? "3時間未満" : "3時間以上"}: ${a.filter((u) => u.waited).length}/${a.length}（${pct(a.filter((u) => u.waited).length, a.length)}）`);
  }
  console.log("\n■ 前の最後の通がお客様か・こちらか（AIX の最初＋2通目）");
  for (const who of ["customer", "staff"]) {
    const a = ax.filter((u) => u.g.prev_any != null && ((u.g.prev_cust === u.g.prev_any) === (who === "customer")));
    for (const lt of [true, false]) { const b = a.filter((u) => (u.g.prev_any! < 180) === lt); console.log(`  前の通=${who === "customer" ? "お客様" : "こちら"}・${lt ? "3時間未満" : "3時間以上"}: ${b.filter((u) => u.waited).length}/${b.length}（${pct(b.filter((u) => u.waited).length, b.length)}）`); }
  }
  // 結果を届ける場面: お客様の最後の発言が同じ日（JST）か・24時間以内の約束があるか
  console.log("\n■ 結果を届ける場面 × お客様の最後の発言が同じ日か／約束");
  const jd = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
  const rs = units.filter(isResult);
  const sameDayCust = (u: U) => u.g.prev_cust != null && jd(ms(u.at)) === jd(ms(u.at) - u.g.prev_cust * 60_000);
  const promise24 = (u: U) => u.g.promise != null && u.g.promise < 1440;
  const line = (label: string, a: U[]) => console.log(`  ${label}: ${a.filter((u) => u.waited).length}/${a.length}（${pct(a.filter((u) => u.waited).length, a.length)}）`);
  for (const s of [true, false]) line(`お客様の最後の発言が${s ? "同じ日" : "前の日以前"}`, rs.filter((u) => sameDayCust(u) === s));
  for (const p of [true, false]) line(`24時間以内の約束${p ? "あり" : "なし"}`, rs.filter((u) => promise24(u) === p));
  for (const p of [true, false]) for (const s of [true, false]) line(`約束24h${p ? "あり" : "なし"}・お客様の発言${s ? "同じ日" : "前の日以前"}`, rs.filter((u) => promise24(u) === p && sameDayCust(u) === s));
  for (const [lo, hi, lab] of [[0, 180, "前の文から3時間未満"], [180, 1440, "3〜24時間"], [1440, Infinity, "24時間以上"]] as const) line(`結果の場面・${lab}`, rs.filter((u) => (u.g.prev_any ?? Infinity) >= lo && (u.g.prev_any ?? Infinity) < hi));
  if (SHOW) {
    console.log("\n■ 例（AIX の2通目で3時間未満の「お待たせ」）");
    for (const u of units.filter((u) => u.kind.startsWith("AIX の直後") && u.waited && (u.g.prev_any ?? 0) < 180).slice(0, SHOW))
      console.log(`  ${u.at.slice(0, 16)} ${u.aix} 前の文${Math.round(u.g.prev_any!)}分・客${u.g.prev_cust == null ? "-" : Math.round(u.g.prev_cust)}分・約束${u.g.promise == null ? "-" : Math.round(u.g.promise)}分｜${u.text.replace(/\n/g, "⏎").slice(0, 70)}`);
  }
})();
