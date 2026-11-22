// #461 ①（2026-11-21 作業員G）: 引用された画像の物件を引用の時点で読むスイッチ（既定 off）
// 実行: npx tsx app/lib/__tests__/quoted-image-property-read.test.ts
import { quotedImagePropertyReadOn } from "../quoted-note";
let failed = 0;
function check(name: string, got: boolean, want: boolean) { if (got !== want) { failed++; console.log(`  ✗ ${name}: ${got}`); } else console.log(`  ✓ ${name}`); }
check("未設定は off", quotedImagePropertyReadOn({}), false);
check("on", quotedImagePropertyReadOn({ QUOTED_IMAGE_PROPERTY_READ: "on" }), true);
check(" ON （空白・大文字）", quotedImagePropertyReadOn({ QUOTED_IMAGE_PROPERTY_READ: " ON " }), true);
check("off", quotedImagePropertyReadOn({ QUOTED_IMAGE_PROPERTY_READ: "off" }), false);
check("1 は on ではない", quotedImagePropertyReadOn({ QUOTED_IMAGE_PROPERTY_READ: "1" }), false);
if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
