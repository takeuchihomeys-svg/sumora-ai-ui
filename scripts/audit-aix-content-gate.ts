// scripts/audit-aix-content-gate.ts — AIX の中身の言い切り（aix-content-gate.ts）の監査（LLM なし・読むだけ）
//   竹内さんの手打ち（AIX でない・120日）と AI の返信の下書き（ai_reply_examples・aix_action/template なし）に当て、型×AIX の鍵ごとに数える。
//   AI の下書きの当たりは、スタッフの実送信に同じ型があったか（kept）／消したか（removed）も数える。出口の書き換え（OUTLET_REWRITE_KINDS）を足す前に必ず流す
//   実行: npx tsx --env-file=.env.local scripts/audit-aix-content-gate.ts <出力ファイル>
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { classifyAixContent } from "../app/lib/aix-content-gate";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const OUT = process.argv[2];
async function all(q: (f: number, t: number) => any) { const o: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; o.push(...r.data); if (r.data.length < 1000) break; } return o; }
(async () => {
  const since = new Date(Date.now() - 120 * 864e5).toISOString();
  const tk = await all((f, t) => sb.from("messages").select("conversation_id, created_at, text").eq("sender", "staff").eq("staff_writer", "takeuchi").eq("is_aix_generated", false).gte("created_at", since).order("created_at").range(f, t));
  const ex = await all((f, t) => sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft, sent_reply, aix_action, template_id").not("ai_draft", "is", null).is("aix_action", null).is("template_id", null).gte("created_at", since).range(f, t));
  const cids = [...new Set([...tk, ...ex].map((r: any) => r.conversation_id).filter(Boolean))];
  const by = new Map<string, any[]>();
  for (let i = 0; i < cids.length; i += 40) {
    const part = await all((f, t) => sb.from("messages").select("conversation_id, created_at, text").in("conversation_id", cids.slice(i, i + 40)).gte("created_at", new Date(Date.now() - 200 * 864e5).toISOString()).order("created_at").range(f, t));
    for (const m of part) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  }
  const ground = (cid: string, at: string) => (by.get(cid) ?? []).filter((m) => m.created_at < at).slice(-30).map((m) => m.text ?? "").join("\n");
  const run = (label: string, rows: Array<{ cid: string; at: string; text: string }>) => {
    const cnt: Record<string, { hit: number; grounded: number }> = {}; const samples: string[] = []; let msgs = 0;
    for (const r of rows) {
      const hits = classifyAixContent(r.text, ground(r.cid, r.at)); if (hits.length) msgs++;
      for (const h of hits) { const k = `${h.kind}→${h.catalogKey}`; cnt[k] ??= { hit: 0, grounded: 0 }; cnt[k].hit++; if (h.grounded) cnt[k].grounded++; if (!h.grounded) samples.push(`[${label}] ${k} | ${h.sentence.slice(0, 120)}`); }
    }
    return { label, rows: rows.length, msgs, cnt, samples };
  };
  const a = run("竹内手打ち", tk.map((m: any) => ({ cid: m.conversation_id, at: m.created_at, text: m.text ?? "" })));
  const b = run("AI下書き", ex.map((e: any) => ({ cid: e.conversation_id, at: e.created_at, text: e.ai_draft ?? "" })));
  let kept = 0, removed = 0; const remS: string[] = [];
  for (const e of ex) { const hs = classifyAixContent(e.ai_draft ?? "", ground(e.conversation_id, e.created_at)).filter((h) => !h.grounded); if (!hs.length || !e.sent_reply) continue;
    const sk = new Set(classifyAixContent(e.sent_reply, ground(e.conversation_id, e.created_at)).map((h) => h.kind));
    for (const h of hs) { if (sk.has(h.kind)) kept++; else { removed++; remS.push(h.kind + " | " + h.sentence.slice(0, 100)); } } }
  console.log("AI下書きの未引用の当たり: スタッフも同じ型を送った", kept, "／スタッフが消した", removed);
  writeFileSync(OUT + ".removed.txt", remS.join("\n"));
  writeFileSync(OUT, JSON.stringify({ a: { ...a, samples: undefined }, b: { ...b, samples: undefined } }, null, 1) + "\n\n" + [...a.samples, ...b.samples].join("\n"));
  console.log(JSON.stringify({ a: [a.rows, a.msgs, a.cnt], b: [b.rows, b.msgs, b.cnt] }));
})();
