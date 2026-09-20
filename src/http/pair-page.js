export function pairPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Expense bot pairing</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; max-width: 40rem; }
    h1 { font-size: 1.25rem; }
    p, li { line-height: 1.45; }
    .qr { width: min(280px, 80vw); height: auto; background: #fff; padding: 12px; border-radius: 8px; }
    .code { font-size: 1.8rem; letter-spacing: 0.2em; font-family: ui-monospace, monospace; }
    .hidden { display: none; }
    .status { font-weight: 600; }
  </style>
</head>
<body>
  <h1>Expense bot pairing</h1>
  <p class="status" id="status">Checking WhatsApp…</p>
  <img id="qr" class="qr hidden" alt="WhatsApp QR code" />
  <p id="codeWrap" class="hidden">Pairing code: <span class="code" id="code"></span></p>
  <ol>
    <li>On another screen: WhatsApp → Linked devices → Link a device → scan the QR.</li>
    <li>On this same phone: Linked devices → Link with phone number → enter the pairing code.</li>
  </ol>
  <p>This page refreshes the QR automatically. Bookmark it with the token still in the URL.</p>
  <script>
    const token = new URLSearchParams(location.search).get("token") || ""
    async function tick() {
      const res = await fetch("/pair/state?token=" + encodeURIComponent(token))
      if (res.status === 401) {
        document.getElementById("status").textContent = "Invalid pairing token."
        return
      }
      const data = await res.json()
      const status = document.getElementById("status")
      const qr = document.getElementById("qr")
      const codeWrap = document.getElementById("codeWrap")
      const code = document.getElementById("code")
      if (data.status === "open") {
        status.textContent = "Expense bot is linked."
        qr.classList.add("hidden")
        codeWrap.classList.add("hidden")
      } else if (data.qrImage) {
        status.textContent = data.status === "logged_out"
          ? "Session lost. Scan again."
          : "Scan this QR, or type the pairing code."
        qr.src = data.qrImage
        qr.classList.remove("hidden")
        if (data.pairingCode) {
          code.textContent = data.pairingCode
          codeWrap.classList.remove("hidden")
        } else {
          codeWrap.classList.add("hidden")
        }
      } else {
        status.textContent = "Waiting for WhatsApp… (" + data.status + ")"
        qr.classList.add("hidden")
      }
    }
    tick()
    setInterval(tick, 2000)
  </script>
</body>
</html>`
}
