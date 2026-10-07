// scripts/kb-digest.ts — 設計知見の分野ごとの「今の決まり」（design_rules_digest）を memory/rules_digest_<分野>.md に写す・画面に出す
// 2026-10-06 竹内「設計知見の更新や成長はツールを完成させるにあたってかなり重要」（⑯）。まとめは毎週 cron（/api/cron/design-knowledge）が DB に作る。
//   作業を始める時は、その分野のまとめを先に読む（CLAUDE.md 設計知見の節）。
// 実行: npx tsx --env-file=.env.local scripts/kb-digest.ts [--area=返信] [--write]（--write で memory/ に書く・無ければ画面に出す）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AREA_FILE: Record<string, string> = {
  返信: "reply", AIX: "aix", ブレイン: "brain", 物件検索: "search", 拡張: "extension", 見積書: "estimate", 内覧: "viewing", 費用: "cost", 要確認: "review",
};
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=");

/** 2026-10-07 要確認の file に scripts/kb-priority.ts --review が書いた「段の要確認」の塊があれば残す（週の整理が上書きしても消えない） */
export function keepPriorityBlock(file: string, next: string): string {
  if (!existsSync(file)) return next;
  const m = readFileSync(file, "utf8").match(/<!-- kb-priority:start -->[\s\S]*<!-- kb-priority:end -->\n?/);
  return m && !next.includes("<!-- kb-priority:start -->") ? `${next.replace(/\n*$/, "\n\n")}${m[0]}` : next;
}
export async function writeDigestFiles(dir: string, only?: string): Promise<string[]> {
  const { data, error } = await sb.from("design_rules_digest").select("area, markdown, generated_at");
  if (error) throw new Error(error.message);
  const out: string[] = [];
  for (const d of (data ?? []) as Array<{ area: string; markdown: string }>) {
    if (only && d.area !== only) continue;
    const f = join(dir, `rules_digest_${AREA_FILE[d.area] ?? d.area}.md`);
    writeFileSync(f, keepPriorityBlock(f, d.markdown.endsWith("\n") ? d.markdown : d.markdown + "\n"));
    out.push(f);
  }
  return out;
}

async function main() {
  const area = arg("area") || undefined;
  if (process.argv.includes("--write")) {
    const files = await writeDigestFiles(join(process.cwd(), "memory"), area);
    for (const f of files) console.log("書きました:", f);
    return;
  }
  let q = sb.from("design_rules_digest").select("area, markdown");
  if (area) q = q.eq("area", area);
  const { data, error } = await q;
  if (error) { console.error(error.message); process.exit(1); }
  for (const d of data ?? []) console.log((d as { markdown: string }).markdown + "\n");
}
if (process.argv[1] && /kb-digest\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
