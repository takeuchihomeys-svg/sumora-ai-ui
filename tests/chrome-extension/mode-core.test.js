// 実行: node tests/chrome-extension/mode-core.test.js
// 動作モード（🧠 ブレインの切り替え × 通常／スタッフ／AIX連動）の「storage → モード → 何が起きるか」を固定する。
// 2026-09-25 竹内「ブレインだけ別で、ほかはドロップダウン方式。ブレインでもスタッフモードや AIX モード、通常モードを行う」
const M = require("../../chrome-extension/mode-core.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;

console.log("\n■ 前の値（v2.5.9〜2.5.19 の4択）からの読み替え — 書き込みなしで同じ動きになる");
eq("旧「通常」", M.readState({ staffMode: false, staffModeAt: null, aixMode: false, brainMode: false }, NOW), { mode: "normal", brain: false, staffExpired: false });
eq("旧「スタッフ」", M.readState({ staffMode: true, staffModeAt: NOW - H, aixMode: false, brainMode: false }, NOW), { mode: "staff", brain: false, staffExpired: false });
eq("旧「AIX連動」", M.readState({ staffMode: false, aixMode: true, brainMode: false }, NOW), { mode: "aix", brain: false, staffExpired: false });
eq("旧「ブレイン」= ブレイン×AIX", M.readState({ staffMode: false, aixMode: true, brainMode: true }, NOW), { mode: "aix", brain: true, staffExpired: false });
eq("何も入っていない（初めての PC）", M.readState({}, NOW), { mode: "normal", brain: false, staffExpired: false });
eq("undefined でも落ちない", M.readState(undefined, NOW), { mode: "normal", brain: false, staffExpired: false });
eq("旧「ブレイン」の動き = 新 ブレイン×AIX の動き（自動便は見送り・判定・記録・印）",
  (({ claimAix, runAutoSchedule, brainJudge, recordPickup, brainNote, brainDrop }) => ({ claimAix, runAutoSchedule, brainJudge, recordPickup, brainNote, brainDrop }))(M.behavior("aix", true)),
  { claimAix: true, runAutoSchedule: false, brainJudge: true, recordPickup: true, brainNote: true, brainDrop: true });

console.log("\n■ スタッフの2時間の TTL（残す）");
eq("1時間59分 → まだスタッフ", M.readState({ staffMode: true, staffModeAt: NOW - 2 * H + 60000 }, NOW).mode, "staff");
eq("2時間1分 → 切れてスタッフ以外（ブレインは残る）", M.readState({ staffMode: true, staffModeAt: NOW - 2 * H - 60000, brainMode: true }, NOW), { mode: "normal", brain: true, staffExpired: true });
eq("staffModeAt なし（古い書き込み）→ 切れない扱い（background と同じ）", M.readState({ staffMode: true }, NOW).mode, "staff");
eq("スタッフとAIXが両方 true → スタッフ優先（自動化を止める側）", M.readState({ staffMode: true, staffModeAt: NOW, aixMode: true }, NOW).mode, "staff");
eq("スタッフが切れて aixMode が残っていれば AIX", M.readState({ staffMode: true, staffModeAt: NOW - 3 * H, aixMode: true }, NOW).mode, "aix");

console.log("\n■ 書き込み — モードとブレインは互いに触らない");
eq("スタッフを選ぶ", M.storageUpdateForMode("staff", NOW), { staffMode: true, staffModeAt: NOW, aixMode: false });
eq("AIXを選ぶ", M.storageUpdateForMode("aix", NOW), { staffMode: false, staffModeAt: null, aixMode: true });
eq("通常を選ぶ", M.storageUpdateForMode("normal", NOW), { staffMode: false, staffModeAt: null, aixMode: false });
eq("知らない値（旧 'brain' 等）→ 通常", M.storageUpdateForMode("brain", NOW), { staffMode: false, staffModeAt: null, aixMode: false });
eq("モードの書き込みに brainMode が入っていない", ["normal", "staff", "aix"].every((m) => !("brainMode" in M.storageUpdateForMode(m, NOW))), true);
eq("ブレインON", M.storageUpdateForBrain(true), { brainMode: true });
eq("ブレインOFF", M.storageUpdateForBrain(false), { brainMode: false });
// 書いてから読み戻すと、選んだ組み合わせになる（6通り）
for (const mode of M.MODES) for (const brain of [false, true]) {
  const st = Object.assign({}, M.storageUpdateForMode(mode, NOW), M.storageUpdateForBrain(brain));
  eq(`書いて読む ${mode}×${brain ? "ブレイン" : "なし"}`, M.readState(st, NOW), { mode, brain, staffExpired: false });
}
// ブレインを付けたままモードを変えてもブレインは消えない（片方の操作でもう片方を消さない）
{
  let st = Object.assign({}, M.storageUpdateForMode("aix", NOW), M.storageUpdateForBrain(true));
  st = Object.assign(st, M.storageUpdateForMode("staff", NOW));
  eq("ブレイン×AIX → スタッフに変える → ブレイン×スタッフ", M.readState(st, NOW), { mode: "staff", brain: true, staffExpired: false });
  st = Object.assign(st, M.storageUpdateForBrain(false));
  eq("そこでブレインを切る → スタッフのまま", M.readState(st, NOW), { mode: "staff", brain: false, staffExpired: false });
}

console.log("\n■ 組み合わせ → 何が起きるか（仕様の表）");
const pick = (b) => [b.claimCommands, b.claimAix, b.autoSend, b.excludeSent, b.brainJudge, b.brainDrop, b.brainNote, b.recordPickup, b.runAutoSchedule].map((x) => (x ? 1 : 0)).join("");
//                                   claim aix auto 除外 判定 外す 印 記録 自動便
eq("通常",            pick(M.behavior("normal", false)), "101100000");
eq("スタッフ",        pick(M.behavior("staff", false)),  "000000000");
eq("AIX連動",         pick(M.behavior("aix", false)),    "111100001");
eq("ブレイン×通常",   pick(M.behavior("normal", true)),  "101111110");
eq("ブレイン×スタッフ（判定・まとめ・記録・外さない・自動化は止めたまま）", pick(M.behavior("staff", true)), "000010110");
eq("ブレイン×AIX（旧「ブレイン」）", pick(M.behavior("aix", true)), "111111110");
eq("知らないモード → 通常扱い", pick(M.behavior("brain", false)), pick(M.behavior("normal", false)));

console.log("\n■ 人が選んだ物は減らさない（スタッフは常に外さない・除外しない）");
eq("スタッフ×ブレインでも brainDrop=false", M.behavior("staff", true).brainDrop, false);
eq("スタッフ×ブレインでも excludeSent=false", M.behavior("staff", true).excludeSent, false);
eq("スタッフ×ブレインでも自動化コマンドを claim しない", M.behavior("staff", true).claimCommands, false);

console.log("\n■ 完了で売上サポの回をまとめる（2026-09-25 竹内「完了ボタン押したらリアプロと itandi の全部分析」）");
eq("ブレイン×スタッフ は必ずまとめる", M.behavior("staff", true).completeGroup, true);
eq("ブレイン×通常 も押した時はまとめる", M.behavior("normal", true).completeGroup, true);
eq("ブレイン×AIX も押した時はまとめる", M.behavior("aix", true).completeGroup, true);
eq("ブレイン OFF は3つとも呼ばない（売上サポに届いていない）", M.MODES.map((m) => M.behavior(m, false).completeGroup), [false, false, false]);
eq("まとめる時は必ず売上サポに記録している（completeGroup ⇒ recordPickup）", M.MODES.flatMap((m) => [false, true].map((b) => !M.behavior(m, b).completeGroup || M.behavior(m, b).recordPickup)).every(Boolean), true);

console.log("\n■ ウェブの AIXツールの一括検索（web_brain）を受け取る PC（2026-09-25 竹内「ブレインモードのみで連動」）");
eq("6通り: ブレイン×通常・ブレイン×AIX だけ受け取る", M.MODES.flatMap((m) => [false, true].map((b) => M.behavior(m, b).claimBrainCommands)), [false, true, false, false, false, true]);
eq("🧠×スタッフは受け取らない（スタッフは自動化を無視）", M.behavior("staff", true).claimBrainCommands, false);
eq("受け取る PC は必ずコマンドを claim する PC（claimBrainCommands ⇒ claimCommands）", M.MODES.flatMap((m) => [false, true].map((b) => !M.behavior(m, b).claimBrainCommands || M.behavior(m, b).claimCommands)).every(Boolean), true);
eq("受け取る PC は必ず AIXツールに記録する（claimBrainCommands ⇒ recordPickup）", M.MODES.flatMap((m) => [false, true].map((b) => !M.behavior(m, b).claimBrainCommands || M.behavior(m, b).recordPickup)).every(Boolean), true);
eq("帯: 受け取る組み合わせは一括検索を書く", [M.banner("normal", true).text, M.banner("aix", true).text].every((t) => /一括検索も受け取ります/.test(t)), true);
eq("帯: 名前は AIXツール（売上サポは出さない）", [M.banner("normal", true), M.banner("staff", true), M.banner("aix", true)].every((b) => /AIXツール/.test(b.text) && !/売上サポ/.test(b.text)), true);

console.log("\n■ 検索の点検（2026-09-25 竹内「ブレインモードで…検索がちゃんとされていなかったら原因を見つけられるようにする」）");
eq("6通り: ブレインの時だけ送る（スタッフ×ブレインも）", M.MODES.flatMap((m) => [false, true].map((b) => M.behavior(m, b).searchAudit)), [false, true, false, true, false, true]);
eq("ブレイン OFF は3つとも送らない", M.MODES.map((m) => M.behavior(m, false).searchAudit), [false, false, false]);
eq("送る時は必ず判定している（searchAudit ⇒ brainJudge）", M.MODES.flatMap((m) => [false, true].map((b) => !M.behavior(m, b).searchAudit || M.behavior(m, b).brainJudge)).every(Boolean), true);

console.log("\n■ バッジ・帯");
eq("バッジ 6通り", M.MODES.flatMap((m) => [false, true].map((b) => M.badge(m, b).text)), ["", "脳通", "手動", "手脳", "AIX", "脳"]);
eq("帯: 通常×なし は出さない", M.banner("normal", false), null);
eq("帯: スタッフ", M.banner("staff", false).cls, "staff");
eq("帯: ブレイン×スタッフ", M.banner("staff", true).cls, "brain-staff");
eq("帯: AIX", M.banner("aix", false).cls, "aix");
eq("帯: ブレイン×AIX は自動便の見送りを書く", /自動便は見送り/.test(M.banner("aix", true).text), true);
eq("帯: ブレイン×通常", M.banner("normal", true).cls, "brain");
eq("帯: スタッフの帯は2時間で自動OFFを書く", [M.banner("staff", false).text, M.banner("staff", true).text].every((t) => /2時間で自動OFF/.test(t)), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
