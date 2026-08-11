#!/usr/bin/env node
// infura-rescue — download all pinned IPFS data from an Infura account to
// CAR files on disk, preserving CIDs (block-level copy, no re-chunking).
//
// Usage:
//   npx infura-rescue --project-id <ID> --project-secret <SECRET> [options]
//
// Options:
//   --project-id      Infura project id     (or env INFURA_PROJECT_ID)
//   --project-secret  Infura project secret (or env INFURA_PROJECT_SECRET)
//   --source <url>    source IPFS API       (default https://ipfs.infura.io:5001)
//   --out <dir>       output directory      (default ./infura-rescue-out)
//   --workers <n>     parallel block prefetch (default 8)
//   --list-only       only write roots.txt and pin counts, download nothing
//
// Output:
//   <out>/roots.txt              every pinned root (type + CID)
//   <out>/cars/<cid>.car         one CAR per root: the complete DAG in
//                                deterministic depth-first order, CIDs unchanged
//   <out>/done.txt               completed roots (enables resume: just re-run)
//   <out>/failed-blocks.txt      blocks the source no longer serves
//   <out>/unverified-blocks.txt  blocks saved without a local digest check
//   <out>/needs-review.txt       roots containing formats we cannot traverse
//
// Blocks are verified against their CID digest when a hasher is available
// (sha2, sha3, blake2b); anything else is downloaded and saved anyway, and
// recorded in unverified-blocks.txt — rescue first, verify what we can.
//
// Auth is optional when --source points at a non-Infura node (for testing).

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, rmSync, existsSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import * as dagCbor from '@ipld/dag-cbor'
import * as dagJson from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import { sha3256, sha3512 } from '@multiformats/sha3'
import { blake2b256, blake2b512 } from '@multiformats/blake2/blake2b'

// ---------- args ----------

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : (args[i + 1] ?? '') }
const has = (name) => args.includes(`--${name}`)

const PROJECT_ID = flag('project-id') ?? process.env.INFURA_PROJECT_ID
const PROJECT_SECRET = flag('project-secret') ?? process.env.INFURA_PROJECT_SECRET
const SOURCE = (flag('source') ?? 'https://ipfs.infura.io:5001').replace(/\/$/, '')
const OUT = flag('out') ?? './infura-rescue-out'
const WORKERS = Number(flag('workers') ?? 8)
const LIST_ONLY = has('list-only')

const AUTH = (PROJECT_ID && PROJECT_SECRET)
  ? 'Basic ' + Buffer.from(`${PROJECT_ID}:${PROJECT_SECRET}`).toString('base64')
  : undefined

if (!AUTH && SOURCE.includes('infura.io')) {
  console.error('error: --project-id and --project-secret (or INFURA_PROJECT_ID / INFURA_PROJECT_SECRET) are required for Infura')
  process.exit(1)
}

// ---------- codecs and hashers ----------

const HASHERS = new Map(
  [sha256, sha512, sha3256, sha3512, blake2b256, blake2b512].map(h => [h.code, h])
)
const IDENTITY = 0x00

// codec code -> extract child links from decoded block, or LEAF for no links.
// Codecs absent from this table are unknown: bytes still saved, traversal stops.
const LEAF = () => []
const LINK_EXTRACTORS = new Map([
  [0x55, LEAF], // raw
  [0x72, LEAF], // libp2p-key
  [0x0200, LEAF], // json (plain, no link representation)
  [dagPb.code, (bytes) => dagPb.decode(bytes).Links.map(l => l.Hash)],
  [dagCbor.code, (bytes) => collectCids(dagCbor.decode(bytes))],
  [dagJson.code, (bytes) => collectCids(dagJson.decode(bytes))],
  [0x51, (bytes) => collectCids(dagCbor.decode(bytes))] // cbor: same wire format for links
])

function collectCids (node, out = []) {
  const cid = CID.asCID(node)
  if (cid) { out.push(cid); return out }
  if (ArrayBuffer.isView(node)) return out // embedded bytes: never iterate per-byte
  if (Array.isArray(node)) { for (const v of node) collectCids(v, out); return out }
  if (node && typeof node === 'object') { for (const v of Object.values(node)) collectCids(v, out) }
  return out
}

// 'ok' | 'unverifiable'; throws on an actual digest mismatch.
async function verifyBlock (cid, bytes) {
  const hasher = HASHERS.get(cid.multihash.code)
  if (!hasher) return 'unverifiable'
  const actual = await hasher.digest(bytes)
  if (Buffer.compare(actual.digest, cid.multihash.digest) !== 0) {
    throw new Error('digest mismatch — corrupt response')
  }
  return 'ok'
}

// ---------- HTTP ----------

