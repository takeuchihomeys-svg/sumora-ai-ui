"use client";
// /pickup-prerender — パソコンで「お客様に送る物件の画像」を先に作って保存する画面（人が見る必要はない）。
// 2026-09-27 竹内「画像をそのままの蓮産業の画像で保存していたらそのまま使える。ここちゃんとできるようにする」
//   拡張（Windows の Chrome・v2.5.33〜）が資料の届いた後と10分おきに、裏の画面（offscreen）の iframe でここを開く。
//   手で埋める時: パソコンの Chrome でこの画面を開く（?ids=628 で行を指定もできる）。
//   終わったら親（拡張の裏の画面）に { type: "axlx-prerender-done", ... } を知らせる。
import { useEffect, useRef, useState } from "react";
import { prerenderPickupImages, deviceHasRealproFont } from "@/app/lib/pickup-prerender-browser";

const INTERNAL_AUTH_HEADER = { Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` };

export default function PickupPrerenderPage() {
  const [lines, setLines] = useState<string[]>([]);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const add = (s: string) => setLines((a) => [...a, s]);
    const notify = (payload: object) => { try { if (window.parent !== window) window.parent.postMessage({ type: "axlx-prerender-done", ...payload }, "*"); } catch { /* 無視 */ } };
    (async () => {
      const sp = new URLSearchParams(window.location.search);
      const ids = (sp.get("ids") ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!deviceHasRealproFont()) {
        add("この端末には資料の書体（MS ゴシック）がありません。Windows のパソコンの Chrome で開いてください");
        notify({ ok: false, fontMissing: true, made: 0 });
        return;
      }
      try {
        // 2026-09-27: 1回10件×10分おきだと 32件の回がそろうまで約47分かかった（その間スマホで押すと画像が無い）。
        //   拡張が裏の画面を閉じる4分の手前（3分20秒）まで、残りが0になるか作れなくなるまで続けて回す
        const startedAt = Date.now();
        let made = 0, listed = 0, failed = 0, fontMissing = false;
        for (;;) {
          const r = await prerenderPickupImages({ authHeader: INTERNAL_AUTH_HEADER, ids: ids.length ? ids : undefined, onLog: add });
          add(r.message);
          made += r.made; listed += r.listed; failed += r.failed.length; fontMissing = r.fontMissing;
          if (ids.length || r.listed === 0 || r.made === 0 || r.fontMissing || Date.now() - startedAt > 200_000) break;
        }
        notify({ ok: true, made, listed, failed, fontMissing });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        add(`⚠ ${msg}`);
        notify({ ok: false, error: msg, made: 0 });
      }
    })();
  }, []);
  return (
    <main style={{ padding: 16, fontSize: 13, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 15, fontWeight: 700 }}>送る物件の画像を作る（元の資料の1ページ目そのまま）</h1>
      {lines.length === 0 ? <p>作っています…</p> : <ul>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </main>
  );
}
