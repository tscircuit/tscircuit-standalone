const loopbackEndpoint = String.raw`(?:127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\]):\d+`
// With strace -yy, sends on connected TCP sockets identify both endpoints
// in the file descriptor instead of repeating the destination sockaddr.
const loopbackTcpSend = new RegExp(
  String.raw`^\d+\s+(?:sendto|sendmsg|sendmmsg)\(\d+<TCP(?:v6)?:\[${loopbackEndpoint}->${loopbackEndpoint}\]>,`,
)

export function getNonLoopbackNetworkCalls(trace: string): string[] {
  return trace.split("\n").filter((line) =>
    /^\d+\s+(?:connect|sendto|sendmsg|sendmmsg)\(/.test(line) &&
    !/\b(?:sendto|sendmsg|sendmmsg)\(\d+<UNIX-STREAM/.test(line) &&
    !/inet_addr\("127\.[0-9.]+"\)|inet_pton\(AF_INET6, "(?:::1|::ffff:127\.[0-9.]+)"/.test(line) &&
    !loopbackTcpSend.test(line),
  )
}