async function apiPost (base, path, params, { auth, binary, timeoutMs = 180_000, retries = 3 } = {}) {
  const qs = new URLSearchParams(params).toString()
  const url = `${base}/api/v0/${path}${qs ? `?${qs}` : ''}`
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: auth ? { authorization: auth } : {},
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${path}: HTTP ${res.status}`)
        await res.body?.cancel().catch(() => {}) // release the socket before retrying
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1) * (res.status === 429 ? 3 : 1)))
        continue
      }
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`)
      return binary ? new Uint8Array(await res.arrayBuffer()) : await res.text()
    } catch (err) {
      lastErr = err
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw lastErr
}

// ---------- pin enumeration ----------

async function * pinLs (type) {
  let text
  try {
    text = await apiPost(SOURCE, 'pin/ls', { type, stream: 'true' }, { auth: AUTH, timeoutMs: 600_000 })
  } catch (err) {
    console.error(`  pin/ls stream failed (${err.message}), retrying without stream…`)
    text = await apiPost(SOURCE, 'pin/ls', { type }, { auth: AUTH, timeoutMs: 600_000 })
  }
  // Accept both response shapes regardless of what we asked for: modern Kubo
  // streams NDJSON {Cid, Type} lines, but an old server may ignore
  // stream=true and answer with the buffered {Keys: {cid: {Type}}} map —
  // treating that as "no pins" would falsely report an empty account.
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const o = JSON.parse(line)
    if (o.Cid) {
      yield { cid: o.Cid, type: o.Type ?? type }
    } else if (o.Keys) {
      for (const [cidStr, info] of Object.entries(o.Keys)) yield { cid: cidStr, type: info.Type ?? type }
    }
  }
}

// ---------- manifests ----------

const stats = { fetched: 0, bytes: 0, failed: 0, inlined: 0, unverified: 0 }
const failedPath = () => join(OUT, 'failed-blocks.txt')
const unverifiedPath = () => join(OUT, 'unverified-blocks.txt')

function recordUnverified (cidStr, reason) {
  stats.unverified++
  appendFileSync(unverifiedPath(), `${cidStr}\t${reason}\n`)
}

// ---------- block fetching (prefetch pool, DFS-ordered consumption) ----------

// Returns bytes or null on failure. Verifies when a hasher is available.
async function fetchBlock (cid) {
  const cidStr = cid.toString()
  if (cid.multihash.code === IDENTITY) { stats.inlined++; return cid.multihash.digest }
  try {
    const bytes = await apiPost(SOURCE, 'block/get', { arg: cidStr }, { auth: AUTH, binary: true })
    if (await verifyBlock(cid, bytes) === 'unverifiable') {
      recordUnverified(cidStr, `no local hasher for multihash 0x${cid.multihash.code.toString(16)}; stored as received`)
    }
    stats.fetched++
    stats.bytes += bytes.length
    if (stats.fetched % 200 === 0) console.log(`  ${stats.fetched} blocks, ${(stats.bytes / 1e6).toFixed(1)} MB, ${stats.failed} failed`)
    return bytes
  } catch (err) {
    stats.failed++
    appendFileSync(failedPath(), `${cidStr}\t${err.message}\n`)
    console.error(`  FAILED block ${cidStr}: ${err.message}`)
    return null
  }
}

// Depth-first walk from root, writing blocks to the CAR strictly in DFS
// (link) order — deterministic output; stack memory is bounded by depth ×
// fanout, though the dedup `seen` set still grows with total unique blocks —
// while a bounded prefetch pool keeps up to WORKERS fetches in flight for
// upcoming stack entries.
async function walkDagToCar (root, recursive, carPath) {
  const out = createWriteStream(carPath)
  const { writer, out: carStream } = CarWriter.create([root])
  const piping = pipeline(Readable.from(carStream), out)

  const seen = new Set()
  const prefetch = new Map() // cid string -> Promise<bytes|null>
  const stack = [root]
  let complete = true
  let unknownLinks = false

  const pump = () => {
    for (let i = stack.length - 1; i >= 0 && prefetch.size < WORKERS; i--) {
      const cid = stack[i]
      const key = cid.toString()
      if (!seen.has(key) && !prefetch.has(key)) prefetch.set(key, fetchBlock(cid))
    }
  }

  while (stack.length) {
    pump()
    const cid = stack.pop()
    const key = cid.toString()
    if (seen.has(key)) continue
    seen.add(key)

    const bytes = await (prefetch.get(key) ?? fetchBlock(cid))
    prefetch.delete(key)
    if (bytes === null) { complete = false; continue }
    if (cid.multihash.code !== IDENTITY) await writer.put({ cid, bytes })
    if (!recursive) break

    const extract = LINK_EXTRACTORS.get(cid.code)
    if (!extract) { // unknown codec: block saved, traversal cannot continue through it
      unknownLinks = true
      recordUnverified(key, `unknown codec 0x${cid.code.toString(16)}; block saved but links (if any) not traversed`)
      continue
    }
    let links
    try { links = extract(bytes) } catch (err) {
      console.error(`  warn: cannot decode ${key} (${err.message}); children may be missed`)
      complete = false
      continue
    }
    // push in reverse so links pop in their original (left-to-right) order
    for (let i = links.length - 1; i >= 0; i--) {
      const link = CID.asCID(links[i])
      if (link && !seen.has(link.toString())) stack.push(link)
    }
  }

  await writer.close()
  await piping
  return { complete, unknownLinks }
}

