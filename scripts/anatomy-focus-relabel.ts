// scripts/anatomy-focus-relabel.ts — 竹内さんの解剖の重点（anatomy.focus）を、今の決まり（ANATOMY_SYSTEM_FOCUS）で選んだ番だけ読み直す（作業員5・11/07）
//   統括役（重点の外れの表）: 正解の札の揺れ3つを決まりで直した後、その番を付け直して前後を並べる。既定は書かない（--apply で anatomy.focus と background だけ上書き）。
//   テストの決まり（memory/test_protocol_brain.md）: setupLlmTest を最初に・LLM_TEST_MODE=deepseek-all。材料は伏せ済みの body・customer_gist と状況の文 v2 だけ。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=<サーバーの鍵のある .env> scripts/anatomy-focus-relabel.ts --ids=<id,... のファイル> [--out=<id:focus,... のファイル>] [--apply]
import { readFileSync, writeFileSync } from "node:fs";
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const h = await setupLlmTest("anatomy-focus-relabel");
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    const { sumoraLlmMarks } = await import("../app/lib/llm-usage-recorder");
    const A = await import("../app/lib/takeuchi-anatomy");
    h.assertYuma(YUMA_CONVERSATION_ID, "解剖の重点の付け直し");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    // 11/10: --pick=N なら、まだ多数の札の無い（focus_votes が無い）行から場面×趣旨で偏りなく N 行を選ぶ（--ids の代わり）
    let ids: string[];
    if (Number(arg("pick", "0")) > 0) {
      const { data, error } = await sb.from("takeuchi_compose_examples").select("message_id, scene, purpose, sent_at, anatomy").not("anatomy", "is", null).order("sent_at", { ascending: false }).range(0, 2999);
      if (error) throw new Error(error.message);
      const pool = ((data ?? []) as Array<{ message_id: string; scene: string; purpose: string; sent_at: string; anatomy: Record<string, unknown> | null }>).filter((r) => r.anatomy && !Array.isArray(r.anatomy.focus_votes));
      ids = A.pickBalanced(pool, Number(arg("pick"))).map((r) => r.message_id);
      console.log(`選んだ ${ids.length}行（多数の札の無い ${pool.length}行から・場面×趣旨で偏りなく）`);
    } else ids = [...new Set(readFileSync(arg("ids"), "utf8").trim().split(",").filter(Boolean))];
    type Row = { message_id: string; scene: string; body: string; customer_gist: string | null; anatomy: Record<string, unknown> | null };
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("takeuchi_compose_examples").select("message_id, scene, body, customer_gist, anatomy").in("message_id", ids.slice(i, i + 100));
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Row[]));
    }
    const sit = new Map<string, string>();
    for (let i = 0; i < rows.length; i += 100) {
      const { data } = await sb.from("conductor_turn_vectors").select("source_key, situation_v2").in("source_key", rows.slice(i, i + 100).map((r) => `msg:${r.message_id}`)).not("situation_v2", "is", null);
      for (const x of (data ?? []) as Array<{ source_key: string; situation_v2: string }>) sit.set(x.source_key.slice(4), x.situation_v2);
    }
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    const out: Array<{ id: string; before: string | null; after: string | null; bg: string | null }> = [];
    // 11/10: --votes=N で重点を N 回読み、多数（majorityFocus）を札にする。--apply は多数の札・focus_votes・割れた番の印（:focus_split）を書く。
    //   --cap-usd で費用の見込み（1回 $0.0007・11/10 の実測は 1,113回で約 $0.59＝$0.00053/回。同じ時刻に別の付け直しが同じ名札で約1,000回流れていて記録が2倍に見えた）が上限に届いたら止める
    const votes = Math.max(1, Math.min(5, Number(arg("votes", "1")) || 1));
    const capUsd = Number(arg("cap-usd", "0")) || 0;
    let calls = 0;
    const askOnce = async (r: Row) => {
      calls++;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("reply_anatomy", YUMA_CONVERSATION_ID) },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 650, system: A.ANATOMY_SYSTEM_FOCUS, messages: [{ role: "user", content: A.anatomyPrompt({ maskedCustomer: r.customer_gist, maskedBody: r.body, scene: r.scene, situation: sit.get(r.message_id) ?? null }) }] }),
      });
      if (!res.ok) return null;
      const d = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return A.parseAnatomy(d.content?.find((b) => b.type === "text")?.text ?? "", { fallbackPurpose: "inform" }) as ({ focus?: string | null; background?: string | null } | null);
    };
    const readOne = async (r: Row) => {
      const as = await Promise.all(Array.from({ length: votes }, () => askOnce(r).catch(() => null)));
      const m = votes > 1 ? A.majorityFocus(as.map((a) => a?.focus ?? null)) : { focus: as[0]?.focus ?? null, votes: as[0]?.focus ? [as[0].focus] : [], split: false };
      const after = m.focus;
      const bg = as.find((a) => a?.focus === after)?.background ?? as[0]?.background ?? null;
      out.push({ id: r.message_id, before: (r.anatomy?.focus as string | undefined) ?? null, after, bg });
      if (process.argv.includes("--apply") && r.anatomy && (after || m.split)) {
        const patch: Record<string, unknown> = { anatomy: { ...r.anatomy, focus: after, background: bg ?? r.anatomy.background ?? null, ...(votes > 1 ? { focus_votes: m.votes } : {}) } };
        if (m.split) patch.anatomy_model = `reply_anatomy:relabel:focus_split`;
        const up = await sb.from("takeuchi_compose_examples").update(patch).eq("message_id", r.message_id);
        if (up.error) throw new Error(up.error.message);
      }
    };
    for (let i = 0; i < rows.length; i += 5) {
      if (capUsd && (calls + 5 * votes) * 0.0007 > capUsd) { console.log(`費用の上限 $${capUsd} の見込みで止めた（${i}/${rows.length}番）`); break; }
      await Promise.all(rows.slice(i, i + 5).map(readOne));
    }
    const changed = out.filter((o) => o.before !== o.after);
    const dirs = changed.reduce<Record<string, number>>((m, o) => { const k = `${o.before}→${o.after}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
    console.log(`# 解剖の重点の付け直し: ${out.length}番・変わった ${changed.length}（${Object.entries(dirs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}）${process.argv.includes("--apply") ? "・DB に書いた" : "・書いていない"}`);
    if (arg("out")) writeFileSync(arg("out"), out.filter((o) => o.after).map((o) => `${o.id}:${o.after}`).join(","));
    if (arg("json")) writeFileSync(arg("json"), JSON.stringify(out, null, 1));
  } finally { await h.finish(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
