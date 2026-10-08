const config = await (await fetch('/api/config')).json();
const connection = config.connection;
if (connection?.httpsUrl) {
  document.getElementById('httpsLink').href = connection.httpsUrl;
  document.getElementById('connection').textContent = '音声対応の接続先：' + connection.httpsUrl;
} else {
  document.getElementById('connection').textContent = 'このサーバーではHTTPSが設定されていません。';
}
document.getElementById('fingerprint').textContent = connection?.certificateFingerprint || '未設定';
