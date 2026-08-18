# Retrieve your Infura IPFS data before August 15

Infura is shutting down its IPFS service. On **August 15, 2026** the IPFS API
(`ipfs.infura.io:5001`) and all `*.infura-ipfs.io` dedicated gateways go
offline, and content that has not been moved will no longer be available
through Infura. Uploads and new pinning already stopped on August 3. Only the
IPFS product is affected: Infura accounts and their other APIs continue to
work.

This guide gets your data out in two independent steps:

1. **Now, before August 15**: download every pinned CID to files on a machine
   you control, with CIDs preserved. This step has a hard deadline.
2. **Whenever you are ready**: store that data on Filecoin, where it stays
   retrievable over IPFS under the same CIDs. No deadline, since the data is
   already safe on your disk.

## Fastest path: hand this to your agent

Set your credentials as environment variables (never paste secrets into a
chat window), then give your AI agent this prompt:

> My Infura IPFS account shuts down August 15. Retrieve my data: fetch
> https://raw.githubusercontent.com/FilOzone/infura-ipfs-retrieval/main/README.md
> and follow it exactly. My credentials are already set as
> INFURA_PROJECT_ID and INFURA_PROJECT_SECRET environment variables. Run
> the retrieval now, re-run until it reports clean, and do not start the
> Filecoin storage step without asking me first.

The steps below are complete and require no context beyond your
credentials, so the agent needs nothing else. Prefer doing it yourself?
Keep reading.

## What you need

- Your Infura **project ID** and **project secret** (from the Infura/MetaMask
  Developer dashboard). Only IPFS keys active since late 2024 still work.
- **Node.js 18+** and enough free disk for your data. Nothing else (no IPFS
  node to run).

## Step 1: download everything now

See what your account holds first (writes `roots.txt`, downloads nothing):

```bash
npx infura-ipfs-retrieval@0.2.0 --project-id <ID> --project-secret <SECRET> --list-only
```

Then run the full retrieval:

```bash
npx infura-ipfs-retrieval@0.2.0 --project-id <ID> --project-secret <SECRET>
```

