// scripts/audit-provider-fit.ts — 使い方の表の版ごとの物差し（台帳 #670 の子・作業員L・2026-11-24・読むだけ・LLM なし）
//   試験の組（brain-exam の label）ごとに、表の版（meta.providerProfiles か組の名前）と、次を出す:
//     キャッシュの当たりの率（llm_usage_logs・route=script:brain-exam-<label>・相手のモデルの行）・欄の欠けの率（ブレインの最初の答え）・
//     長さの比と竹内さんの文との近さ（下書き）・言ってはいけない事・時間切れ／Claude への戻り（error_type）・道／本質／下書きの合格
//   GPT に特有の外れの型（先走り＝返信の番に内覧の案内・慎重すぎ＝確認の番に聞き返し・短く切る＝長さの比 0.8 未満・欄の欠け）を数え、型ごとに表の欄の直しの案を出す。
//   --write で quality_daily（scope=provider_fit:<版>・metric=provider_fit:<物差し>）に残す＝連携の地図 next.provider_fit の行（版を上げた時に前の版と比べる）
// 実行: npx tsx --env-file=.env.local scripts/audit-provider-fit.ts --labels=l-oaw-sol,l-oaw-luna [--version-of=l-oaw-sol=openai-writer-v1,...] [--write]
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const R = join("scripts", "brain-exam", "results");
const BRAIN_KEYS = ["reply_mode", "action", "reply_direction", "key_topics", "avoid_topics", "customer_questions", "next_steps", "turn_contract", "reason"];

type Row = { id: string; path?: { code?: string; ok?: boolean }; essence?: { code?: string; ok?: boolean }; raw?: Record<string, unknown> | null; draft?: { text?: string; ok?: boolean; pass?: boolean; ng?: boolean[] } | null };
type Problem = { id: string; staffText?: string; accept?: string[] };

export const norm = (t: string | null | undefined) => String(t ?? "").replace(/[\s！!。、・〇]+/g, "").replace(/[0-9０-９]/g, "0");
export function dice(a: string, b: string): number {
  const bi = (t: string) => { const s = norm(t); const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = bi(a), B = bi(b); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}
/** GPT に特有の外れの型（純関数・1答案） */
export function gptMissTypes(r: Row, p: Problem | undefined): string[] {
  const out: string[] = [];
  const acc = (p?.accept ?? []).join("|");
  const code = String(r.essence?.code ?? r.path?.code ?? "");
  if (r.essence && !r.essence.ok) {
    if (/viewing_invite/.test(code) && !/viewing_invite/.test(acc)) out.push("先走り");
    if (/^返信/.test(code) && /AIX:|2段/.test(acc) && !/返信/.test(acc)) out.push("慎重すぎ");
  }
  if (r.raw && BRAIN_KEYS.some((k) => !(k in (r.raw as Record<string, unknown>)))) out.push("欄の欠け");
  if (r.draft?.text && p?.staffText && norm(r.draft.text).length / Math.max(1, norm(p.staffText).length) < 0.8) out.push("短く切る");
  return out;
}
export const FIX_HINT: Readonly<Record<string, string>> = {
  先走り: "言い添えに『返信で答えられる番は内覧の案内に進めない（竹内さんの一手の順）』を足す版",
  慎重すぎ: "言い添えに『物件の確認で応える番は聞き返さない』を足す版",
  短く切る: "長さの目安（len_hint）を入れた版・考える深さを上げた版",
  欄の欠け: "出力の形を json_schema（strict・欄を必須）にした版",
};

(async () => {
  const labels = arg("labels").split(",").map((s) => s.trim()).filter(Boolean);
  const verOf = new Map(arg("version-of").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
  const probs = new Map(((existsSync(join("scripts", "brain-exam", "problems.json")) ? JSON.parse(readFileSync(join("scripts", "brain-exam", "problems.json"), "utf8")) : []) as Problem[]).map((p) => [p.id, p]));
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const out: Array<Record<string, unknown>> = [];
  for (const label of labels) {
    const f = join(R, `${label}.jsonl`);
    if (!existsSync(f)) { out.push({ label, missing: true }); continue; }
    const rows = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
    let meta: { providerProfiles?: { brain?: string | null; writer?: string | null } } = {};
    try { meta = JSON.parse(readFileSync(join(R, `${label}.meta.json`), "utf8")); } catch { /* 古い組は meta に版が無い */ }
    const version = verOf.get(label) ?? meta.providerProfiles?.writer ?? meta.providerProfiles?.brain ?? "(版なし)";
    const { data } = await sb.from("llm_usage_logs").select("model, action, input_uncached, cache_read, error_type").eq("route", `script:brain-exam-${label}`).limit(5000);
    const us = ((data ?? []) as Array<{ model: string | null; action: string | null; input_uncached: number | null; cache_read: number | null; error_type: string | null }>).filter((u) => /^gpt-/.test(String(u.model ?? "")));
    const unc = us.reduce((a, u) => a + (u.input_uncached ?? 0), 0), hit = us.reduce((a, u) => a + (u.cache_read ?? 0), 0);
    const errs = us.filter((u) => u.error_type).length;
    const drafts = rows.filter((r) => r.draft?.text);
    const sims = drafts.map((r) => dice(String(r.draft!.text), probs.get(r.id)?.staffText ?? ""));
    const lens = drafts.map((r) => norm(r.draft!.text).length / Math.max(1, norm(probs.get(r.id)?.staffText ?? "").length));
    const raws = rows.filter((r) => r.raw);
    const miss: Record<string, number> = {};
    for (const r of rows) for (const m of gptMissTypes(r, probs.get(r.id))) miss[m] = (miss[m] ?? 0) + 1;
    const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null);
    out.push({
      label, version, n: rows.length,
      cacheHitPct: unc + hit ? +((100 * hit) / (unc + hit)).toFixed(1) : null, openaiCalls: us.length, errorsOrFallback: errs,
      fieldMissingPct: raws.length ? +((100 * raws.filter((r) => BRAIN_KEYS.some((k) => !(k in (r.raw as Record<string, unknown>)))).length) / raws.length).toFixed(1) : null,
      lenRatio: avg(lens), simToTakeuchi: avg(sims), ngViolated: drafts.reduce((a, r) => a + (r.draft!.ng ?? []).filter(Boolean).length, 0),
      path: `${rows.filter((r) => r.path?.ok).length}/${rows.length}`, essence: `${rows.filter((r) => r.essence?.ok).length}/${rows.filter((r) => r.essence).length}`, draftPass: `${drafts.filter((r) => r.draft!.pass).length}/${drafts.length}`,
      missTypes: miss, fixHints: Object.keys(miss).map((k) => `${k}: ${FIX_HINT[k] ?? "-"}`),
    });
  }
  for (const o of out) console.log(JSON.stringify(o));
  if (argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const rows = out.filter((o) => !o.missing).flatMap((o) => (["cacheHitPct", "fieldMissingPct", "lenRatio", "simToTakeuchi", "ngViolated", "errorsOrFallback"] as const)
      .filter((k) => typeof o[k] === "number").map((k) => ({ day, metric: `provider_fit:${k}`, scope: `provider_fit:${o.version}`, value: o[k] as number, n: o.n as number, source: `scripts/audit-provider-fit.ts（${o.label}）` })));
    if (rows.length) { const { error } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" }); if (error) throw new Error(error.message); console.log(`quality_daily に ${rows.length}行`); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
