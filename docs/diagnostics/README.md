# Diagnostics

Two standalone bring-up artifacts kept for triage. Neither is wired into the
main app — they exist to isolate the lowest layers when the full stack is
failing on a new device or a new OS.

## `milestone0/` — getUserMedia over LAN HTTPS

A minimal HTTPS server + page that just calls `getUserMedia()`. Use it when a
new phone can't open the studio's camera — it answers "is the local CA
installed correctly?" before involving MediaMTX or the control service.

```
node docs/diagnostics/milestone0/serve.mjs   # serves on :8443 with the cert in ../certs
```

Open `https://<LAN-IP>:8443/` on the phone. If the camera works here, the TLS
trust is fine and the issue lives further up the stack.

## `milestone1/` — single WHIP publisher

A bare page that publishes one camera to MediaMTX via WHIP, without the control
service or operator dashboard. Use it to isolate "does the WHIP path work" from
"does the orchestration work". Expects MediaMTX already running on the same
origin (e.g. via `npm run up`).

Open `https://<LAN-IP>:8443/milestone1/` (you'd need to copy the file into the
serving root, or run `dev-server.mjs` pointed at this directory).
