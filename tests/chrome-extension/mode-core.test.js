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
eq("ブレイン×AIX の動き（2026-09-29 から自動便も走る・判定・記録・印）",
  (({ claimAix, runAutoSchedule, brainJudge, recordPickup, brainNote, brainDrop }) => ({ claimAix, runAutoSchedule, brainJudge, recordPickup, brainNote, brainDrop }))(M.behavior("aix", true)),
  { claimAix: true, runAutoSchedule: true, brainJudge: true, recordPickup: true, brainNote: true, brainDrop: true }); // 2026-09-29 ブレイン×AIX でも自動便を走らせる

console.log("\n■ スタッフの2時間の TTL（残す）");
eq("1時間59分 → まだスタッフ", M.readState({ staffMode: true, staffModeAt: NOW - 2 * H + 60000 }, NOW).mode, "staff");
eq("2時間1分 → 切れてスタッフ以外（ブレインは残る）", M.readState({ staffMode: true, staffModeAt: NOW - 2 * H - 60000, brainMode: true }, NOW), { mode: "normal", brain: true, staffExpired: true });
eq("staffModeAt なし（古い書き込み）→ 切れない扱い（background と同じ）", M.readState({ staffMode: true }, NOW).mode, "staff");
eq("スタッフとAIXが両方 true → スタッフ優先（自動化を止める側）", M.readState({ staffMode: true, staffModeAt: NOW, aixMode: true }, NOW).mode, "staff");
eq("スタッフが切れて aixMode が残っていれば AIX", M.readState({ staffMode: true, staffModeAt: NOW - 3 * H, aixMode: true }, NOW).mode, "aix");

console.log("\n■ 書き込み — モードとブレインは互いに触らない");
eq("スタッフを選ぶ", M.storageUpdateForMode("staff", NOW), { staffMode: true, staffModeAt: NOW, aixMode: false, autoModeAt: null, aiMode: false });
eq("自動を選ぶ", M.storageUpdateForMode("aix", NOW), { staffMode: false, staffModeAt: null, aixMode: true, autoModeAt: NOW, aiMode: false });
eq("AIX（選んだお客さん）を選ぶ", M.storageUpdateForMode("ai", NOW), { staffMode: false, staffModeAt: null, aixMode: false, autoModeAt: NOW, aiMode: true });
eq("通常を選ぶ", M.storageUpdateForMode("normal", NOW), { staffMode: false, staffModeAt: null, aixMode: false, autoModeAt: null, aiMode: false });
eq("知らない値（旧 'brain' 等）→ 通常", M.storageUpdateForMode("brain", NOW), { staffMode: false, staffModeAt: null, aixMode: false, autoModeAt: null, aiMode: false });
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
eq("ブレイン×AIX（2026-09-29 から自動便も走る）", pick(M.behavior("aix", true)), "111111111");
eq("知らないモード → 通常扱い", pick(M.behavior("brain", false)), pick(M.behavior("normal", false)));

console.log("\n■ 人が選んだ物は減らさない（スタッフは常に外さない・除外しない）");
eq("スタッフ×ブレインでも brainDrop=false", M.behavior("staff", true).brainDrop, false);
eq("スタッフ×ブレインでも excludeSent=false", M.behavior("staff", true).excludeSent, false);
eq("スタッフ×ブレインでも自動化コマンドを claim しない", M.behavior("staff", true).claimCommands, false);

console.log("\n■ 完了で売上サポの回をまとめる（2026-09-25 竹内「完了ボタン押したらリアプロと itandi の全部分析」）");
eq("ブレイン×スタッフ は必ずまとめる", M.behavior("staff", true).completeGroup, true);
eq("ブレイン×通常 も押した時はまとめる", M.behavior("normal", true).completeGroup, true);
eq("ブレイン×AIX も押した時はまとめる", M.behavior("aix", true).completeGroup, true);
eq("ブレイン OFF は呼ばない（売上サポに届いていない）", M.MODES.map((m) => M.behavior(m, false).completeGroup), M.MODES.map(() => false));
eq("まとめる時は必ず売上サポに記録している（completeGroup ⇒ recordPickup）", M.MODES.flatMap((m) => [false, true].map((b) => !M.behavior(m, b).completeGroup || M.behavior(m, b).recordPickup)).every(Boolean), true);

console.log("\n■ ウェブの AIXツールの一括検索（web_brain）を受け取る PC（2026-09-25 竹内「ブレインモードのみで連動」）");
eq("ブレイン×通常・ブレイン×AIX・ブレイン×AIX(顧客) が受け取る", M.MODES.flatMap((m) => [false, true].map((b) => M.behavior(m, b).claimBrainCommands)), M.MODES.flatMap((m) => [false, true].map((b) => !!b && m !== "staff")));
eq("🧠×スタッフは受け取らない（スタッフは自動化を無視）", M.behavior("staff", true).claimBrainCommands, false);
eq("受け取る PC は必ずコマンドを claim する PC（claimBrainCommands ⇒ claimCommands）", M.MODES.flatMap((m) => [false, true].map((b) => !M.behavior(m, b).claimBrainCommands || M.behavior(m, b).claimCommands)).every(Boolean), true);
eq("受け取る PC は必ず AIXツールに記録する（claimBrainCommands ⇒ recordPickup）", M.MODES.flatMap((m) => [false, true].map((b) => !M.behavior(m, b).claimBrainCommands || M.behavior(m, b).recordPickup)).every(Boolean), true);
eq("帯: 受け取る組み合わせは一括検索を書く", [M.banner("normal", true).text, M.banner("aix", true).text].every((t) => /一括検索も受け取ります/.test(t)), true);
eq("帯: 名前は AIXツール（売上サポは出さない）", [M.banner("normal", true), M.banner("staff", true), M.banner("aix", true)].every((b) => /AIXツール/.test(b.text) && !/売上サポ/.test(b.text)), true);

