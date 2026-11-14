// 写真から学ぶ（2026-11-14 竹内さん「いままでの画像から統括がまなぶことできないのか」
//   「ここちゃんと統括が理解したら学習の質かなりよくなる」）
//
// なぜ要るか:
//   操作の記録（shot_ops）が 12% しか無い。だが**写真は 4318枚ある**。
//   → 写真だけで「画面が変わった瞬間」を学ぶ（操作の記録が無くても分かる）。
//
// ⚠ 写真の中身（文字・物件名）は読まない。見るのは画面全体の明るさの並びだけ（費用0）。
//
// 実行: npx tsx app/lib/__tests__/learn-from-images.test.ts
import { framesDiffer, learnFromFrames, type FrameHash } from "../learn-from-images";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

/** 疑似の画面（明るさを全部同じ値で作る） */
const frame = (v: number): FrameHash => ({ sig: new Array(144).fill(v), bright: v });
const at = (sec: number) => new Date(Date.parse("2026-11-14T15:00:00+09:00") + sec * 1000).toISOString();

console.log("■ ① 画面が変わったかを判定する");
{
  ok("同じ画面は変わっていない", framesDiffer(frame(100), frame(100)) === false);
  ok("少しの違いは変わっていない（カーソルが動いた程度）", framesDiffer(frame(100), frame(108)) === false);
  ok("大きく変わったら true", framesDiffer(frame(100), frame(160)) === true);
  ok("null は比べない（落ちない）", framesDiffer(null, frame(100)) === false && framesDiffer(frame(100), null) === false);
  ok("sig が壊れていても落ちない", framesDiffer({ sig: [], bright: 0 }, frame(100)) === false);
}

console.log("\n■ ② 画面が変わった回数と間隔を学ぶ");
{
  // 0秒=画面A → 2秒=画面A(同じ) → 4秒=画面B(変化) → 6秒=画面B → 8秒=画面C(変化)
  const learned = learnFromFrames([
    { at: at(0), hash: frame(100) },
    { at: at(2), hash: frame(100) },
    { at: at(4), hash: frame(160) },
    { at: at(6), hash: frame(160) },
    { at: at(8), hash: frame(60) },
  ]);
  ok("写真 5枚", learned.n === 5, learned.n);
  ok("画面が変わったのは2回", learned.changes === 2, learned.changes);
  ok("変化のあった時刻が残る", learned.changeAt.length === 2, learned.changeAt);
  ok("1段の時間（中央値）が出る", learned.step_ms != null && learned.step_ms >= 2000, learned.step_ms);
  ok("写真の間隔（中央値）が出る", learned.shot_gap_ms === 2000, learned.shot_gap_ms);
}

console.log("\n■ ③ 「止まっている」を見つける");
{
  const learned = learnFromFrames(Array.from({ length: 20 }, (_, i) => ({ at: at(i * 0.5), hash: frame(100) })));
  ok("変化 0回", learned.changes === 0, learned.changes);
  ok("  ⚠ 止まっている疑いを言う", !!learned.top_note && learned.top_note.includes("止まっている"), learned.top_note);
}

console.log("\n■ ④ 「押し直し・迷い」を見つける");
{
  // 0.5秒ごとに画面が激しく変わる（A→B→A→B…）
  const learned = learnFromFrames(
    Array.from({ length: 20 }, (_, i) => ({ at: at(i * 0.5), hash: frame(i % 2 ? 40 : 200) })),
  );
  ok("変化が多い", learned.changes >= 10, learned.changes);
  ok("  ⚠ 押し直し・迷いの疑いを言う", !!learned.top_note && learned.top_note.includes("押し直し"), learned.top_note);
}

console.log("\n■ ⑤ 壊れない");
{
  ok("空", learnFromFrames([]).n === 0);
  ok("1枚だけ", learnFromFrames([{ at: at(0), hash: frame(100) }]).changes === 0);
  ok("at が無い物は除く", learnFromFrames([{ at: null, hash: frame(100) }, { at: at(1), hash: frame(200) }]).n === 1);
  ok("hash が null でも落ちない", (() => {
    const r = learnFromFrames([{ at: at(0), hash: null }, { at: at(1), hash: null }]);
    return r.n === 2 && r.changes === 0;
  })());
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
