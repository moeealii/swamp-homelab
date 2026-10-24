# @moeealii/homelab

[Swamp](https://github.com/swamp-club/swamp) behaviors for keeping an eye on a homelab: a TrueNAS SCALE server, the Immich photo library running on it, and the cameras behind go2rtc. Each check writes typed swamp data, so a workflow can watch everything at once and other models can react to it with CEL.

| Type | What it covers |
|---|---|
| `@moeealii/truenas` | System info, ZFS pools, apps, alerts. Start and stop apps. TrueNAS 25.10+ JSON-RPC API |
| `@moeealii/immich` | Library totals, upload-volume capacity, background queues, albums. Immich 2.x and 3.x |
| `@moeealii/go2rtc` | Configured streams, and whether each camera actually produces a frame right now |

## Setup

Store the credentials in a vault. `vault put` prompts for each value, so nothing ends up in your shell history:

```sh
swamp vault put default TRUENAS_API_KEY
swamp vault put default IMMICH_API_KEY
```

TrueNAS ships with a self-signed certificate issued to `localhost`. Pin it rather than turning verification off:

```sh
openssl s_client -connect nas.lan:443 </dev/null 2>/dev/null | openssl x509 > nas.pem
```

Create one definition per service:

```sh
swamp model create @moeealii/truenas nas \
  --global-arg host=nas.lan \
  --global-arg 'apiKey=${{ vault.get(default, TRUENAS_API_KEY) }}' \
  --global-arg "certificatePem=$(cat nas.pem)"

swamp model create @moeealii/immich photos \
  --global-arg url=http://nas.lan:2283 \
  --global-arg 'apiKey=${{ vault.get(default, IMMICH_API_KEY) }}'

swamp model create @moeealii/go2rtc cameras --global-arg url=http://nas.lan:1984
```

## Usage

```sh
swamp model method run nas pools
swamp model method run nas startApp --input name=immich
swamp model method run cameras health
swamp workflow run @moeealii/homelab-health
```

The bundled `@moeealii/homelab-health` workflow runs pool, alert, app, photo-queue and camera checks in parallel against definitions named `nas`, `photos` and `cameras`. Every step has `allowFailure`, so one unreachable service doesn't hide the state of the others.

Other models can read the results, for example to page someone when a pool degrades:

```yaml
globalArguments:
  message: >-
    ${{ data.latest("nas", "pool-tank").attributes.status }}
```

## Methods and data

**`@moeealii/truenas`**

| Method | Writes |
|---|---|
| `info` | `system`: version, hostname, model, cores, memory, uptime |
| `pools` | `pool-<name>` per pool: status, health, size/allocated/free, used %, last scrub state and errors |
| `apps` | `app-<name>` per app: state, version, whether an upgrade or newer image is available |
| `alerts` | `alerts`: undismissed alerts with counts of critical, error and warning |
| `startApp` / `stopApp` | Runs the TrueNAS job, waits for it to finish, then writes the app's new state |

**`@moeealii/immich`**

| Method | Writes |
|---|---|
| `library` | `library`: version, photos, videos, bytes used, users (needs an admin key) |
| `disk` | `disk`: capacity of the upload volume |
| `queues` | `queue-<name>` per background queue, plus `queues`: which are busy, failing or paused, and the total backlog |
| `albums` | `album-<id>` per album: name, asset count, shared, last activity |

**`@moeealii/go2rtc`**

| Method | Writes |
|---|---|
| `streams` | `stream-<name>` per stream: sources with credentials stripped, connected producers, viewers |
| `health` | `health-<name>` per stream (online, latency, frame size, error) and `health-summary`. Optional `streams` argument to check a subset |

## How it talks to TrueNAS

TrueNAS 25.10 removed the REST API. Everything goes through JSON-RPC 2.0 on `wss://<host>/api/current`. Two details shaped this extension:

- **The certificate is self-signed and issued to `localhost`.** Deno's `WebSocket` can't trust one certificate for one connection: giving it a custom HTTP client forces HTTP/2, which TrueNAS doesn't speak. So this package opens the TLS connection itself with `Deno.connectTls({ caCerts: [pinned] })` and speaks the WebSocket protocol (RFC 6455) on top, in about 270 lines. Only the pinned certificate is trusted. A different certificate fails with `UnknownIssuer`, even for the right host.
- **API keys never travel in plain text.** TrueNAS revokes a key that is used over plain HTTP, so there is deliberately no `ws://` option.

Calls are sequential on one session and matched to their replies by id, so event notifications in between are ignored. Each call has a timeout. Error messages keep the middleware's reason (`[EPERM] Not authorized`) and drop its Python traceback.

## Development

```sh
deno task check
deno task test
```

The tests run each behavior's real `execute` against fakes. TrueNAS gets a real WebSocket JSON-RPC server on 127.0.0.1, so handshake, framing, login, jobs, timeouts and interleaved notifications are all exercised. Immich and go2rtc get scripted HTTP responses.
