#!/bin/sh
dir="${FAKE_TAILSCALE_DIR:?}"
echo "$*" >> "$dir/calls.log"
case "$1" in
  --version)
    echo "1.80.0"
    exit 0
    ;;
  status)
    cat "$dir/status.json"
    exit 0
    ;;
  up)
    for a in "$@"; do
      case "$a" in
        --auth-key=file:*)
          keyfile="${a#--auth-key=file:}"
          cp "$keyfile" "$dir/authkey.seen"
          echo "$keyfile" > "$dir/authkey.path"
          ;;
      esac
    done
    if [ -f "$dir/up-fail" ]; then
      echo "backend error: invalid key: $(cat "$dir/authkey.seen" 2>/dev/null)" >&2
      exit 1
    fi
    exit 0
    ;;
  down)
    exit 0
    ;;
  serve)
    if [ "$2" = "status" ]; then
      if [ -f "$dir/serve.json" ]; then cat "$dir/serve.json"; else echo "{}"; fi
      exit 0
    fi
    if [ "$2" = "--bg" ]; then
      printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"box.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$4" > "$dir/serve.json"
      exit 0
    fi
    if [ "$3" = "off" ]; then
      rm -f "$dir/serve.json"
      exit 0
    fi
    exit 1
    ;;
  whois)
    port="${3##*:}"
    if grep -qx "$port" "$dir/whois-ports" 2>/dev/null; then
      echo '{"Node":{"Name":"laptop.tail1234.ts.net.","Addresses":["100.88.1.2/32","fd7a:115c:a1e0::1:2/128"]},"UserProfile":{"LoginName":"owner@example.test"}}'
      exit 0
    fi
    echo "no match for IP:port" >&2
    exit 1
    ;;
esac
exit 1
