# Windows named-pipe broker

The host uses this small self-contained .NET helper on Windows because Node's
`net.createServer(path)` does not expose Windows security-descriptor or client-token
controls. The helper is part of the trusted host boundary; it never receives the
bridge HMAC key and only forwards bytes after OS authorization.

Security properties:

- `CreateNamedPipeW` receives a protected DACL with exactly one allow ACE: full
  control for the daemon process's current **logon SID**. The owner is the daemon's
  `TokenUser` SID.
- `PIPE_REJECT_REMOTE_CLIENTS` and `FILE_FLAG_FIRST_PIPE_INSTANCE` reject remote
  access and pipe-name squatting.
- The broker reads back the live handle's owner/DACL before announcing readiness.
  The Node host then runs a second `inspect` process against that live handle.
- Before forwarding the first byte, the broker calls `ImpersonateNamedPipeClient`,
  opens the thread token, and requires both `TokenUser` and the `SE_GROUP_LOGON_ID`
  SID to match the daemon.
- The Node host independently checks the broker's identity metadata and verifies
  an HMAC envelope before invoking any request handler.

These controls follow Microsoft's named-pipe security guidance and client
impersonation APIs:

- <https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights>
- <https://learn.microsoft.com/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient>
- <https://learn.microsoft.com/windows/win32/secauthz/getting-the-logon-sid-in-c-->

## Build and package

From `packages/host` on Windows:

```powershell
pnpm native:build
pnpm native:publish
```

`native:publish` emits deterministic self-contained single-file artifacts and
SHA-256 manifests under:

```text
native/bin/win-x64/
native/bin/win-arm64/
```

CI cross-publishes and verifies the PE machine type for both architectures on an
x64 Windows runner. GitHub-hosted Windows ARM64 execution is not assumed; the
win-arm64 artifact is architecture-checked but must be smoke-tested on real ARM64
Windows hardware before release promotion.
