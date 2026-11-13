// scripts/latent-five-table.ts — 竹内さんの番（198通の解剖・伏せ済み）で、潜在の5段と下の種類の表を作る（読むだけ・LLM/DB なし・費用0・作業員16・2026-11-13）
//   材料: exam-cache/anatomy-seven/seven-latent4.json＋seven-latent4b.json（潜在の4欄の読み 166番）・anatomy-roles/roles-r1.json（竹内さんの文と役目）。
//   出す物: ①下の種類ごとの通数・竹内さんが潜在の一文を入れた番の数・応えた段 ②今の欄（latent_read＝LatentFour）で読めている段の数 ③実例の表（--rows=40）
// 実行: npx tsx scripts/latent-five-table.ts [--rows=40] [--out=<md>]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { subkindOf, LATENT_SUBKINDS } from "../app/lib/latent-subkinds";
import { stagesFromLatentFour, LATENT_FIVE_STAGES, LATENT_FIVE_LABEL, type LatentFourLike, type LatentFiveStage } from "../app/lib/latent-five";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(__dirname, "..", "..", "..", "exam-cache");
type L4 = { id: string; scene: string; reads: Array<LatentFourLike & { none?: boolean; fact?: string | null; phrase?: string | null; lead?: string | null }> };
type Roles = { id: string; scene: string; customer?: string; sentences?: string[]; roles?: Array<{ i: number; role: string }> };

/** 竹内さんの文がどの段に応えたか（網） */
export function takeuchiAnswers(sentences: readonly string[], roles: ReadonlyArray<{ role: string }>): Record<LatentFiveStage, boolean> {
  const t = sentences.join("\n");
  return {
    object: /につきまして|について|の件/.test(t),
    concern: roles.some((r) => r.role === "worry" || r.role === "barrier"),
    reason: /とのこと|ご事情|お聞かせ頂き|お聞かせいただき|承りました|ご状況/.test(t),
    expect: /(?:頂けますと|頂ければ|いただければ|出来次第|でき次第|でしたら|ますと|た上で|後に)[^。！!]{0,40}(?:申込|内覧|ご入居|お送り|ご案内|抑え|ご判断)/.test(t),
    feeling: /ご安心|大丈夫|全力|ご不安|ご心配|お気軽に|ごゆっくり/.test(t),
  };
}

function main() {
  const L = [...(JSON.parse(readFileSync(join(CACHE, "anatomy-seven", "seven-latent4.json"), "utf8")) as L4[]), ...(JSON.parse(readFileSync(join(CACHE, "anatomy-seven", "seven-latent4b.json"), "utf8")) as L4[])];
  const R = new Map((JSON.parse(readFileSync(join(CACHE, "anatomy-roles", "roles-r1.json"), "utf8")) as Roles[]).map((r) => [r.id, r]));
  const seen = new Set<string>();
  const rows: Array<{ id: string; scene: string; sub: string; top: string; r: L4["reads"][0]; tk: Roles; ans: Record<LatentFiveStage, boolean>; cov: ReturnType<typeof stagesFromLatentFour> }> = [];
  for (const x of L) {
    const r = x.reads?.[0];
    if (!r || r.none || !r.feeling || seen.has(x.id)) continue;
    seen.add(x.id);
    const tk = R.get(x.id); if (!tk) continue;
    const sk = subkindOf(r);
    rows.push({ id: x.id, scene: x.scene, sub: sk?.id ?? "unmatched", top: sk?.top ?? "（当たらない）", r, tk, ans: takeuchiAnswers(tk.sentences ?? [], tk.roles ?? []), cov: stagesFromLatentFour(r) });
  }
  const out: string[] = [];
  out.push(`# 潜在の5段と下の種類（竹内さんの番 ${rows.length}・伏せ済み・網の数え）`, "");
  // ① 下の種類
  out.push("## 下の種類ごと", "", "| 上 | 下 | 通 | 潜在の一文あり | 応えた段（対象/気がかり/理由/想定/気持ち） | 竹内さんの一文の型 |", "|---|---|---|---|---|---|");
  const bySub = new Map<string, typeof rows>();
  for (const r of rows) bySub.set(r.sub, [...(bySub.get(r.sub) ?? []), r]);
  for (const [sub, rs] of [...bySub.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const def = LATENT_SUBKINDS.find((s) => s.id === sub);
    const cnt = (k: LatentFiveStage) => rs.filter((r) => r.ans[k]).length;
    out.push(`| ${def?.top ?? "（当たらない）"} | ${def?.label ?? sub} | ${rs.length}${rs.length < 5 ? "△" : ""} | ${rs.filter((r) => r.ans.concern).length} | ${LATENT_FIVE_STAGES.map(cnt).join("/")} | ${def?.phraseKind ?? "-"} |`);
  }
  // ② 今の欄で読めている段
  out.push("", "## 今の欄（latent_read＝LatentFour）で読めている段", "", "| 段 | 型の欄で読める | 文だけ | 読めない |", "|---|---|---|---|");
  for (const k of LATENT_FIVE_STAGES) out.push(`| ${LATENT_FIVE_LABEL[k]} | ${rows.filter((r) => r.cov[k] === "typed").length} | ${rows.filter((r) => r.cov[k] === "text_only").length} | ${rows.filter((r) => r.cov[k] === "missing").length} |`);
  // ③ 実例
  const N = Number(arg("rows", "40"));
  out.push("", `## 実例 ${Math.min(N, rows.length)}番（場面の偏りを減らすため場面ごとに順に取る）`, "", "| 場面 | 下の種類 | 何について | 気がかり／気持ち | なぜ（きっかけ） | 想定 | 竹内さんが応えた段 | 竹内さんの一文（先頭60字） |", "|---|---|---|---|---|---|---|---|");
  const scenes = [...new Set(rows.map((r) => r.scene))];
  const pick: typeof rows = [];
  for (let i = 0; pick.length < N && i < 50; i++) for (const sc of scenes) { const rs = rows.filter((r) => r.scene === sc); if (rs[i] && pick.length < N) pick.push(rs[i]); }
  const c = (v: unknown, n = 40) => String(v ?? "-").replace(/\s+/g, " ").replace(/\|/g, "／").slice(0, n);
  for (const p of pick) out.push(`| ${p.scene} | ${LATENT_SUBKINDS.find((s) => s.id === p.sub)?.label ?? p.sub} | ${c(`${p.r.part?.property ?? ""}${p.r.part?.point ?? ""}`)} | ${c(p.r.feeling?.what)}（${p.r.feeling?.strength ?? "?"}） | ${c(p.r.trigger?.text, 30)} | ${c(p.r.want)} | ${LATENT_FIVE_STAGES.filter((k) => p.ans[k]).map((k) => LATENT_FIVE_LABEL[k]).join("・") || "無し"} | ${c((p.tk.sentences ?? []).join(""), 60)} |`);
  const md = out.join("\n");
  const f = arg("out", join(CACHE, "anatomy-seven", "latent-five-table.md"));
  writeFileSync(f, md);
  console.log(md.split("\n").slice(0, 45).join("\n"));
  console.log(`\n→ ${f}`);
}
if (require.main === module) main();
