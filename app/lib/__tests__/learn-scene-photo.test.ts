// 実行: npx tsx app/lib/__tests__/learn-scene-photo.test.ts
// 2026-11-18 竹内さん「場面ごとの強化を画像学習にも紐づける」:
//   写真の場面（area=所在地・station=沿線駅…）が確かな行だけ、場面別の位置（byScene）を作る。
//   場面が無い・other の行は入れない（推測で場面を付けない）。n≥2 の欄だけ残す。
import { learnFromShots } from "../shot-learn";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}

function row(scene: string | null, screen: string, fields: Array<{ name: string; kind: string; x: number; y: number }>) {
  return {
    url: "https://example.test/",
    shot_ops: [{ f: fields[0]?.name ?? "x" }],
    shot_learn: { screen, ...(scene ? { scene } : {}), fields: fields.map((f) => ({ ...f, zone: "left" })) },
    mode: "normal",
  } as never;
}

console.log("■ 場面別の位置（learnFromShots.byScene）");
{
  const rows = [
    row("area", "form", [{ name: "city_code[]", kind: "checkbox", x: 0.2, y: 0.30 }]),
    row("area", "form", [{ name: "city_code[]", kind: "checkbox", x: 0.4, y: 0.50 }]),
    row("area", "form", [{ name: "city_code[]", kind: "checkbox", x: 0.3, y: 0.40 }]),
    row("station", "form", [{ name: "city_code[]", kind: "checkbox", x: 0.8, y: 0.90 }]),
    row("station", "form", [{ name: "city_code[]", kind: "checkbox", x: 0.8, y: 0.92 }]),
    // 場面なし・other は場面別に入れない（画面位置 form には入る）
    row(null, "form", [{ name: "city_code[]", kind: "checkbox", x: 0.1, y: 0.1 }]),
    row("other", "form", [{ name: "city_code[]", kind: "checkbox", x: 0.1, y: 0.1 }]),
    // 1枚だけの欄（n<2）は場面別に載せない
    row("cond", "form", [{ name: "room_layout_id[]", kind: "checkbox", x: 0.5, y: 0.5 }]),
  ];
  const r = learnFromShots(rows as never, { mode: "normal" });
  const area = (r.byScene.area ?? []).find((f) => f.name === "city_code[]");
  const st = (r.byScene.station ?? []).find((f) => f.name === "city_code[]");
  t("area の city_code[] が場面別に残る", !!area, r.byScene);
  t("area の n は3（場面なしの行を混ぜない）", area?.n === 3, area);
  t("area の位置は中央値（0.3, 0.4）", area?.x === 0.3 && area?.y === 0.4, area);
  t("station は area と別の位置（混ざらない）", !!st && st.x === 0.8 && st.y === 0.91, st);
  t("n=1 の欄は byScene に入らない", !(r.byScene.cond ?? []).some((f) => f.name === "room_layout_id[]"), r.byScene.cond);
  t("other・場面なしは byScene のキーに出ない", !("other" in r.byScene) && Object.keys(r.byScene).every((k) => ["area", "station"].includes(k)), Object.keys(r.byScene));
  // 画面単位（従来）は変わらず、場面なしの行も form に入る
  const formCity = (r.screens.form?.fields ?? []).find((f) => f.name === "city_code[]");
  t("画面単位 form は従来どおり（場面なしも含む）", !!formCity && formCity.n >= 5, formCity);
}

console.log("\n■ 場面の印が無い写真だけ（byScene は空）");
{
  const r = learnFromShots([row(null, "form", [{ name: "a", kind: "text", x: 0.1, y: 0.1 }]), row(null, "form", [{ name: "a", kind: "text", x: 0.1, y: 0.1 }])] as never, { mode: "normal" });
  t("byScene は空オブジェクト", Object.keys(r.byScene).length === 0, r.byScene);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