console.log("\n■ 検索の点検（2026-09-25 竹内「ブレインモードで…検索がちゃんとされていなかったら原因を見つけられるようにする」）");
// 2026-11-11: AIX（ai）はブレイン OFF でも点検を送る（広げて検索が効くように）
eq("ブレインの時＋AIX の時は送る（スタッフ×ブレインも）", M.MODES.flatMap((m) => [false, true].map((b) => M.behavior(m, b).searchAudit)), M.MODES.flatMap((m) => [false, true].map((b) => !!b || m === "ai")));
eq("AIX はブレイン OFF でも点検を送る（広げて検索のため）", M.behavior("ai", false).searchAudit, true);
eq("通常・スタッフはブレイン OFF なら送らない", [M.behavior("normal", false).searchAudit, M.behavior("staff", false).searchAudit], [false, false]);
eq("ブレイン OFF で送るのは AIX だけ", M.MODES.map((m) => M.behavior(m, false).searchAudit), M.MODES.map((m) => m === "ai"));
// 2026-11-11: AIX（ai）はブレイン OFF でも点検を送る（判定はしない＝人が選んだお客さんの検索だから）。それ以外は判定とセット
eq("点検を送る時は判定もする（AIX は除く）", M.MODES.filter((m) => m !== "ai").flatMap((m) => [false, true].map((b) => !M.behavior(m, b).searchAudit || M.behavior(m, b).brainJudge)).every(Boolean), true);

console.log("\n■ バッジ・帯");
eq("バッジ（モード×ブレイン）", M.MODES.flatMap((m) => [false, true].map((b) => M.badge(m, b).text)), ["", "脳通", "手動", "手脳", "AIX", "脳", "顧客", "顧客脳"]);

console.log("\n■ 2026-11-11 AIX（選んだお客さんを自動で検索）");
{
  const ai = M.behavior("ai", false);
  eq("AIX は選んだお客さんの自動検索を開く", ai.aiCustomerSearch, true);
  eq("AIX は AIX 由来・自動便も受け取る", [ai.claimAix, ai.runAutoSchedule], [true, true]);
  eq("AIX は一括検索も受け取る（ブレイン OFF でも）", ai.claimCommands, true);
  eq("AIX は判定しない（人が選んだお客さん＝ブレイン OFF なら判定なし）", ai.brainJudge, false);
  eq("AIX × ブレイン は判定する", M.behavior("ai", true).brainJudge, true);
  eq("自動（aix）は aiCustomerSearch を開かない", M.behavior("aix", false).aiCustomerSearch, false);
  eq("通常・スタッフは開かない", [M.behavior("normal", false).aiCustomerSearch, M.behavior("staff", false).aiCustomerSearch], [false, false]);
  eq("書き戻し: AIX は aiMode=true・aixMode=false", M.storageUpdateForMode("ai", 1), { staffMode: false, staffModeAt: null, aixMode: false, autoModeAt: 1, aiMode: true });
  eq("読み戻し: aiMode=true → mode=ai", M.readState({ aiMode: true, autoModeAt: 1 }).mode, "ai");
  eq("スタッフが最優先（aiMode=true でも staff）", M.readState({ staffMode: true, staffModeAt: Date.now(), aiMode: true }).mode, "staff");
  eq("AIX も実効の動きで開く（GUIDE_ONLY 中でも）", M.effectiveBehavior("ai", false).aiCustomerSearch, true);
  eq("通常は実効で閉じる", M.effectiveBehavior("normal", true).aiCustomerSearch, false);
  eq("帯: AIX（ブレイン OFF）", M.banner("ai", false).cls, "aix");
  eq("帯: AIX×ブレイン", M.banner("ai", true).cls, "brain");
}
eq("帯: 通常×なし は出さない", M.banner("normal", false), null);
eq("帯: スタッフ", M.banner("staff", false).cls, "staff");
eq("帯: ブレイン×スタッフ", M.banner("staff", true).cls, "brain-staff");
eq("帯: AIX", M.banner("aix", false).cls, "aix");
// 2026-09-29 v2.5.40: 旧は「自動便は見送り」を正にしていた（v2.5.38 で自動便を走らせた後も文だけ古いまま＝小窓が「今も見送る」と誤解させた）
eq("帯: ブレイン×AIX は自動便も実行すると書く（見送りと書かない）", /自動便も実行/.test(M.banner("aix", true).text) && !/見送り/.test(M.banner("aix", true).text), true);
eq("帯の文と動きが合う: ブレイン×AIX は runAutoSchedule=true", M.behavior("aix", true).runAutoSchedule, true);
eq("帯: ブレイン×通常", M.banner("normal", true).cls, "brain");
eq("帯: スタッフの帯は2時間で自動OFFを書く", [M.banner("staff", false).text, M.banner("staff", true).text].every((t) => /2時間で自動OFF/.test(t)), true);

