// chrome-extension/mode-core.js
// 動作モードの「storage の値 → 今のモード → 何が起きるか」を1か所で持つ純関数（popup.js・background.js・テストが同じ物を使う）。
//
// 2026-09-25 竹内「スタッフモード等はこのブレインの横に付ける。ブレインだけ別で、ほかはドロップダウン方式で行う。
//   ブレインでもスタッフモードや AIX モード、通常モードを行うため」
//   旧（v2.5.9〜2.5.19）: 1つの select で 通常／スタッフ／AIX連動／ブレイン の4択（ブレイン＝AIX連動＋判定・排他）
//   新（v2.5.20〜）   : 「🧠 ブレイン」の切り替え（ON/OFF）＋ 横に「モード」のドロップダウン（通常／スタッフ／AIX連動）。
//                       ブレインは3つのどれとも組み合わせられる（ブレイン×通常・ブレイン×スタッフ・ブレイン×AIX）。
//
// storage のキーは今まで通り（変えると background・bulk-dl・itandi-bulk-dl の読み取りが全部ずれる）:
//   staffMode / staffModeAt … スタッフモード（2時間の TTL・background._isStaffModeActive が切れたら staffMode:false を書く）
//   aixMode                 … AIX連動（pending?aix=1 で AIX 由来・11:00/17:00 の自動便も claim）
//   brainMode               … ブレイン。**意味だけ変わる**: 旧は aixMode と両方 true の時だけ ON、新は brainMode 単独で ON。
// 前の値からの移し替え（書き込みは要らない）:
//   旧「ブレイン」{aixMode:true, brainMode:true} → 新 ブレイン×AIX（同じ動き）
//   旧「AIX連動」{aixMode:true, brainMode:false} → 新 AIX（同じ）／旧「スタッフ」→ スタッフ（brainMode は旧 _applyMode が false を書いている）
//   旧「通常」→ 通常。旧 _applyMode は brainMode:true を必ず aixMode:true と一緒に書いていたので、{aixMode:false, brainMode:true} は旧版には無い
//   （＝意味が変わって動きが変わる PC は無い）。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxModeCore = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var STAFF_MODE_TTL_MS = 2 * 60 * 60 * 1000; // 2時間で自動OFF（background.js・bulk-dl.js・itandi-bulk-dl.js と同じ）
  var MODES = ["normal", "staff", "aix"];
  var STORAGE_KEYS = ["staffMode", "staffModeAt", "aixMode", "brainMode"];

  // storage の生の値 → { mode, brain, staffExpired }
  //   スタッフとAIXが両方 true（旧版の書き込み途中など）はスタッフを優先（旧 _modeFromFlags と同じ・自動化を止める側に倒す）。
  //   スタッフの TTL が切れていたら staffExpired=true・mode はスタッフ以外で読む（書き戻しは background が行う）。
  function readState(raw, now) {
    var st = raw || {};
    var t = typeof now === "number" ? now : Date.now();
    var at = st.staffModeAt || 0;
    var staffExpired = !!st.staffMode && !!at && t - at > STAFF_MODE_TTL_MS;
    var staff = !!st.staffMode && !staffExpired;
    var mode = staff ? "staff" : (st.aixMode ? "aix" : "normal");
    return { mode: mode, brain: !!st.brainMode, staffExpired: staffExpired };
  }

  // ドロップダウンでモードを選んだ時に書く値（brainMode には触らない＝ブレインは独立）
  function storageUpdateForMode(mode, now) {
    var t = typeof now === "number" ? now : Date.now();
    if (mode === "staff") return { staffMode: true, staffModeAt: t, aixMode: false };
    if (mode === "aix") return { staffMode: false, staffModeAt: null, aixMode: true };
    return { staffMode: false, staffModeAt: null, aixMode: false };
  }

  // ブレインの切り替えで書く値（モードには触らない）
  function storageUpdateForBrain(on) {
    return { brainMode: !!on };
  }

  // 組み合わせ → 何が起きるか（ここが仕様の表。tests/chrome-extension/mode-core.test.js で固定）
  //   claimCommands   … 自動化コマンド（一括検索・Realtime）を claim するか（スタッフは claim しない＝別PCが拾う）
  //   claimAix        … AIX 由来・11:00/17:00 の自動便を受け取るか（pending?aix=1）
  //   autoSend        … 検索結果の自動送信（手動ボタンは別で、どのモードでも送れる）
  //   excludeSent     … merge-pdfs で一度送った建物を外すか（スタッフは外さない＝人が選んだ物は減らさない）
  //   brainJudge      … 送信前に /api/property-brain/judge で判定するか（リアプロの一括DL・自動送信）
  //   brainDrop       … 判定の drop を実際に外してよいか（サーバーの PROPERTY_BRAIN_DROP=on の時だけ効く。スタッフは常に外さない）
  //   brainNote       … LINE（売上番長グループ）の説明文の末尾に「🧠 ブレイン判定 …」の1ブロックを付けるか
  //   recordPickup    … merge-pdfs に brain_mode=true を送る＝売上サポ（property_pickups）に1回分を記録（画像化・DeepSeek の費用あり）
  //   runAutoSchedule … 11:00/17:00 の自動便（auto_schedule）を実行するか（ブレイン中は見送り＝2026-09-24 竹内「ブレインモードなら AIX の自動便は連動しない」）
  function behavior(mode, brain) {
    var m = MODES.indexOf(mode) >= 0 ? mode : "normal";
    var b = !!brain;
    var staff = m === "staff";
    return {
      mode: m,
      brain: b,
      claimCommands: !staff,
      claimAix: m === "aix",
      autoSend: !staff,
      excludeSent: !staff,
      brainJudge: b,
      // スタッフ × ブレイン: 判定は記録と印のためだけ。拡張でも外さない（サーバーも staff_mode=true で apply_drop=false・二重の歯止め）
      brainDrop: b && !staff,
      // スタッフ × ブレイン: スタッフが手で送る説明文は今まで通り（判定の1ブロックを足さない）。判定はコンソールと property_brain_judgments に残る
      //   → 竹内さんに確認: スタッフの送信にも「🧠 ブレイン判定」の1ブロックを付けるか（今は安全側＝付けない）
      brainNote: b && !staff,
      recordPickup: b,
      // 自動便は AIX の PC にしか届かない（pending?aix=1）。ブレイン×AIX は旧「ブレイン」と同じく見送り
      //   → 竹内さんに確認: ブレイン×AIX を選んだ時は自動便も走らせるか（今は旧「ブレイン」と同じ＝見送り）
      runAutoSchedule: m === "aix" && !b,
    };
  }

  // 拡張アイコンのバッジ（優先: スタッフ > AIX > 通常。ブレインは「脳」を足す）
  //   旧「ブレイン」＝ブレイン×AIX は旧と同じ「脳」、ブレイン×通常は「脳通」、ブレイン×スタッフは「手脳」
  function badge(mode, brain) {
    var b = !!brain;
    if (mode === "staff") return { text: b ? "手脳" : "手動", color: "#16a34a" };
    if (mode === "aix") return b ? { text: "脳", color: "#0ea5e9" } : { text: "AIX", color: "#7c3aed" };
    return b ? { text: "脳通", color: "#0ea5e9" } : { text: "", color: "#7c3aed" };
  }

  // ヘッダー直下の帯（組み合わせで文言を変える）。null = 帯を出さない（通常・ブレインOFF）
  function banner(mode, brain) {
    var b = !!brain;
    if (mode === "staff") {
      return b
        ? { cls: "brain-staff", text: "🧠 ブレイン × スタッフモード — 自動化は停止中（手動のみ・2時間で自動OFF）。手で送る物件もブレインが判定し売上サポに記録します（物件は外しません）" }
        : { cls: "staff", text: "スタッフモード中 — 自動化は停止しています（手動操作のみ・2時間で自動OFF）" };
    }
    if (mode === "aix") {
      return b
        ? { cls: "brain", text: "🧠 ブレイン × AIX連動 — AIXの指示に連動して自動検索し、お客様の条件・過去の物件出し・利益（AD−割引）で判定してから売上番長グループへ送ります（11:00／17:00 の自動便は見送り）" }
        : { cls: "aix", text: "AIXモード中 — AIXの指示（物件ピックアップ・物件オススメ）に連動して自動で物件検索し、売上番長グループへ送ります" };
    }
    return b
      ? { cls: "brain", text: "🧠 ブレイン × 通常 — 送る物件をお客様の条件・過去の物件出し・利益（AD−割引）で判定してから売上番長グループへ送り、売上サポに記録します" }
      : null;
  }

  return {
    STAFF_MODE_TTL_MS: STAFF_MODE_TTL_MS,
    MODES: MODES,
    STORAGE_KEYS: STORAGE_KEYS,
    readState: readState,
    storageUpdateForMode: storageUpdateForMode,
    storageUpdateForBrain: storageUpdateForBrain,
    behavior: behavior,
    badge: badge,
    banner: banner,
  };
});
