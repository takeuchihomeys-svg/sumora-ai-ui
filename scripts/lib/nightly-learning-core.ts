// scripts/lib/nightly-learning-core.ts — 毎晩の自動の学びの純関数（DB を持たない・テストは scripts/__tests__/nightly-learning.test.ts）
/** 竹内さんに聞く事を足す（同じ問い＝空白を除いて同じ文は足さない） */
export function mergeQuestions(md: string, day: string, qs: Array<{ q: string; scene: string }>): { md: string; added: number } {
  const norm = (s: string) => s.replace(/\s+/g, "");
  const seen = new Set(md.split("\n").filter((l) => l.startsWith("- ")).map((l) => norm(l.replace(/^- \[[^\]]*\]\s*/, "").replace(/（場面: [^）]*）$/, ""))));
  const add = qs.filter((x) => x.q.trim() && !seen.has(norm(x.q)) && (seen.add(norm(x.q)), true));
  if (!add.length) return { md, added: 0 };
  const head = md.trim() ? md.trimEnd() + "\n" : "# 竹内さんに聞く事（毎晩の自動の学び・指揮役が Docs「竹内さんへの確認事項」に写す）\n";
  return { md: `${head}\n## ${day}\n${add.map((x) => `- [未] ${x.q.trim()}（場面: ${x.scene || "-"}）`).join("\n")}\n`, added: add.length };
}

