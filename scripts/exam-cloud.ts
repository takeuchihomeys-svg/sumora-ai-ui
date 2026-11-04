// scripts/exam-cloud.ts — 試験をクラウド（Vercel Sandbox）で1本流す PC の係（作業員1・2026-11-04・竹内さん了承）
//   1) 試す作業ツリーの HEAD の commit を git archive で tar.gz に（.claude・public・.env* は入れない・中身を tar -t で確かめてから送る）
//   2) 試験の材料（問題の共有の置き場の、流す問題の分だけ）を tar.gz に
//   3) /api/exam-cloud に 4MB ずつ渡す → VM で展開・npm ci・brain-exam → 終わりを待って結果を受け取り、手元の results に置く → VM を止める
//   鍵: PC からは合言葉 EXAM_CLOUD_SECRET だけ（.env.local の他の鍵は送らない）。VM の中にも鍵は入らない
//   テストの決まり: VM の env は LLM_TEST_MODE=deepseek-all 固定（関数の側で上書きできない）・会話は YUMA 系だけ（--conv=YUMA2〜7）
// 実行: npx tsx --env-file=.env.local scripts/exam-cloud.ts --cwd=<作業ツリー> --label=<名> --only=q001,q002 [--repeat=1] [--conv=YUMA7] [--env=K=V,…] [--base=https://sumora-ai-ui.vercel.app]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { forbiddenPath, CHUNK_MAX, labelOk } from "../app/lib/exam-cloud";
import { examCacheRoot } from "./lib/llm-cassette";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BASE = arg("base", "https://sumora-ai-ui.vercel.app");
const SECRET = (process.env.EXAM_CLOUD_SECRET ?? "").trim();
const CWD = resolve(arg("cwd", process.cwd()));
const LABEL = arg("label");
const ONLY = arg("only").split(",").filter(Boolean);
if (!SECRET) { console.error("EXAM_CLOUD_SECRET が無い（.env.local に置く・竹内さん了承 11/04）"); process.exit(1); }
if (!labelOk(LABEL) || !ONLY.length) { console.error("--label と --only が要る"); process.exit(1); }
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

async function call(action: string, q: Record<string, string>, body?: Buffer | string, json = true): Promise<unknown> {
  const u = new URL("/api/exam-cloud", BASE); u.searchParams.set("action", action); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  for (let t = 0; t < 3; t++) {
    const r = await fetch(u, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) }, body: typeof body === "string" || body === undefined ? body : new Uint8Array(body) });
    if (r.status >= 500 && t < 2) { await new Promise((s) => setTimeout(s, 3000)); continue; }
    if (!json) { if (!r.ok) throw new Error(`${action}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
    const j = (await r.json()) as { ok: boolean; error?: string };
    if (!j.ok) throw new Error(`${action}: ${j.error ?? r.status}`);
    return j;
  }
  throw new Error(`${action}: 3回失敗`);
}

function tarCheck(file: string): void {
  const list = execFileSync("tar", ["-tzf", file], { maxBuffer: 256 * 1024 * 1024 }).toString().split(/\r?\n/).filter(Boolean);
  const bad = list.filter(forbiddenPath);
  if (bad.length) throw new Error(`送ってはいけない物が入っている: ${bad.slice(0, 5).join(", ")}`);
  log(`  確かめ: ${list.length}件・.env／.claude／node_modules／exam-cache／.vercel は 0`);
}

async function upload(file: string, kind: "code" | "mat", name: string): Promise<void> {
  const buf = readFileSync(file);
  let i = 0;
  for (let o = 0; o < buf.length; o += CHUNK_MAX, i++) await call("chunk", { name, file: kind, i: String(i) }, buf.subarray(o, o + CHUNK_MAX));
  log(`  ${kind}: ${(buf.length / 1048576).toFixed(1)}MB を ${i}個で送った`);
}

(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exam-cloud-"));
  const commit = execFileSync("git", ["-C", CWD, "rev-parse", "HEAD"]).toString().trim();
  const dirty = execFileSync("git", ["-C", CWD, "status", "--porcelain", "--untracked-files=no"]).toString().trim();
  if (dirty) log(`⚠ 作業ツリーにコミットしていない変更がある＝クラウドでは HEAD（${commit.slice(0, 8)}）を流す`);
  // 1) コード（コミット済みの物だけ・.claude・public・.env* を外す）
  const code = join(tmp, "code.tgz");
  execFileSync("git", ["-C", CWD, "archive", "--format=tar.gz", "-o", code, "HEAD", "--", ".", ":(exclude).claude", ":(exclude)public", ":(exclude,glob)**/.env*"]);
  tarCheck(code);
  // 2) 材料（問題の共有の置き場の、流す問題だけ）
  const root = examCacheRoot();
  const probs = ONLY.filter((id) => existsSync(join(root, "brain-exam-problems", id)));
  const mat = join(tmp, "mat.tgz");
  if (probs.length) execFileSync("tar", ["-czf", mat, "-C", root, ...probs.map((id) => `brain-exam-problems/${id}`)]);
  log(`材料: 問題の共有の置き場 ${probs.length}/${ONLY.length}問`);
  // 3) VM を作って送る
  const env = Object.fromEntries(arg("env").split(",").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const { name } = (await call("create", {}, JSON.stringify({ env: { EXAM_CONCURRENCY: "1", ...env } }))) as { name: string };
  log(`VM: ${name}（commit ${commit.slice(0, 8)}）`);
  try {
    await upload(code, "code", name);
    if (probs.length) await upload(mat, "mat", name);
    const argv = [`--only=${ONLY.join(",")}`, `--repeat=${arg("repeat", "1")}`, `--conv=${arg("conv", "YUMA7")}`, ...(arg("stage") ? [`--stage=${arg("stage")}`] : [])];
    await call("run", { name }, JSON.stringify({ label: LABEL, argv }));
    log(`流し始めた: ${argv.join(" ")}`);
    const t0 = Date.now();
    let st: { done: string | null; tail: string; npm: string } = { done: null, tail: "", npm: "" };
    while (Date.now() - t0 < 95 * 60_000) {
      await new Promise((s) => setTimeout(s, 30_000));
      st = (await call("status", { name })) as typeof st;
      if (st.done !== null) break;
      const last = st.tail.trim().split("\n").filter((l) => /^[○✕]/.test(l)).slice(-1)[0];
      if (last) log(`  …${last.slice(0, 80)}`);
    }
    log(`終わり: ${st.done ?? "時間切れ"}`);
    if (st.npm) console.log(st.npm);
    const outDir = join(CWD, "scripts", "brain-exam", "results"); mkdirSync(outDir, { recursive: true });
    for (const [p, local] of [[`app/scripts/brain-exam/results/${LABEL}.jsonl`, `${LABEL}.cloud.jsonl`], ["out/exam.log", `${LABEL}.cloud.log`]] as const) {
      try { const b = (await call("fetch", { name, path: p }, undefined, false)) as Buffer; writeFileSync(join(outDir, local), b); log(`  受け取った: ${local}（${b.length}B）`); }
      catch (e) { log(`  受け取れない: ${p}（${String(e).slice(0, 80)}）`); }
    }
    console.log(st.tail.split("\n").filter((l) => /^[○✕]|合格|悪くなった|DeepSeek・Jev/.test(l)).slice(-30).join("\n"));
  } finally {
    await call("stop", { name }).catch((e) => log(`止められない: ${String(e).slice(0, 80)}`));
    log(`VM を止めた: ${name}`);
  }
})().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
