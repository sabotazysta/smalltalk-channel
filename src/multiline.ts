/**
 * IRCv3 `draft/multiline` receive support.
 *
 * WHY: a long paragraph from Hanza Talk arrives as `BATCH +ref draft/multiline <target>` with
 * PRIVMSG lines of <=400 bytes. Without the cap ergo splits the batch into separate PRIVMSGs and
 * the agent got 2+ notifications cut mid-word ("...Plików samej " + "gry nie bierzmy..."). With
 * the cap we get the batch and deliver ONE message: lines joined with "\n", except lines tagged
 * `draft/multiline-concat`, which are appended with no separator.
 *
 * How irc-framework (4.x) surfaces batches — what this relies on:
 *  - It buffers every `@batch=<id>` line until `BATCH -<id>`, then synchronously emits
 *    `batch start <type>`, replays each buffered command (the `privmsg` event gets
 *    `batch: {id, type, params}`) and emits `batch end <type>`. It does NOT aggregate multiline.
 *  - It does NOT support nested batches: lines tagged with an inner batch id (ergo nests
 *    `draft/multiline` inside `chathistory` replays) are silently DROPPED, because the inner
 *    BATCH start is itself still buffered in the outer batch. We fix that in a raw middleware by
 *    re-tagging inner lines to the outer batch and keeping the inner id in NESTED_MULTILINE_TAG.
 *  - The BATCH line's own tags (time, msgid, account, client-only tags) are not exposed on any
 *    event; the middleware copies missing ones onto the batch's PRIVMSG lines.
 *  - A lost `BATCH -<id>` would leave the lines in irc-framework's cache forever. A timer per
 *    top-level multiline batch dispatches a synthetic `BATCH -<id>` so whatever arrived is
 *    delivered; the same happens on socket close. Such a forced flush ends with TRUNCATED_MARKER so
 *    the agent doesn't take half a paragraph for the whole message.
 */

export const MULTILINE_BATCH = 'draft/multiline'
export const MULTILINE_CONCAT_TAG = 'draft/multiline-concat'
/** Local (never on the wire) tag: id of the multiline batch a chathistory line belonged to. */
export const NESTED_MULTILINE_TAG = 'smalltalk/multiline-batch'
/** Per-batch cap on the joined text. ergo's max-bytes is 4096; 64 KB is generous. */
export const MULTILINE_MAX_BYTES = 64 * 1024
export const MULTILINE_TIMEOUT_MS = 10_000
/** Appended to a batch delivered without its real `BATCH -` (timeout / socket close). */
export const TRUNCATED_MARKER = '\n[ucięte: reszta wiadomości nie dotarła]'

export type MsgEvent = {
  target: string
  nick: string
  message: string
  time: Date | string | null
  tags?: Record<string, string>
  batch?: { id: string; type: string; params: string[] }
}

/** Append one PRIVMSG of a multiline batch to the text collected so far. */
export function appendMultilinePiece(acc: string, piece: string, tags?: Record<string, string>): string {
  return tags?.[MULTILINE_CONCAT_TAG] !== undefined ? acc + piece : acc + '\n' + piece
}

// BATCH-line tags worth carrying onto the lines (everything except the batch reference itself).
function batchTagsToCopy(tags: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(tags ?? {})) if (k !== 'batch') out[k] = v
  return out
}

function fillMissing(tags: Record<string, string>, from: Record<string, string> | undefined) {
  if (!from) return
  for (const [k, v] of Object.entries(from)) if (tags[k] === undefined) tags[k] = v
}

// Minimal shape of the irc-framework client we touch (keeps tests free of sockets).
type Client = {
  use(fn: (client: any, raw: { use(mw: Function): void }, parsed: unknown) => void): void
  on(event: string, cb: (...args: any[]) => void): void
  command_handler: { hasCache(key: string): boolean; dispatch(message: unknown): void }
}

export function attachMultiline(
  client: Client,
  deliver: (e: MsgEvent) => void,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
) {
  const timeoutMs = opts.timeoutMs ?? MULTILINE_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? MULTILINE_MAX_BYTES

  const timers = new Map<string, ReturnType<typeof setTimeout>>()   // top-level batch id -> timer
  const batchTags = new Map<string, Record<string, string>>()        // any multiline batch id -> tags
  const nested = new Map<string, string>()                           // inner id -> outer id
  const open = new Map<string, { first: MsgEvent; text: string; bytes: number }>()
  let forcing: string | null = null   // id whose synthetic BATCH - is being dispatched right now

  const forceEnd = (id: string, why: string) => {
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.delete(id)
    if (!client.command_handler.hasCache('batch.' + id)) return
    process.stderr.write(`smalltalk: multiline batch ${id} not closed (${why}) — delivering what arrived\n`)
    forcing = id
    try {
      client.command_handler.dispatch({ command: 'BATCH', params: ['-' + id], tags: {} })
    } finally {
      forcing = null
    }
  }

  client.use((_c, raw) => {
    raw.use((command: string, message: any, _line: string, _cl: unknown, next: () => void) => {
      const tags: Record<string, string> = message.tags ?? (message.tags = {})
      const p0: string = message.params?.[0] ?? ''
      if (command === 'BATCH' && p0.startsWith('+') && message.params[1] === MULTILINE_BATCH) {
        const id = p0.slice(1)
        batchTags.set(id, batchTagsToCopy(tags))
        if (tags.batch) {
          nested.set(id, tags.batch)
        } else {
          timers.set(id, setTimeout(() => forceEnd(id, `${timeoutMs}ms timeout`), timeoutMs))
        }
      } else if (command === 'BATCH' && p0.startsWith('-')) {
        const id = p0.slice(1)
        const t = timers.get(id)
        if (t) clearTimeout(t)
        timers.delete(id)
        nested.delete(id)
        batchTags.delete(id)
      } else if (tags.batch && batchTags.has(tags.batch)) {
        const id = tags.batch
        fillMissing(tags, batchTags.get(id))
        const outer = nested.get(id)
        if (outer) {
          tags.batch = outer
          tags[NESTED_MULTILINE_TAG] = id
        }
      }
      next()
    })
  })

  const flush = (id: string, truncated = false) => {
    const b = open.get(id)
    if (!b) return
    open.delete(id)
    deliver({ ...b.first, message: truncated ? b.text + TRUNCATED_MARKER : b.text })
  }

  client.on('batch end ' + MULTILINE_BATCH, (ev: { id: string }) => flush(ev.id, ev.id === forcing))

  return {
    /** Returns true if the event belongs to a multiline batch and was consumed. */
    offer(e: MsgEvent): boolean {
      if (e.batch?.type !== MULTILINE_BATCH) return false
      const id = e.batch.id
      const b = open.get(id)
      if (b) {
        const next = appendMultilinePiece(b.text, e.message, e.tags)
        const bytes = Buffer.byteLength(next, 'utf8')
        if (bytes <= maxBytes) {
          b.text = next
          b.bytes = bytes
          return true
        }
        process.stderr.write(`smalltalk: multiline batch ${id} over ${maxBytes} bytes — splitting\n`)
        flush(id)
      }
      open.set(id, { first: e, text: e.message, bytes: Buffer.byteLength(e.message, 'utf8') })
      return true
    },
    /** Socket gone: deliver anything still buffered, then drop all state. */
    reset() {
      for (const id of [...timers.keys()]) forceEnd(id, 'socket closed')
      for (const id of [...open.keys()]) flush(id, true)
      nested.clear()
      batchTags.clear()
    },
  }
}
