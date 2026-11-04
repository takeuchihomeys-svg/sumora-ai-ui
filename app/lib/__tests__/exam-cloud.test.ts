// app/lib/__tests__/exam-cloud.test.ts — 試験をクラウドで流す口の決まり（鍵を VM に入れない・送ってはいけない物・合言葉）
//   実行: npx tsx app/lib/__tests__/exam-cloud.test.ts
import { examCloudOn, examCloudAuthorized, forbiddenPath, vmEnv, brokeredPolicy, runScript, labelOk } from "../exam-cloud";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("既定 off", !examCloudOn({}) && examCloudOn({ EXAM_CLOUD: "on" }));
const S = "x".repeat(32);
t("合言葉: 一致の時だけ・短い合言葉は常に断る", examCloudAuthorized(`Bearer ${S}`, { EXAM_CLOUD_SECRET: S }) && !examCloudAuthorized("Bearer y", { EXAM_CLOUD_SECRET: S }) && !examCloudAuthorized("Bearer short", { EXAM_CLOUD_SECRET: "short" }) && !examCloudAuthorized(null, {}));
t("送ってはいけない物（.env*・.claude・node_modules・exam-cache・.vercel）", [".env.local", "app/.env", ".env.production.local", ".claude/settings.json", "node_modules/x/y.js", "a/exam-cache/b", ".vercel/project.json"].every(forbiddenPath) && !forbiddenPath("app/lib/env-check.ts") && !forbiddenPath("scripts/brain-exam.ts") && !forbiddenPath(".envrc-not") === true);
const e = vmEnv("https://x.supabase.co", { EXAM_CONCURRENCY: "6", LLM_TEST_MODE: "claude", MY_SECRET: "v", OPENAI_API_KEY: "real" });
t("VM の env: テストの決まりは固定（deepseek-all）・鍵の名前の物は通さない・鍵は形だけ", e.LLM_TEST_MODE === "deepseek-all" && e.EXAM_CONCURRENCY === "6" && !("MY_SECRET" in e) && e.OPENAI_API_KEY === "brokered" && e.SUPABASE_SERVICE_ROLE_KEY === "brokered");
const pol = brokeredPolicy({ supabaseUrl: "https://abc.supabase.co", supabaseKey: "K1", deepseekKey: "K2", openaiKey: "K3" });
t("通信の口: 決まった宛先だけ・Anthropic は許さない", Object.keys(pol.allow).sort().join(",") === ["*.npmjs.org", "abc.supabase.co", "api.deepseek.com", "api.openai.com", "registry.npmjs.org"].sort().join(",") && !Object.keys(pol.allow).some((d) => /anthropic/.test(d)));
t("鍵は通信の口の見出しにだけ（VM の env には入らない）", JSON.stringify(e).indexOf("K1") < 0 && pol.allow["abc.supabase.co"][0].transform[0].headers.authorization === "Bearer K1");
const sc = runScript({ label: "cloud-t1", argv: ["--only=q001", "--conv=YUMA7"] });
t("台本: 展開→npm ci→brain-exam→終わりの印・引数は引用", sc.includes("tar -xzf code.tgz") && sc.includes("npm ci") && sc.includes("scripts/brain-exam.ts --label='cloud-t1' '--only=q001' '--conv=YUMA7'") && sc.includes("echo $? > ../out/done"));
t("label の形", labelOk("cloud-t1") && !labelOk("../x") && !labelOk("a b"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
