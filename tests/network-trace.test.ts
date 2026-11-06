import { expect, test } from "bun:test"
import { getNonLoopbackNetworkCalls } from "../scripts/network-trace"

test("accepts the connected local HTTP request and response from the Linux search smoke test", () => {
  const trace = `2726  sendto(10<TCP:[127.0.0.1:41150->127.0.0.1:36139]>, "GET /datasheet-api/datasheets/li"..., 185, MSG_DONTWAIT|MSG_NOSIGNAL, NULL, 0) = 185
2701  sendmsg(11<TCP:[127.0.0.1:36139->127.0.0.1:41150]>, {msg_name=NULL, msg_namelen=0, msg_iov=[{iov_base="HTTP/1.1 200 OK"..., iov_len=203}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, MSG_DONTWAIT|MSG_NOSIGNAL <unfinished ...>`
  expect(getNonLoopbackNetworkCalls(trace)).toEqual([])
})

test.each(["127.0.0.2", "[::1]", "[::ffff:127.0.0.1]"])(
  "accepts connected loopback sends using %s",
  (address) => {
    const protocol = address.startsWith("[") ? "TCPv6" : "TCP"
    const trace = ["sendto", "sendmsg", "sendmmsg"].map((call) =>
      `100  ${call}(10<${protocol}:[${address}:1234->${address}:5678]>, ...`,
    ).join("\n")
    expect(getNonLoopbackNetworkCalls(trace)).toEqual([])
  },
)

test("still accepts explicit loopback destinations and local IPC", () => {
  const trace = `100 connect(10<TCP:[123]>, {sa_family=AF_INET, sin_port=htons(1234), sin_addr=inet_addr("127.0.0.1")}, 16) = 0
100 connect(10<TCPv6:[123]>, {sa_family=AF_INET6, sin6_port=htons(1234), inet_pton(AF_INET6, "::1", &sin6_addr)}, 28) = 0
100 sendto(10<UDP:[123]>, "data", 4, 0, {sa_family=AF_INET, sin_port=htons(1234), sin_addr=inet_addr("127.0.0.1")}, 16) = 4
100 sendmsg(10<UNIX-STREAM:[123->456]>, {msg_name=NULL, ...}, 0) = 4`
  expect(getNonLoopbackNetworkCalls(trace)).toEqual([])
})

test("rejects external connections, DNS, connected sends and unknown destinations", () => {
  const calls = [
    '100 connect(10<TCP:[123]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.1")}, 16) = -1 ENETUNREACH',
    '100 sendto(10<UDP:[123]>, "query", 5, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("192.0.2.53")}, 16) = -1 ENETUNREACH',
    '100 sendto(10<TCP:[127.0.0.1:1234->203.0.113.1:443]>, "127.0.0.1", 9, 0, NULL, 0) = 9',
    '100 sendmsg(10<TCPv6:[[::1]:1234->[2001:db8::1]:443]>, {msg_name=NULL, ...}, 0) = 4',
    '100 sendmmsg(10<TCP:[192.0.2.1:1234->203.0.113.1:443]>, [...], 1, 0) = 1',
    '100 sendto(10<TCP:[123]>, "data", 4, 0, NULL, 0) = 4',
  ]
  expect(getNonLoopbackNetworkCalls(calls.join("\n"))).toEqual(calls)
})

test("ignores receives, listeners and resumed lines", () => {
  const trace = `100 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 10
100 listen(10<TCP:[127.0.0.1:1234]>, 128) = 0
100 recvfrom(10<TCP:[127.0.0.1:1234->127.0.0.1:5678]>, "data", 4, 0, NULL, NULL) = 4
100 <... sendmsg resumed>) = 4`
  expect(getNonLoopbackNetworkCalls(trace)).toEqual([])
})
