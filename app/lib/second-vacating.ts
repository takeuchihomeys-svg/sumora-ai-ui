// app/lib/second-vacating.ts — AIX の2通目に退去予定を渡す範囲のスイッチ（2026-11-18 作業員L・作業員K の試験 e30d8453 の穴）
//   SECOND_VACATING_ALL_AIX=on（既定 off）: 物件オススメ／ピックアップ以外の AIX（物件確認した 等）の2通目でも、1通目の本文→送った資料の画像の読みで退去予定を読む。
//   読み方は recommend-viewable（resolveRecommendViewable・mentionsVacating）と recommend-vacating-source（sipVacating）の今ある関数のまま。
type Env = Record<string, string | undefined>;
export const secondVacatingAllOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.SECOND_VACATING_ALL_AIX ?? "").trim().toLowerCase() === "on";
