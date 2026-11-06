// scripts/conductor-replan-replay.ts — #8 B の確かめ（作業員5・11/07・書き込みなし）
//   竹内さんの番で2通目が来た番（送る前に「最初の通だけ見たブレイン」と「全部見たブレイン」の判断が残る 120番）について、
//   入口の統括の重点の読み（表→背景→重点）を「最初の通だけ」と「全部」で2回読み、重点が同じなら前の判断を残す（B）・違えば全部見た判断を使う、
//   として、今（いつも全部見た判断）より竹内さんの道（返信か AIX か）に合うかを数える。決めるのは重点の読み（LLM）・道の判断は記録のまま。
//   テストの決まり: memory/test_protocol_brain.md（LLM_TEST_MODE=deepseek-all・入口 setupLlmTest・会話の id は YUMA・材料は伏せる）。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/conductor-replan-replay.ts --list=<bursts.txt> [--max=120]
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const h = await setupLlmTest("conductor-replan-replay");
  try {
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    const { sumoraLlmMarks } = await import("../app/lib/llm-usage-recorder");
    const F = await import("../app/lib/conductor-focus");
    const { maskPII } = await import("../app/lib/pii-mask");
    const { customerNameTokens, maskCustomerNames } = await import("../app/lib/compose-name-mask");
    const { maskContactBits } = await import("../app/lib/conductor-turn-vectors");
    h.assertYuma(YUMA_CONVERSATION_ID, "立て直しの解き直し");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
    const rows = readFileSync(arg("list"), "utf8").trim().split(";").map((x) => { const [c, fa, sa, at, bits] = x.split("|"); return { c, fa, sa, at, f: bits[0] === "1", l: bits[1] === "1", tk: bits[2] === "1" }; }).slice(0, Number(arg("max", "120")));
    const system = [
      "あなたは賃貸の仲介会社の LINE 返信の「入口の統括」です。お客様の今の番を最初に読み、この番の重点を決めます。返信の文は書きません。",
      "【絶対の決まり】スタッフだけが知る事（確認の結果・募集状況・見積の金額・内覧の日程の確定）は AIX で送る番。返信は AI が知り得る事だけ。",
      F.FOCUS_INTAKE_RULES, `JSON だけを返す: {${F.FOCUS_INTAKE_FIELD}}`,
    ].join("\n\n");
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    const ask = async (user: string) => {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("conductor_intake", YUMA_CONVERSATION_ID) },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 300, system, messages: [{ role: "user", content: user }] }) });
      if (!r.ok) return null;
      const d = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      const m = (d.content?.find((b) => b.type === "text")?.text ?? "").match(/\{[\s\S]*\}/);
      try { return m ? F.parseFocusRead(JSON.parse(m[0])) : null; } catch { return null; }
    };
    const out: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      const [{ data: msgs }, { data: conv }] = await Promise.all([
        sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.c).gte("created_at", new Date(Date.parse(r.fa) - 7 * 86_400_000).toISOString()).lt("created_at", r.at).order("created_at", { ascending: true }).limit(400),
        sb.from("conversations").select("customer_name").eq("id", r.c).maybeSingle(),
      ]);
      const tokens = customerNameTokens([(conv as { customer_name?: string | null } | null)?.customer_name ?? null]);
      const mask = (t: string) => maskContactBits(maskPII(maskCustomerNames(t, tokens)));
      const all = (msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string }>;
      const lastStaff = [...all].reverse().find((m) => m.sender !== "customer" && m.created_at < r.fa && (m.text ?? "").trim());
      const cust = all.filter((m) => m.sender === "customer" && m.created_at >= r.fa);
      const first = cust.filter((m) => m.created_at < r.sa).map((m) => mask(m.text ?? "")).join("\n");
      const full = cust.map((m) => mask(m.text ?? "")).join("\n");
      const ls = lastStaff ? `【直前のこちらの送信】\n${mask(lastStaff.text ?? "").slice(0, 400)}\n\n` : "";
      const [a, b] = await Promise.all([ask(`${ls}【お客様の今の番】\n${first.slice(0, 800)}`), ask(`${ls}【お客様の今の番】\n${full.slice(0, 800)}`)]);
      if (!a || !b) { out.push({ ...r, fail: true }); continue; }
      const same = a.focus === b.focus;
      const chosen = same ? r.f : r.l;
      out.push({ c: r.c.slice(0, 8), fa: r.fa, f: r.f, l: r.l, tk: r.tk, focusFirst: a.focus, focusFull: b.focus, same, now_ok: r.l === r.tk, b_ok: chosen === r.tk, first_ok: r.f === r.tk });
    }
    const ok = out.filter((x) => !x.fail);
    const n = ok.length, nowOk = ok.filter((x) => x.now_ok).length, bOk = ok.filter((x) => x.b_ok).length;
    const fixedNow = ok.filter((x) => !x.first_ok && x.now_ok).length, brokenNow = ok.filter((x) => x.first_ok && !x.now_ok).length;
    const fixedB = ok.filter((x) => !x.first_ok && x.b_ok).length, brokenB = ok.filter((x) => x.first_ok && !x.b_ok).length;
    const sameN = ok.filter((x) => x.same).length;
    const dir = join(process.cwd(), "..", "..", "exam-cache", "conductor-replan"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `replay-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(out, null, 1));
    console.log(`# 立て直しの解き直し: ${n}番（読めず ${out.length - n}）・重点が同じ ${sameN}番`);
    console.log(`  今（いつも全部見た判断）: 竹内さんと合う ${nowOk}/${n}・直った ${fixedNow}・崩れた ${brokenNow}`);
    console.log(`  B（重点が同じなら前の判断）: 竹内さんと合う ${bOk}/${n}・直った ${fixedB}・崩れた ${brokenB}`);
  } finally { await h.finish(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
