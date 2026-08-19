import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// LINE公式アカウント @049jaapa の友だち追加URL群
const LINE_UNIVERSAL_URL = 'https://line.me/R/ti/p/%40049jaapa';
const LINE_CUSTOM_SCHEME = 'line://ti/p/%40049jaapa';
const LINE_ANDROID_INTENT =
  'intent://ti/p/@049jaapa#Intent;package=jp.naver.line.android;scheme=line;S.browser_fallback_url=' +
  encodeURIComponent(LINE_UNIVERSAL_URL) +
  ';end';

/**
 * ディープリンク試行ページを返す。
 * 302でカスタムスキーム（line://）に飛ばすとWKWebViewにブロックされるため、
 * HTML+JSで試行し、開けなかった場合はUniversal Linkにフォールバックする。
 * アンカータグ（ユーザーの直接タップ）も併置する（iOSのUniversal Linkは
 * ユーザージェスチャーがある場合のみ発火するため）。
 */
function deepLinkAttemptPage(primaryUrl: string, fallbackUrl: string): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>LINE友だち追加</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f5f7f6}
  .card{text-align:center;padding:32px 24px;max-width:340px;box-sizing:border-box}
  .spinner{width:36px;height:36px;border:4px solid #d9efe2;border-top-color:#06C755;border-radius:50%;margin:0 auto 20px;animation:sp .8s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  p{font-size:14px;color:#333;line-height:1.7;margin:0 0 20px}
  a.btn{display:block;background:#06C755;color:#fff;text-decoration:none;font-weight:bold;font-size:16px;padding:16px;border-radius:12px;margin-bottom:10px}
  a.sub{display:block;color:#06C755;font-size:13px;text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <p>LINEを起動しています…<br>自動で開かない場合は下のボタンをタップしてください</p>
  <a class="btn" href="${primaryUrl}">LINEで友だち追加</a>
  <a class="sub" href="${fallbackUrl}">開けない場合はこちら</a>
</div>
<script>
(function () {
  var primary = ${JSON.stringify(primaryUrl)};
  var fallback = ${JSON.stringify(fallbackUrl)};
  var opened = false;
  function markOpened() { opened = true; }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') markOpened();
  });
  window.addEventListener('pagehide', markOpened);
  try { window.location.href = primary; } catch (e) {}
  setTimeout(function () {
    if (!opened) { try { window.location.href = fallback; } catch (e) {} }
  }, 1500);
})();
</script>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

export async function GET(req: NextRequest) {
  const ua = req.headers.get('user-agent') || '';

  const isLineInApp = /\bLine\//i.test(ua); // LINEアプリ内ブラウザ（UAに "Line/12.x" 等）
  const isAndroid = /android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  // 1. LINEアプリ内ブラウザ:
  //    navigator.share()でトークに送ったこのURLをユーザーがタップした場合。
  //    line.me Universal LinkへHTTPSの302を返す。LINEはline.meドメインを
  //    ネイティブ処理するため、そのまま友だち追加画面が開く。
  if (isLineInApp) {
    return NextResponse.redirect(LINE_UNIVERSAL_URL, { status: 302 });
  }

  // 2. Android（TikTok WebView含む）: intent:// が最も成功率が高い
  if (isAndroid) {
    return deepLinkAttemptPage(LINE_ANDROID_INTENT, LINE_UNIVERSAL_URL);
  }

  // 3. iOS（TikTok WebView含む）: line:// を試行し、失敗時はUniversal Link
  if (isIOS) {
    return deepLinkAttemptPage(LINE_CUSTOM_SCHEME, LINE_UNIVERSAL_URL);
  }

  // 4. PC・その他: line.me（QRコード付きWebページが表示される）
  return NextResponse.redirect(LINE_UNIVERSAL_URL, { status: 302 });
}
