// ---------------------------------------------------------------------------
// CANDIDATES. Not members.
//
// Nothing in this file grants anything. Every address here is verified against
// the pinned root on every pass, and a row only exists in the registry because
// the root answered about that exact address. If this list were wrong, the
// predicate would refute it and the registry would say so.
//
// WHERE IT CAME FROM
//
// The factory's own `DShareAdded(dShare, wrappedDShare, symbol, name)` events,
// decoded over blocks 15,468,029–18,668,348 — the first ~74 days of the
// production factory's life. Fifty pairs. Blocks 18,668,348–49,107,399 (~23
// months) were not scanned, because base.org caps `eth_getLogs` at 10,000
// blocks per call, so this is a LOWER BOUND and never a total. A later pass
// that walks the gap will find more; it will verify them the same way.
//
// The 4 August 2026 "724 tokenized stocks" launch did NOT arrive through this
// factory: the last ~32 days before the audit contain zero `DShareAdded`
// events.
//
// WHY THE WRAPPERS ARE HERE
//
// To be refuted. Measured, `isTokenDShare` answers FALSE for every wrapped
// dShare, and `isTokenWrappedDShare` reverts on this deployment — so a wrapper
// is outside the root's reach entirely. Storing the refutation is what stops a
// later pass from adopting a wrapper on the grounds that nothing ruled it out.
// ---------------------------------------------------------------------------

export interface DinariCandidatePairV1 {
  dShare: string;
  wrappedDShare: string;
}

