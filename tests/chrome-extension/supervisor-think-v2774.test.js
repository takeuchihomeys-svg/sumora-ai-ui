// tests/chrome-extension/supervisor-think-v2774.test.js
// 実行: node tests/chrome-extension/supervisor-think-v2774.test.js
// 2026-11-15 竹内さん「統括がメインなのでその考えは絶対事項／統括がブレインとしてまとめるようにする」
//   「日々進化していくように統括のがブレインとなって強化していく」
//   「統括の部分もしAPIつかっているのなら deepseekv4pro の方が思考的に良い可能性ある」
//   「vercelで動かす形の方が良いのかな？」→ Vercel の夜の cron で動かす（承認済み）
//
//   ★ 実測（2026-11-15）
//     ① 統括は**LLM を一切使っていなかった**（`learn-supervisor.ts` 1,209行の決定論のみ）
//     ② DeepSeek V4 Pro に材料（712字）を渡すと **29.6秒・推論6,930字・出力2,315トークン・約$0.003**
//        答え「検索ボタンの種別判定」… 「検索を押す」が止まりやすい（50回）
//        ⚠ **私が書いたルールに無い視点**を自分で見つけた（＝任せる価値がある）
//     ③ ⚠ `max_tokens` が少ないと**答えが0字**（700→推論1,180字／2000→推論6,419字／4000→答え77字）
//        DeepSeek V4 Pro は推論にトークンを大量に使う（HTTP は 200 で返るので気づきにくい）
//     ④ ⚠ `maxDuration` が未設定で Vercel の既定10秒 → **29.6秒の処理は必ず切れる**
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..");
const llm = fs.readFileSync(path.join(dir, "app", "lib", "learn-supervisor-llm.ts"), "utf8");
const api = fs.readFileSync(path.join(dir, "app", "api", "cron", "supervisor-think", "route.ts"), "utf8");
const profile = fs.readFileSync(path.join(dir, "app", "api", "human-learn-profile", "route.ts"), "utf8");
const models = fs.readFileSync(path.join(dir, "app", "lib", "deepseek-models.ts"), "utf8");
const vercel = JSON.parse(fs.readFileSync(path.join(dir, "vercel.json"), "utf8"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① モデル名は1か所で持つ（散らばると片方だけ古くなる）");
{
  ok("  deepseek-v4-pro がある", /DEEPSEEK_MODEL_PRO = "deepseek-v4-pro"/.test(models));
  ok("  flash もある", /DEEPSEEK_MODEL_FLASH = "deepseek-flash"/.test(models));
  ok("  ⚠ 推論で使い切らないよう max_tokens の安全値を定義", /DEEPSEEK_MAX_TOKENS_SAFE = 4000/.test(models));
  /**
   * ★ 2026-11-15 実測: 統括の判断（3行だけ）は **2,500** が最適。
   *   4000 → 推論6,900字で **60秒を超えて時間切れ**／2000以下 → **答え0字**（推論で使い切る）。
   *   → 2500 で「答えが出る」と「60秒に収まる」の両方を満たす（実測 16〜23秒）。
   */
  ok("  ⚠ 統括の思考用は 2500（4000だと時間切れ・2000以下だと答え0字）", /DEEPSEEK_MAX_TOKENS_THINK = 2500/.test(models));
  ok("  ⚠ LLM 側が思考用の値を使う", /opt\.maxTokens \?\? DEEPSEEK_MAX_TOKENS_THINK/.test(llm));
}

console.log("\n■ ② 統括の思考（材料に無い事を言わせない）");
{
  ok("  材料にある事だけ使うと指示している", /材料に書いてある事だけ/.test(llm));
  ok("  ⚠ 数字は自分で数え直させない", /自分で数え直さない/.test(llm));
  ok("  ⚠ 1つだけ選ばせる", /1つだけ/.test(llm));
  ok("  ⚠ 出力は3行だけ（次に直す・なぜ・どう直す）", /次に直す/.test(llm) && /なぜ/.test(llm) && /どう直す/.test(llm));
  ok("  3つ揃っていない答えは使わない", /if \(!next \|\| !why \|\| !how\) return null/.test(llm));
  ok("  ⚠ 鍵が無い・失敗したら null（決定論を使う＝止まらない）", /if \(!key\) return null/.test(llm) && /catch \{\s*return null/.test(llm));
  ok("  ⚠ 答えが空なら諦める（推論で使い切った時）", /if \(!text\) return null/.test(llm));
}

console.log("\n■ ③ 材料を LLM に渡す形（数字は決定論で数えた物）");
{
  ok("  材料の文を作る関数がある", /export function supervisorMaterialText/.test(llm));
  ok("  記録・操作つき・人の手本を渡す", /記録 \$\{b\.rows/.test(llm));
  ok("  弱い所を渡す（最大10件）", /weak\.slice\(0, 10\)/.test(llm));
  ok("  場面の手順を渡す（最大6場面）", /sf\.slice\(0, 6\)/.test(llm));
  ok("  今日 直した事を渡す（最大5件）", /recent \?\? \[\]\)\.slice\(0, 5\)|\(imp\.recent \?\? \[\]\)/.test(llm));
  ok("  ⚠ 長すぎない（6,000字まで）", /slice\(0, 6000\)/.test(llm));
}

console.log("\n■ ④ Vercel の制限時間（これが無いと29.6秒の処理が切れる）");
{
  // 2.8.313: 60 → 300 に延ばされた（長い処理に合わせた）。守るのは「既定10秒で切れない・実測 29.6秒の処理が収まる＝60秒以上」
  const _maxDur = (s) => { const m = /export const maxDuration = (\d+)/.exec(s); return m ? Number(m[1]) : 0; };
  ok("  ⚠ human-learn-profile に maxDuration がある（60秒以上）", _maxDur(profile) >= 60, _maxDur(profile));
  ok("  ⚠ cron API にも maxDuration がある（60秒以上）", _maxDur(api) >= 60, _maxDur(api));
  ok("  ⚠ 理由が書いてある（既定10秒では切れる）", /既定.*10秒|10秒.*切れ/.test(profile) || /10秒/.test(api));
}

console.log("\n■ ⑤ 夜の cron に追加されている");
{
  const cron = (vercel.crons || []).find((c) => c.path === "/api/cron/supervisor-think");
  ok("  ⚠ cron に supervisor-think がある", !!cron, (vercel.crons || []).filter((c) => /supervisor/.test(c.path)));
  ok("  毎日1回（1日1回＝費用 約$0.003）", cron && cron.schedule === "50 13 * * *", cron && cron.schedule);
  ok("  既存の human-learn-brain の後", !!cron && cron.schedule.startsWith("50 13"));
}

console.log("\n■ ⑥ 両方の判断を残す（LLM が落ちても決定論は残る）");
{
  ok("  決定論の判断も取っている", /deterministic/.test(api));
  ok("  LLM の判断を llm_think として残す", /llm_think/.test(api));
  ok("  ⚠ LLM が答えられなくても ok:true（止まらない）", /llm_error: think \? null/.test(api));
  ok("  dry=1 で保存しない（確かめ用）", /dry/.test(api) && /!dry && think/.test(api));
  ok("  CRON_SECRET で守っている", /CRON_SECRET/.test(api));
}

console.log("\n■ ⑦ 費用の歯止め");
{
  ok("  ⚠ 1日1回の cron", (vercel.crons || []).filter((c) => /supervisor-think/.test(c.path)).length === 1);
  ok("  ⚠ 材料を6,000字に切る（費用が膨らまない）", /slice\(0, 6000\)/.test(llm));
  ok("  時間切れで諦める（budgetMs）", /budgetMs/.test(llm));
}

console.log("\n■ ⑧ ⚠ NOT NULL の列に null を入れない（実測で2回踏んだ）");
{
  /**
   * ⚠ 実測: `learn_supervisor_log` の `coverage` と `next_n` は **NOT NULL**。
   *   `null` を入れると `null value in column "..." violates not-null constraint` で**保存できない**。
   *   → 0 で埋める（材料の値は決定論が付けた物をそのまま使う）。
   */
  const script = fs.readFileSync(path.join(dir, "scripts", "supervisor-think.ts"), "utf8");
  ok("  ⚠ 手元のスクリプトが数値を 0 で埋める", /coverage: num\(b\.coverage\)/.test(script) && /next_n: num\(b\.next_n\)/.test(script));
  ok("  ⚠ cron も 0 で埋める", /coverage: Number\(.*\) \|\| 0/.test(api) && /next_n: Number\(b\.next_n\) \|\| 0/.test(api));
  ok("  ⚠ NOT NULL だったとコメントに残している", /NOT NULL/.test(script) || /NOT NULL/.test(api));
  ok("  ⚠ 保存の形が cron と手元で同じ（meeting.llm_think）", /llm_think/.test(script) && /llm_think/.test(api));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