console.log("\n■ 検索の種類の覚え書き（2026-09-27 ピンポイント→足りなければ広げて・merge-pdfs の search_mode）");
{
  const M0 = M.rememberSearchMode({}, "c1", "realnetpro", false, NOW);
  eq("残す（サイトは realpro にそろえる）", M0, { "c1|realpro": { mode: "pinpoint", at: NOW } });
  eq("同じお客様×サイトで読む（リアプロの呼び名が違っても）", M.pickSearchMode(M0, "c1", "realpro", NOW + 5 * 60000), "pinpoint");
  const M1 = M.rememberSearchMode(M0, "c1", "itandi", true, NOW + 60000);
  eq("サイトごとに別（itandi は広げて）", [M.pickSearchMode(M1, "c1", "itandi", NOW + 120000), M.pickSearchMode(M1, "c1", "realnetpro", NOW + 120000)], ["widen", "pinpoint"]);
  eq("サイトが分からない送信はそのお客様の一番新しい値", M.pickSearchMode(M1, "c1", null, NOW + 120000), "widen");
  eq("別のお客様の値は使わない", M.pickSearchMode(M1, "c2", "realpro", NOW), null);
  eq("別のサイトの値は使わない（検索していないサイト）", M.pickSearchMode(M0, "c1", "itandi", NOW), null);
  eq("1時間を過ぎた値は使わない（分からない＝付けない）", M.pickSearchMode(M0, "c1", "realpro", NOW + M.SEARCH_MODE_TTL_MS + 1), null);
  eq("同じお客様×サイトは上書き（ピンポイントの後の広げて）", M.pickSearchMode(M.rememberSearchMode(M0, "c1", "realpro", true, NOW + 1000), "c1", "realpro", NOW + 2000), "widen");
  const old = M.rememberSearchMode(M0, "c9", "itandi", false, NOW + M.SEARCH_MODE_TTL_MS + 5000);
  eq("足す時に切れた物を捨てる", Object.keys(old), ["c9|itandi"]);
  eq("元の覚え書きは変えない", Object.keys(M0), ["c1|realpro"]);
  eq("壊れた値でも落ちない", [M.pickSearchMode(null, "c1", "realpro", NOW), M.pickSearchMode({ "c1|realpro": { mode: "x", at: NOW } }, "c1", "realpro", NOW), Object.keys(M.rememberSearchMode("x", null, "realpro", true, NOW))], [null, null, []]);
  let big = {};
  for (let i = 0; i < 250; i++) big = M.rememberSearchMode(big, "c" + i, "realpro", false, NOW + i);
  eq("多すぎる時は古い物から捨てる（200件）", [Object.keys(big).length, "c0|realpro" in big, "c249|realpro" in big], [200, false, true]);
  eq("名前: 広げて=widen・ピンポイント=pinpoint", [M.searchModeOf(true), M.searchModeOf(false)], ["widen", "pinpoint"]);
}

console.log("\n■ 検索の種類の配線（静かに外れないように）");
{
  const fs = require("fs"), path = require("path");
  const root = path.join(__dirname, "..", "..", "chrome-extension");
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const pp = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  eq("送信（callMergeApi）が search_mode を付ける", /search_mode:\s*searchMode/.test(bg) && /_searchModeFor\(payload\.property_customer_id, payload\.site\)/.test(bg), true);
  eq("一括の入口（_batchAutofill）で残す", /_rememberSearchMode\(customer && customer\.id, site, isWide\)/.test(bg), true);
  eq("個別の検索（popup の _auditTag）で残す", /core\.rememberSearchMode\(r && r\[_mk\], _cid, site, _wide/.test(pp), true);
}

// 2026-10-02 v2.5.69 竹内「ブレインで一般モードしてたらもう自動検索されないでね？」: 一時停止中は帯に出し、一括・自動便を受け取ると書かない
eq("帯: 一時停止中（AIX×ブレイン）は ⏸ と手の検索だけ", /^⏸ 自動の物件検索は一時停止中（手で押した検索だけ動きます）/.test(M.banner("aix", true, true).text) && !/一括検索も受け取ります|自動便も実行します/.test(M.banner("aix", true, true).text), true);
eq("帯: 一時停止中（通常×ブレインなし）も出す", !!M.banner("normal", false, true) && /一時停止中/.test(M.banner("normal", false, true).text), true);
eq("帯: スタッフモードは一時停止でも今まで通り", M.banner("staff", true, true).cls, "brain-staff");
eq("帯: 一時停止でない時は今まで通り", M.banner("aix", true, false).text, M.banner("aix", true).text);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