/** Decoded from the root's own event log. Verified, never trusted. */
export const DINARI_BASE_CANDIDATES_V1: readonly DinariCandidatePairV1[] = [
  // Apple Inc. - Dinari
  { dShare: '0x41f7a63713e76c0ab800be03bae9f17b8a356348', wrappedDShare: '0x052175b0015ccca91919f374043a665441e4b0b8' },
  // Amazon.com, Inc. - Dinari
  { dShare: '0xf393d07e6ca9818a601055b4bb3c48a5bb98e701', wrappedDShare: '0x45009fa3bd96cb5f57257efcd9220592149bcf1e' },
  // Walt Disney Company - Dinari
  { dShare: '0x942e2d29f05309938ea806defa1758a019dddb70', wrappedDShare: '0x3d77bdef3aa8202b2bb624b691d250bc7353b01f' },
  // Alphabet Inc. Class A - Dinari
  { dShare: '0x1a4dfa04a5c8f85ecad6ffd3c211051f8a43e280', wrappedDShare: '0xe73167621cd4143ed1fbcdfb3f75d4eb89e1b483' },
  // Meta Platforms, Inc. - Dinari
  { dShare: '0xf6e697f80a2c0c77e9c896a23542efab2f0d16df', wrappedDShare: '0x115c17e4ccdde5973156e09b0544cf0d0a0d946a' },
  // Microsoft Corporation - Dinari
  { dShare: '0xf9011e88d8f1b5bb9b1f0b3bd604d250cf114afb', wrappedDShare: '0x72b9ab48e7717eaf6c13409446da5a091c7325f7' },
  // Netflix, Inc. - Dinari
  { dShare: '0x35c6fc86f413a48157e7d1785bf209b07f4e5110', wrappedDShare: '0x0290bcdcaa06ac1eebae7a8cbf127ae47caddf53' },
  // NVIDIA Corporation - Dinari
  { dShare: '0x92ecf64fdb76e60b76d78a29ad4bf9d38b7b1b97', wrappedDShare: '0xf37e92704df29338dd09759f322fd09868dd25cc' },
  // Pfizer, Inc. - Dinari
  { dShare: '0xdddfb67063b57a834257e0db3b9aab39329fd4bd', wrappedDShare: '0x645f289c487491f848763ede71a3983b7c278727' },
  // PayPal Holdings, Inc. - Dinari
  { dShare: '0xd6558a27008788041fd9b9e013e649bcab329218', wrappedDShare: '0xf855f0782d0e41665d6b9ac3ef0259bdbd961c17' },
  // Tesla, Inc. - Dinari
  { dShare: '0x74ed07d83999bc5db0ffd850da0a6bd782abd39c', wrappedDShare: '0xea338c2a81ddf7a051244c16d5f1819683204307' },
  // SPDR S&P 500 ETF Trust - Dinari
  { dShare: '0x8a768ef1d44939e2c6e36b83a948295962d6f795', wrappedDShare: '0x2483bf0e5b4f6fcd6a4d4ae5ca3a21593d1595fc' },
  // WisdomTree Floating Rate Treasury Fund - Dinari
  { dShare: '0x9f6e2ea64d90f586779ef859ffce18c8fa2fa4f4', wrappedDShare: '0x5cc120a5e92324e5327d6ee2d362382ad5ffa761' },
  // Coinbase Global, Inc. Class A Common Stock - Dinari
  { dShare: '0xa559c1a28874bea40056e61cfee29b051b7d8c9d', wrappedDShare: '0x54cdaeaf198f567295e5f24d9dcdf79596491f5f' },
  // Arm Holdings plc American Depositary Shares - Dinari
  { dShare: '0x89cb2f89117f109a41dda05bfaea2a02f65e542b', wrappedDShare: '0x2919616bd31c7b47551c380cb3c0a848b0a4b6d8' },
  // Advanced Micro Devices - Dinari
  { dShare: '0xaaf450456949eb5fc77987f619653e77383a8170', wrappedDShare: '0x9cf6a6204d395e3e5289b7ed7e21be0cf91a90a6' },
  // PROLOGIS, INC. - Dinari
  { dShare: '0xbb7f33d8d0914fa9775ef778fc3193634290b9ca', wrappedDShare: '0xc77f16b5e5a99ebcb6fcb8003fc150b99e525800' },
  // McDonald's Corporation - Dinari
  { dShare: '0x0150958b2b183a8e63264b8a6d82b4f747df3f62', wrappedDShare: '0xee692fab43f22bfe38b92818bdffc6232cb29aed' },
  // Yum! Brands, Inc. - Dinari
  { dShare: '0x48a0ea70c2c7d025cc95672b9ebe6ad026129b44', wrappedDShare: '0x5fe63b572561ee68ef1dbba5a3b74c0f864c2ce0' },
  // Block, Inc. - Dinari
  { dShare: '0xd5eab2d9e01442bfca720f6f15451555dd003f40', wrappedDShare: '0x9032e4deb459fe147b6de4afdba5675d509a8b1c' },
  // Riot Platforms, Inc. Common Stock - Dinari
  { dShare: '0xbd042b930d40326f18fc19693adabc9457d4af7f', wrappedDShare: '0xfeba2247d9000afd364f268d7010c374d4f711a9' },
  // Annaly Capital Management. Inc. - Dinari
  { dShare: '0xb3358ab71f784910de0ca766ebdab527323731b9', wrappedDShare: '0x853ac7c4e2e2cd7a61d2d76ec5a29c8e1144b4b0' },
  // Grayscale Bitcoin Trust (BTC) - Dinari
  { dShare: '0xd0ca17153cbe8dd5f7b96f9a2c9e608faad7e904', wrappedDShare: '0x819b934761e0b0ca940a5d7fa71fbfaa54f9d753' },
  // Fidelity Wise Origin Bitcoin Fund - Dinari
  { dShare: '0xca31298489e32041016ed95de4beea889335c5a5', wrappedDShare: '0x4e6d09106663bcf9c8a91d9a2e184cc28f918749' },
  // Bitwise Bitcoin ETF - Dinari
  { dShare: '0x5ea14145f62dbf26fc7b0eb8fa8c71e1af468207', wrappedDShare: '0xb569f108dc1a709758eb0859b49abdf1a6f8f1a7' },
  // iShares Bitcoin Trust iShares Bitcoin Trust - Dinari
  { dShare: '0x24fdd77381d3dd36a9bd7029bcdac350a0342de3', wrappedDShare: '0x31c233a4c502b3e814c1789cfcb9f12a114f4438' },
  // VanEck Bitcoin Trust - Dinari
  { dShare: '0x842d4a6d10e41eaae03b4df87e575be53b296fc6', wrappedDShare: '0x77625c5e255eee549cdd968b5f48266ec9177181' },
  // Franklin Bitcoin ETF - Dinari
  { dShare: '0xd45a01a729a0d4ccbe1523e58eb4ff8bdc3607d7', wrappedDShare: '0xb2ddac820a73546e4eaeff377a04e2f9b0ad6a2c' },
  // ARK 21Shares Bitcoin ETF - Dinari
  { dShare: '0x4b959bb4c00d25e52a87cb1865401dd97cb5631d', wrappedDShare: '0x0680774bae6c446b1793c9bc0a92c8767ca7c5d5' },
  // Invesco Galaxy Bitcoin ETF - Dinari
  { dShare: '0x69bd04ab9290d2919f228b87f9dccf728e2675cd', wrappedDShare: '0x9ae9646821d60a3f0b7fcf6eb52e5a1cdcce8e3d' },
  // WisdomTree Bitcoin Fund - Dinari
  { dShare: '0xe1338b131647a4d6123b6af912f295954067a766', wrappedDShare: '0x75dc4d722b188e9c8b091901f417ee6c0264c153' },
  // Valkyrie Bitcoin Fund - Dinari
  { dShare: '0xc3c1bb150e48ca764fa9428339b63b21376fcafa', wrappedDShare: '0x89fe78c00bd92020194266cb280c26008d0f500b' },
  // Hashdex Bitcoin Futures ETF - Dinari
  { dShare: '0xac21cd6fe43240d90741d25858d0ff0940b11cc7', wrappedDShare: '0x2cbfd47f2a3783fd8dfc1fd04a439381a0e5b056' },
  // VanEck Steel ETF - Dinari
  { dShare: '0x0d794e3778fc6f5f0351c77a5c77bd21d26887f9', wrappedDShare: '0x901ef5a11a92da77a3e998fcdab384c9e13a3e24' },
  // Teucrium Wheat Fund - Dinari
  { dShare: '0xc6bbaf4d804327d84931310e49c863e63a2bd868', wrappedDShare: '0x05d0e599b1a1e105749cf6fccedfa95a5fc3e0c1' },
  // iShares Global Timber & Forestry ETF - Dinari
  { dShare: '0xb8ebc0fc2453a1be3ab48db2de6237ce56e00c48', wrappedDShare: '0x28209e462f04bccdf5c85c2aee1027df834c0ae8' },
  // Invesco Water Resources ETF - Dinari
  { dShare: '0xcc69d36075d563d010d829db7a9caa50b3487bb0', wrappedDShare: '0x53ea1f99ebc5ffb631f64c7a2b09291e4df2e7a1' },
  // Reddit, Inc. - Dinari
  { dShare: '0xa17c0e96c8b5e39b6fd670f01d7f021f66b930cd', wrappedDShare: '0x76a10eb7ffe52d38da56fdeb26e8bc3c69b68cb3' },
  // GameStop Corp. Class A - Dinari
  { dShare: '0x2bb9282552228734cca01a1671605122258e276a', wrappedDShare: '0xd6edbe6c6d0e4a9c1e3c6e32b9a1e4a75b8e1d58' },
  // AMC ENTERTAINMENT HOLDINGS, INC. - Dinari
  { dShare: '0xfdaf8d69fa9931f00b92e14bc4233cb438b24980', wrappedDShare: '0xf50093bb1c1a3abe2391330c20676dd55724b537' },
  // Cisco Systems, Inc. Common Stock (DE) - Dinari
  { dShare: '0x341c9b4e5566a2ae22a337c84e3c006064731925', wrappedDShare: '0xa09cb194e4296fdb733f80c475c5c4511aef0934' },
  // Broadcom Inc. Common Stock - Dinari
  { dShare: '0x0f6c508ef7257c4b99bd1bc8aef750da64840813', wrappedDShare: '0xf553be36a1dbcdd0b40e3f3627ab09111f4fcc2b' },
  // Exxon Mobil Corporation - Dinari
  { dShare: '0x78bb8ff6baa486c31ce0ef1a157798f7a606565c', wrappedDShare: '0x4d8003de75d0f0eff7cf3f831678ed37ddffb10e' },
  // Johnson & Johnson - Dinari
  { dShare: '0xab754c3998ba88e789329f250d90ea35fc87aea6', wrappedDShare: '0xd0502953c8745e2c81f2081303ab6d478892ea69' },
  // AstraZeneca PLC - Dinari
  { dShare: '0xa9c380050b07f8c2bb38dc57bcdbe267cc794fe8', wrappedDShare: '0x168709d05a94a89dd982164c6f2c109b2a564019' },
  // TJX Companies, Inc. (The) - Dinari
  { dShare: '0xf61558b2bc330c55ae85679be03a76dc0a8c9ed2', wrappedDShare: '0x741eba0753a78b8801eea6660d58a912ff78ebe8' },
  // Procter & Gamble Company - Dinari
  { dShare: '0x437b5acc7d6f0eacb97431e649c61e98badb3f92', wrappedDShare: '0x23f30c619b6398fad8ec656a132fa7b0bbc651ba' },
  // Uber Technologies, Inc. - Dinari
  { dShare: '0x068b598c2e4711b1b993415358038d71ea715f2d', wrappedDShare: '0x8ed5bbb4f9b7a9a75e403ed0b17b6ac0b9033a1d' },
  // Adobe Inc. - Dinari
  { dShare: '0xf20c96fffbda91b07f78592c1c887ba922ce9b7f', wrappedDShare: '0x4971a2ea9ff21322983c9a683fcb0773306e9270' },
  // Chevron Corporation - Dinari
  { dShare: '0x25aa7b1ecf5d3fcd1b3b9f2445a4fa5597ffb189', wrappedDShare: '0x7b06f5c721d1f32540a220a0740bdbd2e7f32f00' },
];

/** Every address to ask the root about: the dShares and their wrappers. */
export function dinariCandidateAddressesV1(): string[] {
  const found: string[] = [];
  for (const pair of DINARI_BASE_CANDIDATES_V1) {
    found.push(pair.dShare, pair.wrappedDShare);
  }
  return [...new Set(found.map((address) => address.toLowerCase()))].sort();
}
