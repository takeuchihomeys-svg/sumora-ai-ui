// app/lib/interior-tone.ts（純関数・DB/DeepSeek 依存なし・画面とサーバーで共用できる）
// 物件資料の室内写真から「内装の基調色（白基調か）」を読む問いと、答えの読み取り・お客様の希望（白基調）の見分け。
//
// 2026-10-07 竹内（会話「し」・角田さん 白基調の希望）「画像から部屋の色判断は出来ひんかな？白基調希望のお客様で画像で色も判断できるなら出来れば理想」
//   スタッフの理想の文:「こちらの2部屋白基調のお部屋では御座いませんが、敷金礼金0円の為初期費用面を抑える事が出来ます！！」
//   今の読み取り（image_lines＝文字層・sheet-read＝切り出した間取り図・property-brain-image＝有無5項目）はどれも室内写真の色を読まない。
// ■ 試した事（2026-10-07・DeepSeek flash・推論なし・scripts/_tmp_pickfit/tone_*.ts）
//   ① 床・壁の色を選択肢（白／明るい木目／木目…）で聞く → 30枚中ほぼ全部「明るい木目」（見分けない）
//   ② 「白基調と言えるか」を直接聞く → 9枚中 5 当たり（白い壁×グレーの床を白基調と言う）
//   ③ 床の明るさを 1〜5 で聞く（いま）→ PDF を 2.5倍で描いて室内写真のマスだけ切った物で、3以上（＝白基調ではない）は目で見て 9/9 当たり、
//      1〜2 は「白に近い」（白基調も、薄いグレー・薄いベージュの床も入る＝言い切れない）。資料の画像（ページ全体）だと 3以上 5/6
// ■ 決め
//   - 読むのは物件資料の室内写真だけ（お客様の画像は読まない・設計知見「別クラウドに出してよいのは物件資料だけ」）
//   - 白基調か は決定論: 居室の写真が無い→null／床3以上→false（白基調ではない）／床1かつアクセントの壁なし→true／それ以外→null（分からない）
//     スタッフの線（会話「し」）: 白い壁でも床が木目なら「白基調ではない」（OPUS）。白い壁×薄いグレーの床（MFPR）も「ではない」だが、
//     ここは 2 と読まれ null（言い切らない側）
//   - 推論なし・温度0・答えは JSON 1行（1枚 入力約480・出力16トークン＝約$0.0001・約3秒）

export type InteriorTone = {
  /** 居室（床と壁が見える部屋）の写真があるか */
  photos: boolean;
  /** 床の明るさ 1（白）〜5（こげ茶・黒）・分からなければ null */
  floor: number | null;
  /** 白以外の壁（木目・黒・柄）が目立つか */
  accent: boolean;
  /** 決定論の結論: 白基調か（true/false）・分からない（null） */
  whiteBased: boolean | null;
  /** 注記・画面に出す短い言葉 */
  label: string;
};

/** system は固定（DeepSeek の自動前置きキャッシュが効く）。お客様の情報は入れない */
export const INTERIOR_TONE_SYSTEM = "あなたは賃貸物件の室内写真を見る係です。出力は JSON オブジェクト1つだけ（説明文なし）。";

export const INTERIOR_TONE_QUESTION =
  "居室（床と壁が見える部屋）の写真があるか、ある時はその床の色の明るさを 1〜5 で答えてください" +
  "（1=白・ほぼ白／2=白っぽい薄いグレーやベージュ／3=明るい木の色（黄みのある薄茶）／4=中間の茶色・オレンジがかった木の色・濃いグレー／5=こげ茶・黒）。" +
  "外観・共用部・エントランス・地図・間取り図・設備の写真は居室に数えません。壁が白以外（木目・黒・柄のアクセント）の面が目立つかも答えてください。\n" +
  "{\"photos\":true/false,\"floor\":1〜5,\"accent_wall\":true/false}";

/** 答えから JSON を取り出す（前後に文が付いても）。読めなければ null */
export function parseInteriorTone(text: string | null | undefined): InteriorTone | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  if (o.photos === undefined && o.floor === undefined) return null;
  const photos = o.photos === true || o.photos === "true";
  const f = Number(o.floor);
  const floor = Number.isInteger(f) && f >= 1 && f <= 5 ? f : null;
  const accent = o.accent_wall === true || o.accent_wall === "true";
  return toneOf(photos, floor, accent);
}

/** 床の明るさ・アクセントの壁から白基調かを決める（決定論・上の「決め」） */
export function toneOf(photos: boolean, floor: number | null, accent: boolean): InteriorTone {
  let whiteBased: boolean | null = null;
  if (photos && floor != null) {
    if (floor >= 3) whiteBased = false;
    else if (floor === 1 && !accent) whiteBased = true;
  }
  const label = !photos ? "居室の写真なし"
    : floor == null ? "床の色が読めない"
    : `${["", "白い床", "白に近い床", "明るい木目の床", "茶色の床", "濃い色の床"][floor]}${accent ? "・色のある壁" : ""}`;
  return { photos, floor: photos ? floor : null, accent, whiteBased, label };
}

/** お客様の希望に「白基調・内装白」があるか（条件欄・会話の節） */
export const WHITE_INTERIOR_WANT_RE = /白基調|内装(?:が|は)?(?:白|ホワイト)|白(?:い|色の?|系の?)(?:内装|お部屋|部屋|床|フローリング)|ホワイト(?:基調|系)|白っぽい(?:内装|部屋|お部屋)|白内装/;
export function wantsWhiteInterior(text: string | null | undefined): boolean {
  return WHITE_INTERIOR_WANT_RE.test(String(text ?? ""));
}
