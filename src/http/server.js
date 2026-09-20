import http from "node:http"
import { timingSafeEqual } from "node:crypto"
import QRCode from "qrcode"
import { pairPageHtml } from "./pair-page.js"

export function startHttpServer({ port, pairToken, state, startedAt, checkSheets }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
      if (req.method === "GET" && url.pathname === "/live") {
        return json(res, 200, { ok: true })
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return await sendHealth(res, { state, startedAt, checkSheets })
      }
      if (req.method === "GET" && url.pathname === "/pair") {
        if (!tokenOk(url.searchParams.get("token"), pairToken)) {
          return text(res, 401, "Unauthorized")
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(pairPageHtml())
        return
      }
      if (req.method === "GET" && url.pathname === "/pair/state") {
        if (!tokenOk(url.searchParams.get("token"), pairToken)) {
          return json(res, 401, { error: "unauthorized" })
        }
        let qrImage = null
        if (state.qr) {
          qrImage = await QRCode.toDataURL(state.qr, { margin: 1, width: 280 })
        }
        return json(res, 200, {
          status: state.whatsapp,
          qr: state.qr,
          qrImage,
          pairingCode: state.pairingCode,
          connectedAt: state.connectedAt ? state.connectedAt.toISOString() : null,
        })
      }
      text(res, 404, "Not found")
    } catch (err) {
      json(res, 500, { ok: false, error: err.message })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`HTTP listening on :${port}  /live  /health  /pair`)
      resolve(server)
    })
  })
}

async function sendHealth(res, { state, startedAt, checkSheets }) {
  let sheets = "error"
  try {
    await checkSheets()
    sheets = "ok"
  } catch {
    sheets = "error"
  }
  const ready = state.whatsapp === "open" && sheets === "ok"
  json(res, ready ? 200 : 503, {
    ok: ready,
    whatsapp: state.whatsapp,
    sheets,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
  })
}

function tokenOk(got, expected) {
  const a = Buffer.from(String(got || ""))
  const b = Buffer.from(String(expected || ""))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" })
  res.end(body)
}