The script lists every pin in your account, walks each one block by block in
depth-first order, cryptographically verifies every block against its CID
(sha2, sha3, and blake2 families), and writes one deterministic
[CAR file](https://ipld.io/specs/transport/car/) per pinned item under
`infura-rescue-out/cars/`. A CAR is the standard IPFS archive format: your
content plus its exact structure, which is what keeps **your CIDs unchanged**.
This is not a download-and-re-add, which would produce new CIDs. Running
the retrieval twice produces byte-identical archives, so you can safely compare
or deduplicate backups.

- **Interrupted?** Re-run the same command; completed items are skipped.
  An item that could not finish keeps its `.car.partial` file as a safety
  net, but retrying re-downloads that item from the start, so budget time
  accordingly for very large items.
- **Rate limited?** Lower the parallelism: `--workers 4`.
- **Failures?** `failed-blocks.txt` and `incomplete-roots.txt` list anything
  unreachable; re-run to retry. A block Infura no longer serves cannot be
  recovered after August 15, so re-run until clean, today.
- **Millions of pins?** Accounts at that scale can exceed what the pin
  listing handles in one response. If `--list-only` fails or hangs, [contact
  us](https://filecoin.cloud/contact) instead of retrying.. that size deserves a scoped conversation anyway.
- **Unusual content?** Content hashed or encoded in formats the script cannot
  check locally is still downloaded and saved, and listed in
  `unverified-blocks.txt` (with `needs-review.txt` naming the affected
  items). Importing into an IPFS node later (`ipfs dag import`) re-verifies
  everything with its full codec and hasher support.
- **For scripts and agents**: credentials can also be passed as
  `INFURA_PROJECT_ID` / `INFURA_PROJECT_SECRET` environment variables, and
  `--out <dir>` changes the output directory. Exit codes: `0` everything
  saved and verified, `2` some items incomplete (re-run), `3` everything
  saved but some items need review (see above).

When it finishes with "Every pinned DAG is fully saved", your data is safe:
`roots.txt` is the inventory, `cars/` holds the content. Back the folder up
like anything else you care about. To browse a CAR or serve it over IPFS,
import it into any IPFS node: `ipfs dag import <file>.car`.

## Step 2: store it on Filecoin

Your data is safe on disk, but a laptop is not a storage service. Filecoin
keeps every CID retrievable over public IPFS gateways (existing links keep
working) while storage providers in the Filecoin network hold your data and
prove it onchain periodically.

To keep your CIDs, store the retrieved data as-is rather than re-adding the
plain files. Infura added your data with an older chunking configuration,
so re-adding the same files today (`ipfs add`, or a pinning service's
upload button) would produce different CIDs, and existing links would stop
resolving. `ipfs2foc` (below) carries your retrieved blocks over unchanged.

### First, a funded wallet

Storage is paid onchain, so step 2 needs an Ethereum-style (`0x`) wallet on
Filecoin mainnet holding two tokens: a little **FIL** for transaction fees
(0.05-0.1 FIL covers many transactions) and **USDFC** (the USD stablecoin
storage is priced in) for the storage itself.

1. **Get FIL**: withdraw from an exchange straight to your `0x` address, or
   bridge from Ethereum, Base, Arbitrum, and most other chains with
   [Squid Router](https://app.squidrouter.com).
2. **Get USDFC**: swap some of that FIL on
   [SushiSwap on Filecoin](https://www.sushi.com/filecoin/swap?token0=NATIVE&token1=0x80b98d3aa09ffff255c3ba4a241111ff1262f045),
   or mint it against FIL collateral at
   [usdfc.secured.finance](https://usdfc.secured.finance).
3. **Set up payments** (one-time deposit and approvals):

   ```bash
   export PRIVATE_KEY=0x...   # the wallet's key; keep it out of version control
   npx filecoin-pin@latest payments setup --auto
   npx filecoin-pin@latest payments status   # confirm balance and approvals
   ```

### Then migrate with ipfs2foc

Use [`ipfs2foc`](https://github.com/FilOzone/ipfs2foc) to migrate your
retrieval output. Give it your `roots.txt` as its CID list (`--cids roots.txt`):
it packs small items into ~1 GiB units to keep the onboarding costs low,
streams everything to two storage providers, and produces a verifiable
receipt. Your CIDs stay exactly as retrieved. It can be driven by an agent.
See its
[user guide](https://github.com/FilOzone/ipfs2foc/blob/main/docs/user-guide.md)
to get started.

`ipfs2foc` reads each CID from an IPFS gateway rather than from your CAR
files. If your content stops being served anywhere after the shutdown,
import the retrieved CARs into a local IPFS node (`ipfs dag import`) and point
`ipfs2foc` at that node's gateway with `--gateway`, checking it first with
`ipfs2foc probe`.

Storage costs about $5 per TB per month (two replicas) plus a one-time
onboarding cost. Data sets over 500 GiB, or anything you would rather scope
with a human, are welcome through the
[contact form](https://filecoin.cloud/contact).

## If you only want your files (CIDs not preserved)

For a small account where you just want the bytes and do not care that
re-uploading later produces different CIDs, the stock
[`ipfs` CLI](https://docs.ipfs.tech/install/command-line/) can pull files
directly:

```bash
# list your pins
curl -s -X POST -u "<ID>:<SECRET>" \
  "https://ipfs.infura.io:5001/api/v0/pin/ls?type=recursive" | jq -r '.Keys | keys[]'

# download one as regular files
ipfs --api /dns/ipfs.infura.io/tcp/5001/https --api-auth basic:<ID>:<SECRET> get <cid>
```

The script above is the better default: it keeps CIDs intact, which is what
lets step 2 preserve every existing link to your content.

## Caveats

[`filecoin-pin`](https://github.com/filecoin-project/filecoin-pin) is the
recommended IPFS+Filecoin CLI for now (step 2 already uses it for payment
setup). If you upload with it, use only `filecoin-pin import` whenever
same-CID resolution is important (as it is for this retrieval): its `add`
command re-chunks files and produces new CIDs. This guide recommends
`ipfs2foc` because it has been specifically optimized to reduce the
onboarding cost of large data sets while keeping same-CID resolution; that
capability will eventually land in `filecoin-pin` itself.

## Install analytics

This package uses [Scarf](https://scarf.sh) to collect basic install
statistics (OS, versions) that help us understand usage. No IPFS data or
credentials are ever collected. To opt out, set `SCARF_ANALYTICS=false` in
your environment before installing.

## Questions

If a run fails in a way re-running does not fix, or your data set is too large
to finish in time, [contact us](https://filecoin.cloud/contact) and bring your
`roots.txt` and the error output.
