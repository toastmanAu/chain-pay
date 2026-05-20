// CKB light client network configs.
//
// We MUST supply a config. The WASM build's internal defaults only include IP-based
// bootnodes, none of which support WSS — browsers can't reach them. The `*.ckb.guide`
// addresses below are the canonical WSS-capable bootnodes (from ckb-light-client-js
// README and Quantum Purse / Neuron) — the only practical way to bootstrap a
// browser light client.
//
// The `[rpc]` block is required by the Rust serde deserializer in v0.5.5 even
// though the WASM build doesn't actually bind an RPC port — omitting it fails
// with "missing field `rpc`".

export type CkbNetwork = "mainnet" | "testnet";

const RPC_BLOCK = `
[rpc]
listen_address = "127.0.0.1:9000"
`;

export const MAINNET_CONFIG = `
chain = "mainnet"

[store]
path = "data/store"

[network]
path = "data/network"

listen_addresses = ["/ip4/0.0.0.0/tcp/8110"]

bootnodes = [
    "/dns4/reaver.ckb.guide/tcp/443/wss/p2p/QmaZMemLXSsxKUrYNucjEbPxVX3rBKsGhWW2muWtWxUWyh",
    "/dns4/cheese.ckb.guide/tcp/443/wss/p2p/QmV26bmuBXyiBytbYvr2aTnUg27mgtpBmae6EA8U49otbJ",
    "/dns4/maelstrom.ckb.guide/tcp/443/wss/p2p/QmcodzCafKsP9bSa2QPsNoK6UFL3h8ucewvmRV9Re5WfQw",
    "/dns4/satanic.ckb.guide/tcp/443/wss/p2p/QmcEK1wUR287qSYdw8eHNWeQrFitQsCaZHHTM9wgvakxnS",
    "/dns4/sange.ckb.guide/tcp/443/wss/p2p/QmNRAvtC6L85hwp6vWnqaKonJw3dz1q39B4nXVQErzC4Hx",
    "/dns4/cloak.ckb.guide/tcp/443/wss/p2p/QmagxSv7GNwKXQE7mi1iDjFHghjUpbqjBgqSot7PmMJqHA",
    "/dns4/lavabuster.ckb.guide/tcp/443/wss/p2p/QmZgcFN3c7zpyzzxn9KNGsQpEyf4D7eCgrmNCnAeCWicw3",
    "/dns4/claymore.ckb.guide/tcp/443/wss/p2p/QmSRj57aa9sR2AiTvMyrEea8n1sEM1cDTrfb2VHVJxnGuu",
    "/dns4/eaglesong.ckb.guide/tcp/443/wss/p2p/QmbT7QimcrcD5k2znoJiWpxoESxang6z1Gy9wof1rT1LKR",
    "/dns4/phylactery.ckb.guide/tcp/443/wss/p2p/QmP48t4MSACDyJUcoRgDAaW42MMv2MZnrTaUGCpVeGvKms",
    "/dns4/hyperstone.ckb.guide/tcp/443/wss/p2p/QmRHqhSGMGm5FtnkW8D6T83X7YwaiMAZXCXJJaKzQEo3rb",
    "/dns4/kaya.ckb.guide/tcp/443/wss/p2p/QmeSRNTxo9KqCBQSf7yQErn9Jz2gfnP6wHACvg6qyiEM7q",
    "/dns4/buckler.ckb.guide/tcp/443/wss/p2p/QmYCRVonLfP18LSoz2WCHaXDorUYxuUMfhtcXK1TuZ1iwF",
    "/dns4/bracer.ckb.guide/tcp/443/wss/p2p/QmejEJEbDcGGMp4D6WtftMMVLkR1ZuBfMgyLFDMJymkDt6",
    "/dns4/mjollnir.ckb.guide/tcp/443/wss/p2p/QmVi7reKhqVnoBYzW2nJYnrujVeckrZXhwuYbX7P2whPJg",
    "/dns4/crystalys.ckb.guide/tcp/443/wss/p2p/QmXJg4iKbQzMpLhX75RyDn89Mv7N2H8vLePBR7kgZf6hYk",
    "/dns4/radiance.ckb.guide/tcp/443/wss/p2p/QmQoWrmuFauCn3zZ2mYYKAciG9opTbjzC2wVEfWveZNDt8",
    "/dns4/necronomicon.ckb.guide/tcp/443/wss/p2p/QmejugEABNzAofqRhci7HAipLFvoyYKRacd272jNtnQBTE",
    "/dns4/khanda.ckb.guide/tcp/443/wss/p2p/Qmf4t1SzFhRWuGcFcgs7r4pXvkACsz3FcaBMcmMKQMMpn7",
    "/dns4/yasha.ckb.guide/tcp/443/wss/p2p/QmQidJaxciY3NT2PjsaCR4Gz8vB8kFn3Avwz96u6b3jGc1",
    "/dns4/cornucopia.ckb.guide/tcp/443/wss/p2p/QmexvXVDiRt2FBGptgK4gBJusWyyTEEaHeuCAa35EPNkZS",
    "/dns4/harpoon.ckb.guide/tcp/443/wss/p2p/QmVeeCh81GTLGRwB7vRHXeTRdUHRYcfn6qKEfewhtiRJZC",
    "/dns4/nullifier.ckb.guide/tcp/443/wss/p2p/QmW3P1WYtuz9hitqctKnRZua2deHXhNePNjvtc9Qjnwp4q",
    "/dns4/platemail.ckb.guide/tcp/443/wss/p2p/QmNsGNQjYA6iP472bNnNE2GR31kCYBifhY1XcaUxRjZ1py",
    "/dns4/broadsword.ckb.guide/tcp/443/wss/p2p/QmShw2vtVt49wJagc1zGQXGS6LkQTcHxnEV3xs6y8MAmQN",
    "/dns4/desolator.ckb.guide/tcp/443/wss/p2p/QmeCzzVmSAU5LNYAeXhdJj8TCq335aJMqUxcvZXERBWdgS"
]

max_peers = 125
max_outbound_peers = 4
ping_interval_secs = 120
ping_timeout_secs = 1200
connect_outbound_interval_secs = 15
upnp = false
discovery_local_address = false
bootnode_mode = false
${RPC_BLOCK}`;

