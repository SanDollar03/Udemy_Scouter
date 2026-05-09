# Udemy Scouter

Python + Flask で動く、スカウター風の LAN / HTTPS 対応デモです。アクセスした **クライアント側ブラウザのカメラ** を使って人物を検知し、計測開始で擬似的な戦闘力を演出付きで表示します。

## 今回のUI / 演出

- ヘッダーはシンプルな `Udemy Scouter`
- フッターに `カメラ接続` と `計測開始`
- カメラ表示はヘッダー・フッターを除いてほぼ全画面
- 人物を検知すると、人物周囲にスカウター風の輪郭・ロック演出
- 計測開始で起動演出 + 起動電子音
- 計測中は人物周囲にスキャンリングを出しながら戦闘力が徐々に上昇
- 計測中は `ピピピピ` の連続電子音
- 確定時は `ピーピーピー` の確定電子音

## 起動方法

```bash
cd scouter_flask_app
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Windows PowerShell:

```powershell
cd scouter_flask_app
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

## アクセス

デフォルト設定:

- Host: `0.0.0.0`
- Port: `5020`
- HTTPS: 有効

起動後は同一ネットワーク内の端末から、次のいずれかでアクセスします。

- `https://<サーバーPCのIPアドレス>:5020`
- `https://localhost:5020`

サーバー起動時に利用候補 URL がコンソールへ表示されます。

## HTTPS / 証明書

起動時、`certs/` 配下にローカル CA とサーバー証明書を自動生成します。

生成されるファイル:

- `certs/scouter-root-ca.pem`
- `certs/scouter-root-ca-key.pem`
- `certs/scouter-server-cert.pem`
- `certs/scouter-server-key.pem`

クライアント端末で証明書を信頼させたい場合は、公開 CA 証明書を使います。

- 配布用: `scouter-root-ca.pem`
- 秘密鍵: `scouter-root-ca-key.pem` は配布禁止

ブラウザからは `https://<サーバーIP>:5020/ca-cert` でも取得できます。

## API

- `GET /` : UI
- `GET /health` : HTTPS / アクセス情報
- `GET /ca-cert` : CA 証明書ダウンロード
- `POST /track` : プレビュー用の人物検知
- `POST /analyze` : 計測用の戦闘力解析

## 実装メモ

- 人物検知は OpenCV の顔検知 / 上半身検知を段階的に使っています。
- 輪郭は検知ボックスからスカウター風の人物シルエットに変換して描画しています。
- 戦闘力は演出用の擬似スコアです。
- カメラは常に **そのページを開いたクライアント端末のブラウザ** を使います。

## 調整したい箇所

- `static/app.js`
  - 起動音: `playBootSound()`
  - 計測音: `playMeasureLoop()`
  - 確定音: `playConfirmSound()`
  - 上昇速度: `startRisingCounter()`
  - プレビュー検知間隔: `startTrackingLoop()`
- `app.py`
  - 戦闘力ロジック: `score_power()`
  - メッセージ分岐: `message_for()`
  - 追尾の安定度: `calculate_signal_strength()`
- `static/style.css`
  - ヘッダー / フッター高さ
  - HUD の色味や透過感

## 構文確認

実行環境に Flask が未導入だったため、ここでは実起動までは行っていません。以下は確認済みです。

- `python -m py_compile app.py`
- `node --check static/app.js`
