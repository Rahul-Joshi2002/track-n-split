import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys"
import qrcodeTerminal from "qrcode-terminal"
import { normalizeJid } from "../ledger/sheets.js"

const MAX_BACKOFF_MS = 60_000

export function createPairState() {
  return {
    whatsapp: "disconnected",
    qr: null,
    pairingCode: null,
    connectedAt: null,
  }
}

export function startWhatsApp({ config, state, ledger, handleCommand }) {
  let sock = null
  let auth = createInMemoryAuth()
  let backoffMs = 1000
  let pairingRequested = false
  let shuttingDown = false
  let reconnectTimer = null

  async function connect() {
    if (shuttingDown) return
    state.whatsapp = "connecting"
    const { version } = await fetchLatestBaileysVersion()
    const logger = quietLogger()
    sock = makeWASocket({
      version,
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
      },
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger,
    })

    if (!config.sendGroupMessages) {
      console.log("DEV: group sends are off. Replies go to this console only.")
      console.log("SHIPPING: set SEND_GROUP_MESSAGES=true in .env before the trip.")
    }

    sock.ev.on("creds.update", auth.saveCreds)

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        state.whatsapp = "qr"
        state.qr = qr
        state.connectedAt = null
        console.log("\n=== WhatsApp session needs pairing ===")
        console.log("Open /pair?token=... or scan the QR below.")
        qrcodeTerminal.generate(qr, { small: true })
        if (config.pairPhone && !pairingRequested) {
          pairingRequested = true
          try {
            const code = await sock.requestPairingCode(config.pairPhone)
            state.pairingCode = code
            console.log(`Pairing code: ${code}`)
          } catch (err) {
            console.error("Could not request pairing code:", err.message)
          }
        }
      }

      if (connection === "open") {
        backoffMs = 1000
        pairingRequested = false
        state.whatsapp = "open"
        state.qr = null
        state.pairingCode = null
        state.connectedAt = new Date()
        console.log("WhatsApp connected.")
        await onOpen(sock)
      }

      if (connection === "close") {
        const status = lastDisconnect?.error?.output?.statusCode
        const loggedOut = status === DisconnectReason.loggedOut
        state.whatsapp = loggedOut ? "logged_out" : "disconnected"
        state.connectedAt = null
        if (shuttingDown) return
        if (loggedOut) {
          console.log("WhatsApp logged out. Resetting in-memory session. Scan /pair again.")
          auth = createInMemoryAuth()
          pairingRequested = false
          state.qr = null
          state.pairingCode = null
          scheduleReconnect(1000)
        } else {
          console.log(`WhatsApp disconnected (${status || "unknown"}). Reconnecting in ${backoffMs}ms`)
          scheduleReconnect(backoffMs)
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
        }
      }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        try {
          await onMessage(sock, msg)
        } catch (err) {
          console.error("Message handler failed:", err.message)
        }
      }
    })
  }

  function scheduleReconnect(delay) {
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      connect().catch((err) => console.error("Reconnect failed:", err.message))
    }, delay)
  }

  async function onOpen(socket) {
    if (!config.groupJid) {
      console.log("GROUP_JID is not set. Logging inbound group JIDs only; commands are ignored.")
      return
    }
    try {
      await sendGroup(socket, config.onlineMessage)
    } catch (err) {
      console.error("Could not send online message:", err.message)
    }
    await dumpParticipants(socket)
  }

  async function dumpParticipants(socket) {
    try {
      const meta = await socket.groupMetadata(config.groupJid)
      const jids = []
      console.log("Group participants:")
      for (const p of meta.participants || []) {
        const jid = jidNormalizedUser(p.id) || p.id
        jids.push(jid)
        console.log(`  ${jid}`)
      }
      const added = await ledger.addMissingMemberJids(jids)
      console.log(
        added
          ? `Members sheet: added ${added} new JID(s). Names fill in when people message.`
          : "Members sheet: all group JIDs already present.",
      )
    } catch (err) {
      console.error("Could not list group participants:", err.message)
    }
  }

  async function onMessage(socket, msg) {
    const remoteJid = msg.key?.remoteJid
    if (!remoteJid) return

    if (!config.groupJid) {
      if (isJidGroup(remoteJid)) {
        console.log(`Inbound group JID: ${remoteJid}`)
      }
      return
    }

    if (normalizeJid(remoteJid) !== normalizeJid(config.groupJid)) return

    const senderJids = [
      msg.key.participant,
      msg.key.participantAlt,
      msg.key.fromMe ? socket.user?.id : null,
    ]
      .map((jid) => jidNormalizedUser(jid) || jid)
      .filter(Boolean)

    let senderJid = senderJids[0] || jidNormalizedUser(socket.user?.id)
    try {
      senderJid =
        (await ledger.rememberMemberFromMessage({
          jids: senderJids,
          displayName: msg.pushName,
        })) || senderJid
    } catch (err) {
      console.error("Could not update Members from message:", err.message)
    }

    const text = extractText(msg)
    if (!text || !text.startsWith("/")) return
    const mentionedJids = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).map(
      (jid) => jidNormalizedUser(jid) || jid,
    )

    const reply = await handleCommand({
      text,
      senderJid,
      mentionedJids,
      messageId: msg.key.id,
    })
    if (reply) {
      await sendGroup(socket, reply)
    }
  }

  async function sendGroup(socket, text) {
    if (!config.sendGroupMessages) {
      console.log("[dev] skipped group send:\n" + text)
      return
    }
    await socket.sendMessage(config.groupJid, { text })
  }

  connect().catch((err) => {
    console.error("WhatsApp connect failed:", err.message)
    scheduleReconnect(backoffMs)
  })

  return {
    async stop() {
      shuttingDown = true
      clearTimeout(reconnectTimer)
      try {
        await sock?.end(undefined)
      } catch {
        // ignore
      }
    },
  }
}

function createInMemoryAuth() {
  const creds = initAuthCreds()
  const store = new Map()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            const value = store.get(`${type}-${id}`)
            if (value) data[id] = value
          }
          return data
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type] || {})) {
              const value = data[type][id]
              const key = `${type}-${id}`
              if (value) store.set(key, value)
              else store.delete(key)
            }
          }
        },
      },
    },
    saveCreds: () => {},
  }
}

function extractText(msg) {
  const content = msg.message || {}
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.ephemeralMessage?.message?.conversation ||
    content.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ""
  ).trim()
}

function quietLogger() {
  const noop = () => {}
  const logger = {
    level: "silent",
    child() {
      return logger
    },
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  }
  return logger
}
