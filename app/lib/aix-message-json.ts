// app/lib/aix-message-json.ts
// AIX の文を {"message": "..."} の JSON で書かせる経路の読み取り（純関数・DB 依存なし）。
//
// 2026-10-06 ⑰（竹内「AIXテンプレートのズレ…実際のLINEと比べて根本的にずれている部分をみつけて改善する」）:
//   AIX【物件ピックアップ】の下書き 60日で 6通の末尾に『"}』が残り、先頭の名前の行が消えていた（9/20・10/04・10/05・スタッフが全部消して送った）。
//   原因は aix/action の `raw.match(/\{[\s\S]*\}/)` → JSON.parse → 失敗したら**生の出力をそのまま文にする**読み取り。
//   LLM が文字列の中に生の改行を入れると JSON.parse は失敗し、`{"message": "〇〇さん\n\n…"}` が文になる（後段で1行目が落ち、末尾の "} が残る）。
//   同じ読み取りが aix/action の十数か所にコピーされていた（設計知見「LLM に部品の JSON で書かせる経路は、読めない時に生の出力を文にしない」の取りこぼし）。
// 決め: ⑫ の joinAixJsonParts（app/lib/aix-json-parts.ts・読める部品だけ拾う・拾えなければ空・JSON の形が無い普通の文はそのまま）に
//   message の1部品で通す。読めた JSON に message が無い時も、旧の「生の JSON を文にする」をやめて空にする（呼び出し側の空の扱いに任せる）。
//   旧と同じく、二重に逃がした改行（\\n）は改行に戻す。
import { joinAixJsonParts } from "./aix-json-parts";

export type AixMessageRead = { text: string; salvaged: boolean; failed: boolean };

export function readAixMessageJson(raw: string | null | undefined): AixMessageRead {
  const j = joinAixJsonParts(String(raw ?? ""), ["message"]);
  return { text: j.text.replace(/\\n/g, "\n"), salvaged: j.salvaged, failed: j.failed };
}
