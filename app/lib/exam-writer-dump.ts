// app/lib/exam-writer-dump.ts — 試験の時だけ、書き手に渡す材料の全文を exam-cache に残す（調べ物用・本番では動かない）
//
// 2026-11-06 作業員9（統括役の決め・弱い所 322）: q010 で書き手が継続の約束を足す出所を、材料の全文から特定するため。
//   動くのは EXAM_DUMP_WRITER_PROMPT=on かつ 試験の印（LLM_TEST_MODE か LLM_TEST_FINAL_CLAUDE）がある時だけ。Vercel（VERCEL=1）では必ず止まる。
//   置き場は <git の共通の倉庫>/.claude/exam-cache/writer-prompts/（EXAM_CACHE_DIR があればその下）＝git に入らない。
type Env = Record<string, string | undefined>;
export function writerDumpOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  if (String(env.VERCEL ?? "").trim()) return false;
  if ((env.EXAM_DUMP_WRITER_PROMPT ?? "").trim().toLowerCase() !== "on") return false;
  return !!String(env.LLM_TEST_MODE ?? "").trim() || !!String(env.LLM_TEST_FINAL_CLAUDE ?? "").trim();
}
type Msg = { content?: unknown; _getType?: () => string; getType?: () => string; constructor?: { name?: string } };
export function messagesToText(messages: ReadonlyArray<Msg>): Array<{ role: string; text: string }> {
  return messages.map((m) => {
    const role = (typeof m._getType === "function" ? m._getType() : typeof m.getType === "function" ? m.getType() : m.constructor?.name) ?? "?";
    const c = m.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n") : "";
    return { role: String(role), text };
  });
}
export async function dumpWriterPrompt(o: { conversationId: string | null; label?: string | null; messages: ReadonlyArray<Msg> }, env: Env = typeof process !== "undefined" ? process.env : {}): Promise<string | null> {
  if (!writerDumpOn(env)) return null;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join, dirname, resolve } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    let root = String(env.EXAM_CACHE_DIR ?? "").trim();
    if (!root) {
      try { root = join(dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()), ".claude", "exam-cache"); }
      catch { root = resolve("scripts/.exam-cache"); }
    }
    const dir = join(root, "writer-prompts");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${(o.conversationId ?? "none").slice(0, 8)}${o.label ? `-${o.label}` : ""}.json`);
    writeFileSync(file, JSON.stringify({ conversationId: o.conversationId, at: new Date().toISOString(), messages: messagesToText(o.messages) }, null, 1));
    return file;
  } catch (e) { console.warn("[exam-writer-dump] 書けない:", e instanceof Error ? e.message : String(e)); return null; }
}
