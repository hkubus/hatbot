// Which addresses are the internet, for the agents that fetch for the brain: desktop-agent's /fetch and
// the boxes guest's egress (PLAN.md §6.4, §21.6). No zod: the agents ship without it.
import { BlockList, isIP } from "node:net";

/** Two lists: BlockList would match an IPv4 address against an IPv6 rule as ::ffff:a.b.c.d. */
const blockList = (type: "ipv4" | "ipv6", nets: string[]) => {
  const list = new BlockList();
  for (const net of nets) {
    const [ip = "", len] = net.split("/");
    list.addSubnet(ip, Number(len), type);
  }
  return list;
};
const BLOCKED = {
  ipv4: blockList("ipv4", [
    ...["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16"],
    ...["172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16"],
    ...["198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3"],
  ]),
  ipv6: blockList("ipv6", [
    // Outside global unicast (2000::/3): ::/8 with its IPv4 forms and NAT64, ULA, link-local, multicast.
    ...["::/3", "4000::/2", "8000::/1"],
    // IETF protocols (Teredo among them), documentation, and 6to4, which carries an IPv4 address.
    ...["2001::/23", "2001:db8::/32", "3fff::/20", "2002::/16"],
  ]),
};

/**
 * Loopback, private, link-local and other addresses that aren't the internet, in any form: IPv4-mapped,
 * -compatible and -translated IPv6 (::ffff:7f00:1, ::127.0.0.1), NAT64, 6to4 and Teredo included. IPv6
 * passes only inside global unicast. Anything that isn't an address counts as private.
 */
export function privateAddress(ip: string): boolean {
  const bare = ip.replace(/%.*$/, "");
  const type = ({ 4: "ipv4", 6: "ipv6" } as const)[isIP(bare) as 4 | 6];
  return !type || BLOCKED[type].check(bare, type);
}
