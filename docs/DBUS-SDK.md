# D-Bus SDK connection contracts

`sysrt/sdk/js/dbus.mjs` maps Linux x86_64 libdbus through the existing generic
FFI. All endpoints take an **explicit bus address**. Opening, authentication and
Hello are synchronous setup; RPC waits are driven by zero-wait event-loop I/O.
There are no native filters, retained callbacks, worker threads or automatic
mutation retries.

`openDbusClient` and `openDbusService` preserve their existing scalar adapters:
empty or one `u/b/s/o` request, empty or fixed scalar-tuple replies, and a
well-known service name with a fixed path/interface. Their tickets/service polls
continue to drive their own private connections.

## Single-reader endpoint

`openDbusEndpoint(address, { objects, signals, limits })` owns one private
connection, accessible as `uniqueName`, without claiming a well-known name.
It supports outgoing calls and exported methods on that **same connection**.

- `objects`: finite `{ path, interface, methods, accept? }` declarations;
  methods map member names to `{ signature, replySignature }`.
- `signals`: finite `{ interface, member, signature, projection?, accept? }`
  declarations. Install bus matches explicitly using the daemon's `AddMatch`;
  receiving a match does not authorize its sender.
- `accept(sender, target)` is optional JS domain admission, evaluated on copied
  headers **before payload decoding**. Rejected signals are ignored; rejected
  methods receive AccessDenied (or suppress the response for NoReply). It does
  not run as an FFI callback.
- Optional native `limits` are `receivedBytes`, `messageBytes`, `receivedFDs`,
  `messageFDs`, `outgoingBytes`. The SDK does not introduce domain device,
  operation or UI capacity quotas.

`endpoint.poll()` is the sole reader. One poll performs nonblocking read/write
and pops at most one message. It returns a frozen signal or a retained method
request, or null (including routed replies/control traffic). `ticket.poll()`
only checks its outcome and monotonic deadline: callers must also drive the
endpoint. Nobody should dispatch/read the native connection independently.

`call(target, signature, args, replySignature, timeoutMs=25000, projection?)`
returns a stable pending/reply/error/cancelled ticket. Targets contain
destination/path/interface/member. Replies expose their copied sender; errors
expose the error name, **not remote diagnostic bodies**. Unique-name and daemon
targets enforce reply provenance. Well-known target consumers must resolve and
verify their own owner when trust matters.

Supported types are `n/u/b/s/o`, arrays, structs, dictionaries and variants.
Arguments are arrays; structs/dictionary entries are tuples; dictionaries remain
ordered arrays of pairs so duplicate keys are not hidden. Variants are
`{ signature, value }`. Empty replies have undefined value, a single argument
has its value, and multiple arguments have a frozen tuple.

`projection(path, signature)` may return false to intentionally skip an unused
value **before native iterator recursion**, producing the frozen `dbusSkipped`
marker. Dictionary keys extend `path`. Without projection, unsupported native
types fail explicitly; this is not a general D-Bus parser, introspection layer,
schema system or Unix-FD transport.

Retained requests have copied `target/sender/args/noReply` and single-use
`reply(args=[])`, `error(name,text)`, `close()`. Response results distinguish
native send acceptance from NoReply suppression. `notify` sends an explicit
NoReply method call; neither acceptance nor a local cancel means rollback or
guaranteed remote delivery.

`close()` resolves pending tickets and releases retained native replies and
requests before closing/unreferencing the connection. Poll/reply after close
cannot touch released native handles. `shutdownDbus()` refuses while **any**
SDK endpoint remains open and is only valid when the process exclusively owns
all libdbus users. A desktop with other native D-Bus services must not call it.

The real private-bus `sysrt-dbus-endpoint` test covers measured native ABI,
container/projection behavior, simultaneous agent/RPC/signal routing,
once-reply, NoReply, monotonic deadline, cancellation, GC and exact descriptor
restoration. Its harness also supports `--valgrind`; it never uses host buses.
