// scripts/audit-r8-form-first-reply.ts — 8巡目: 条件のフォーム・初回の返事で「初期費用も最大限割引…」の一文と「何卒」の締めが入るかを、お客様のフォームの中身で分ける（読むだけ・LLM なし）
//   入力: audit-r8-style-dump の --out（番の jsonl）。フォームの全文は messages から取り直す
// 実行: npx tsx --env-file=.env.local scripts/audit-r8-form-first-reply.ts --in=<turns.jsonl>
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%/${b}` : "-");
(async () => {
  const rows = readFileSync(arg("in", ""), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.at >= "2026-05-30" && r.sub === "conditions:条件のフォーム・初回" && ["hand", "edited", "asis"].includes(r.src));
  const out: any[] = [];
  for (const r of rows) {
    const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.cid).lt("created_at", r.at).gte("created_at", new Date(Date.parse(r.at) - 3 * 86_400_000).toISOString()).order("created_at");
    const cust = (data ?? []).filter((m: any) => m.sender === "customer").map((m: any) => m.text ?? "").join("\n");
    out.push({ ...r, form: cust });
  }
  const feats: Array<[string, (r: any) => boolean]> = [
    ["フォームに初期費用・費用を抑える", (r) => /初期費用|費用(?:を|は)?(?:抑|安)|安く|安い|お得|コスト/.test(r.form)],
    ["フォームに審査の不安", (r) => /審査|ブラック|滞納|自己破産|無職|保証人/.test(r.form)],
    ["本文200字〜", (r) => r.sLen >= 200],
    ["書き手A", (r) => r.w === "A"],
    ["下書きあり（直した・そのまま）", (r) => r.src !== "hand"],
    ["物件の名前・URL がフォームに", (r) => /https?:\/\/|号室|マンション|レジデンス/.test(r.form)],
    ["7月より前", (r) => r.at < "2026-07-01"],
  ];
  for (const key of ["shokiHiyou", "nanitozo"]) {
    console.log(`\n■ ${key} 全体 ${pct(out.filter((r) => r.t[key]).length, out.length)}`);
    for (const [n, f] of feats) { const a = out.filter(f), b = out.filter((r) => !f(r)); console.log(`  ${n}: はい ${pct(a.filter((r) => r.t[key]).length, a.length)}・いいえ ${pct(b.filter((r) => r.t[key]).length, b.length)}`); }
  }
  const both = out.filter((r) => r.t.shokiHiyou && r.t.nanitozo).length, oneS = out.filter((r) => r.t.shokiHiyou && !r.t.nanitozo).length, oneN = out.filter((r) => !r.t.shokiHiyou && r.t.nanitozo).length;
  console.log(`\n一緒に出るか: 両方 ${both}・一文だけ ${oneS}・何卒だけ ${oneN}・どちらもなし ${out.length - both - oneS - oneN}`);
  // 最後の文の形（何卒なしの時、何で締めるか）
  const ends = new Map<string, number>();
  for (const r of out) { const ls = r.staff.trim().split("\n").filter((l: string) => l.trim()); const last = ls[ls.length - 1].replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, "").slice(-10); ends.set(last, (ends.get(last) ?? 0) + 1); }
  console.log("最後の行の終わり:", [...ends].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join("・"));
})();
// （追記）訴求の1文の枠: 初期費用の一文／審査のサポートの一文／全力でサポートの一文 のどれかが入るか（フォームの中身で）
//   実行は同じ。--slot を付けた時だけ出す
if (process.argv.includes("--slot")) (async () => {
  const rows = readFileSync(arg("in", ""), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.at >= "2026-05-30" && r.sub === "conditions:条件のフォーム・初回" && ["hand", "edited", "asis"].includes(r.src));
  const SHOKI = /初期費用[^\n]{0,8}(?:最大限|割引|抑え)/; const SHINSA = /審査[^\n]{0,30}(?:サポート|通過|対応させて)/; const ZENRYOKU = /全力でサポート/;
  const res: Record<string, [number, number, number, number, number]> = {};
  for (const r of rows) {
    const { data } = await sb.from("messages").select("sender, text").eq("conversation_id", r.cid).lt("created_at", r.at).gte("created_at", new Date(Date.parse(r.at) - 3 * 86_400_000).toISOString());
    const form = (data ?? []).filter((m: any) => m.sender === "customer").map((m: any) => m.text ?? "").join("\n");
    const k = /審査|ブラック|滞納|自己破産|無職|夜職|水商売|債務|保証人/.test(form) ? "審査の不安あり" : "審査の不安なし";
    const v = res[k] ?? [0, 0, 0, 0, 0];
    v[0]++; if (SHOKI.test(r.staff)) v[1]++; if (SHINSA.test(r.staff)) v[2]++; if (ZENRYOKU.test(r.staff)) v[3]++; if (SHOKI.test(r.staff) || SHINSA.test(r.staff) || ZENRYOKU.test(r.staff)) v[4]++;
    res[k] = v;
  }
  for (const [k, v] of Object.entries(res)) console.log(`${k} n=${v[0]}: 初期費用の一文 ${pct(v[1], v[0])}・審査のサポート ${pct(v[2], v[0])}・全力でサポート ${pct(v[3], v[0])}・どれか1つ ${pct(v[4], v[0])}`);
})();
