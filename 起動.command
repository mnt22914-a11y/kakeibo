#!/bin/bash
# ダブルクリックで家計簿を開く。終わるときはこの黒い画面を閉じる。
cd "$(dirname "$0")"
PORT=8765   # データはこの番号ごとに保存されるので変えないこと
python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
sleep 1
open "http://localhost:$PORT"
echo "家計簿を開きました → http://localhost:$PORT"
echo "終わるときはこのウィンドウを閉じてください。"
wait $SERVER