export const TESTNET_CONFIG = `
chain = "testnet"

[store]
path = "data/store"

[network]
path = "data/network"

listen_addresses = ["/ip4/0.0.0.0/tcp/8110"]

bootnodes = [
    "/dns4/dagon.ckb.guide/tcp/443/wss/p2p/QmX5D6aJiAQ5Fxn4BfVqSn6zrgyuQM1oXVC9yvmzLuHXnx",
    "/dns4/javelin.ckb.guide/tcp/443/wss/p2p/QmPcJY2gZLUm66szYA9QaG1P3rzwseWCMgbj6AyNCyW4G2",
    "/dns4/diadem.ckb.guide/tcp/443/wss/p2p/QmQMjFrNGaphzfHin3mbYybbJcFMDUihKAcknquYvm9J3W",
    "/dns4/bloodstone.ckb.guide/tcp/443/wss/p2p/QmQoTR39rBkpZVgLApDGDoFnJ2YDBS9hYeiib1Z6aoAdEf",
    "/dns4/crown.ckb.guide/tcp/443/wss/p2p/QmTt6HeNakL8Fpmevrhdna7J4NzEMf9pLchf1CXtmtSrwb",
    "/dns4/mekansm.ckb.guide/tcp/443/wss/p2p/QmT6DFfm18wtbJz3y4aPNn3ac86N4d4p4xtfQRRPf73frC",
    "/dns4/circlet.ckb.guide/tcp/443/wss/p2p/Qmd41MaByDprkC5gP1XBKgamZ9DTLNk37zbPgwtiWCzRV6",
    "/dns4/vanguard.ckb.guide/tcp/443/wss/p2p/QmWVuW5KquiWDSqgMJRFW1xRtVqkYJrWz6S9NNk6fFn3wh",
    "/dns4/chainmail.ckb.guide/tcp/443/wss/p2p/QmfUTZxsse7rFJTJfoUv8bbStoDLETxst5nJEpJozNuAnH",
    "/dns4/gleipnir.ckb.guide/tcp/443/wss/p2p/QmSPkAyXqsWpRiS7HpHLTProVdhQWLKFHCXbRjaLpJj7ZL",
    "/dns4/parasma.ckb.guide/tcp/443/wss/p2p/QmSJTsMsMGBjzv1oBNwQU36VhQRxc2WQpFoRu1ZifYKrjZ",
    "/dns4/bottle.ckb.guide/tcp/443/wss/p2p/QmWcEhsMNRcfJit62EbKgzpgtAJZX1G3Ur4shXjcvLsYDb"
]

max_peers = 125
max_outbound_peers = 4
ping_interval_secs = 120
ping_timeout_secs = 1200
connect_outbound_interval_secs = 15
upnp = false
discovery_local_address = false
bootnode_mode = false
${RPC_BLOCK}`;

export function configFor(network: CkbNetwork): string {
  return network === "mainnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
}