// ---------- main ----------

async function main () {
  mkdirSync(join(OUT, 'cars'), { recursive: true })
  // Per-run manifests start fresh; done.txt (resume state) intentionally persists.
  for (const f of [failedPath(), unverifiedPath()]) rmSync(f, { force: true })

  console.log(`source: ${SOURCE} ${AUTH ? '(authenticated)' : '(no auth)'}`)
  const srcVersion = JSON.parse(await apiPost(SOURCE, 'version', {}, { auth: AUTH, timeoutMs: 30_000 }))
  console.log(`source IPFS version: ${srcVersion.Version}`)

  // 1. roots
  console.log('\nEnumerating pinned roots…')
  const roots = []
  for (const type of ['recursive', 'direct']) {
    for await (const pin of pinLs(type)) roots.push(pin)
  }
  writeFileSync(join(OUT, 'roots.txt'), roots.map(p => `${p.type}\t${p.cid}`).join('\n') + '\n')
  console.log(`${roots.length} pinned roots -> ${join(OUT, 'roots.txt')}`)
  if (roots.length === 0) {
    console.error('WARNING: zero pins found. If you expect this account to hold data, do NOT trust this result — verify with:')
    console.error(`  curl -s -X POST -u "<ID>:<SECRET>" "${SOURCE}/api/v0/pin/ls?type=recursive"`)
  }
  if (LIST_ONLY) return

  // 2. one CAR per root; done.txt enables resume
  const donePath = join(OUT, 'done.txt')
  const done = new Set(existsSync(donePath) ? readFileSync(donePath, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [])
  const incomplete = []
  const needsReview = []

  for (const [i, root] of roots.entries()) {
    const label = `[${i + 1}/${roots.length}] ${root.cid}`
    if (done.has(root.cid)) { console.log(`${label} already done`); continue }
    const carPath = join(OUT, 'cars', `${root.cid.replace(/[^A-Za-z0-9]/g, '_')}.car`)
    const partPath = `${carPath}.part`
    console.log(`${label} downloading…`)
    const { complete, unknownLinks } = await walkDagToCar(CID.parse(root.cid), root.type === 'recursive', partPath)
    if (complete) {
      renameSync(partPath, carPath)
      appendFileSync(donePath, `${root.cid}\n`)
      if (unknownLinks) {
        needsReview.push(root.cid)
        console.log(`${label} saved, but contains blocks in formats this tool cannot traverse — coverage unprovable, see unverified-blocks.txt`)
      } else {
        console.log(`${label} complete -> ${carPath}`)
      }
    } else {
      // Keep whatever we managed to fetch: partial bytes beat no bytes.
      // (rmSync first: Windows renameSync cannot replace an existing file)
      rmSync(`${carPath}.partial`, { force: true })
      renameSync(partPath, `${carPath}.partial`)
      incomplete.push(root.cid)
      console.error(`${label} INCOMPLETE — partial CAR kept at ${carPath}.partial; re-run to retry`)
    }
  }

  // 3. summary
  console.log('\n===== summary =====')
  console.log(`roots:          ${roots.length} (${roots.length - incomplete.length} complete as CAR files in ${join(OUT, 'cars')})`)
  console.log(`blocks fetched: ${stats.fetched} (${(stats.bytes / 1e6).toFixed(1)} MB this run)`)
  console.log(`inline blocks:  ${stats.inlined}`)
  console.log(`unverified:     ${stats.unverified}${stats.unverified ? ` — saved but not fully checkable, see ${unverifiedPath()}` : ''}`)
  console.log(`blocks failed:  ${stats.failed}${stats.failed ? ` — see ${failedPath()}` : ''}`)
  if (needsReview.length) {
    writeFileSync(join(OUT, 'needs-review.txt'), needsReview.join('\n') + '\n')
    console.log(`needs review:   ${needsReview.length} roots contain untraversable formats — see ${join(OUT, 'needs-review.txt')}`)
  }
  if (incomplete.length) {
    writeFileSync(join(OUT, 'incomplete-roots.txt'), incomplete.join('\n') + '\n')
    console.log(`INCOMPLETE roots: ${incomplete.length} — see ${join(OUT, 'incomplete-roots.txt')}; re-run to retry`)
    process.exitCode = 2
  } else if (needsReview.length) {
    console.log('All reachable blocks are saved, but the roots listed in needs-review.txt contain formats this tool cannot traverse — their coverage could not be proven. Import them into an IPFS node to verify.')
    process.exitCode = 3
  } else {
    console.log('Every pinned DAG is fully saved. Your CIDs are unchanged.')
  }
}

main().catch(err => { console.error(`fatal: ${err.message}`); process.exit(1) })
