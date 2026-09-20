import "dotenv/config"
import { loadConfig } from "./config.js"
import { Ledger } from "./ledger/sheets.js"
import { createHandler } from "./commands/handle.js"
import { startHttpServer } from "./http/server.js"
import { createPairState, startWhatsApp } from "./whatsapp/client.js"

const config = loadConfig()
const state = createPairState()
const ledger = new Ledger({
  sheetId: config.sheetId,
  serviceAccount: config.serviceAccount,
})

ledger
  .ensureReady()
  .then(() => console.log("Google Sheets ledger is reachable."))
  .catch((err) => console.error("Google Sheets not ready yet:", err.message))

const handleCommand = createHandler({
  ledger,
  state,
  startedAt: config.startedAt,
})

const httpServer = await startHttpServer({
  port: config.port,
  pairToken: config.pairToken,
  state,
  startedAt: config.startedAt,
  checkSheets: () => ledger.ping(),
})

const whatsapp = startWhatsApp({
  config,
  state,
  ledger,
  handleCommand,
})

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`)
  await whatsapp.stop()
  await new Promise((resolve) => httpServer.close(resolve))
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
