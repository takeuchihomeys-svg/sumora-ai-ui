// app/lib/exam-cloud.ts — 試験をクラウド（Vercel Sandbox）で流す口の決まり（作業員1・2026-11-04・竹内さん了承「つくっといて」・既定 off）
//   設計: scratchpad cloud-exam-design.md。PC の係（scripts/exam-cloud.ts）が、試す commit の tarball（.env*・.claude・node_modules・exam-cache・public を入れない）と
//   試験の材料（問題の共有の置き場など・伏せた物）を、この口の関数に4MB ずつ渡し、関数が Sandbox の VM に書き込んで brain-exam を流す。
//   鍵: VM の中には入れない。関数が持つ Vercel の環境変数の鍵を、Sandbox の通信の口（networkPolicy の transform）で、決まった宛先への通信にだけ足す（credential brokering）。
//   テストの決まり: VM の env は LLM_TEST_MODE=deepseek-all を固定（Anthropic の宛先は許さない＝Claude は呼べない）。会話は YUMA 系だけ（brain-exam の歯止め）。
//   止め方: EXAM_CLOUD=on の時だけ動く・1本 timeout 90分・stop の口・1日の本数の上限。純関数だけ（Sandbox を呼ぶのは exam-cloud-server.ts）

export const examCloudOn = (env: Record<string, string | undefined> = process.env) => (env.EXAM_CLOUD ?? "").trim().toLowerCase() === "on";

/** PC の係からの呼び出しの合言葉（EXAM_CLOUD_SECRET・Bearer）。無ければ常に断る */
export function examCloudAuthorized(authHeader: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const s = (env.EXAM_CLOUD_SECRET ?? "").trim();
  return s.length >= 24 && authHeader === `Bearer ${s}`;
}

/** tarball に入れてはいけない道（tsc-remote の .vercelignore と同じ考え） */
export function forbiddenPath(p: string): boolean {
  const s = p.replace(/\\/g, "/").replace(/^\.\//, "");
  return /(^|\/)\.env(\.|$)/.test(s) || /^\.claude(\/|$)/.test(s) || /(^|\/)node_modules(\/|$)/.test(s) || /(^|\/)exam-cache(\/|$)/.test(s) || /(^|\/)\.vercel(\/|$)/.test(s);
}

export const CHUNK_MAX = 4 * 1024 * 1024; // 関数の本文の上限 4.5MB の内側
export const RUN_DIR = "/vercel/sandbox";
export const EXAM_CLOUD_TIMEOUT_MS = 90 * 60_000;

/** VM の中の env（鍵は形だけ＝本物は通信の口で足す）。テストの決まりは固定で上書きできない */
export function vmEnv(supabaseUrl: string, extra: Record<string, string>): Record<string, string> {
  const safeExtra = Object.fromEntries(Object.entries(extra).filter(([k]) => /^[A-Z][A-Z0-9_]{1,63}$/.test(k) && !/KEY|SECRET|TOKEN|PASSWORD/.test(k) && k !== "LLM_TEST_MODE" && k !== "LLM_TEST_FINAL_CLAUDE"));
  return {
    ...safeExtra,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    // 形だけの鍵（ライブラリが「鍵が無い」で止まらないため）。本物は通信の口が足す
    SUPABASE_SERVICE_ROLE_KEY: "brokered", NEXT_PUBLIC_SUPABASE_ANON_KEY: "brokered", DEEPSEEK_API_KEY: "brokered", OPENAI_API_KEY: "brokered",
    LLM_TEST_MODE: "deepseek-all",
    EXAM_CACHE_DIR: `${RUN_DIR}/exam-cache`,
    EXAM_CLOUD_VM: "1",
  };
}

/** 通信の口の許す宛先と、足す見出し（鍵の値はここでは受け取るだけ・返さない・記録しない） */
export function brokeredPolicy(k: { supabaseUrl: string; supabaseKey: string; deepseekKey: string; openaiKey: string }): { allow: Record<string, Array<{ transform: Array<{ headers: Record<string, string> }> }>> } {
  const sbHost = new URL(k.supabaseUrl).host;
  const set = (headers: Record<string, string>) => [{ transform: [{ headers }] }];
  return {
    allow: {
      [sbHost]: set({ apikey: k.supabaseKey, authorization: `Bearer ${k.supabaseKey}` }),
      "api.deepseek.com": set({ authorization: `Bearer ${k.deepseekKey}` }),
      "api.openai.com": set({ authorization: `Bearer ${k.openaiKey}` }),
      // npm ci 用（鍵なし）
      "registry.npmjs.org": [],
      "*.npmjs.org": [],
    },
  };
}

/** VM の中で流す1本の台本（bash）。届いた欠片を繋いで展開 → npm ci → brain-exam → 終わりの印 */
export function runScript(o: { argv: string[]; label: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const args = o.argv.map(q).join(" ");
  return [
    "set -u",
    `cd ${RUN_DIR}`,
    "mkdir -p app exam-cache out",
    "cat up/code.* > code.tgz && tar -xzf code.tgz -C app",
    "if ls up/mat.* >/dev/null 2>&1; then cat up/mat.* > mat.tgz && tar -xzf mat.tgz -C exam-cache; fi",
    "cd app && touch .env.local",
    "npm ci --no-audit --no-fund --ignore-scripts > ../out/npm.log 2>&1 || { echo npm-failed > ../out/done; exit 1; }",
    `npx tsx --env-file=.env.local scripts/brain-exam.ts --label=${q(o.label)} ${args} > ../out/exam.log 2>&1; echo $? > ../out/done`,
  ].join("\n");
}

/** 試験の label の形（ファイル名に使う） */
export const labelOk = (s: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(s);
