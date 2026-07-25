"use client";

import { MiniConsole } from "./components/MiniConsole";

// The Route Intelligence console is the miniapp. The scanner-era home (autonomy
// status, action inbox teasers, agent stream) went away with the web cockpit;
// its deep links still resolve at /actions, /inbox and /history.
//
// The console mounts unconditionally: the route-intelligence flag gates the API,
// not the product, and a missing source is reported on the surface itself.
export default function Home() {
  return <MiniConsole />;
}
