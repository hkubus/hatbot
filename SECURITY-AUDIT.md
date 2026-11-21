# Hatbot security audit

Scope: the whole repository at commit `37ee7b0` — the brain, desktop-agent, boxes guest, web and
native clients, and the deploy scripts and systemd units under `infra/`. Read-only: nothing outside
this file was changed.

The threat model that matters most is this one. Hatbot is an LLM agent that reads untrusted web
pages, forge text, logs and SSH output, and can then act on the owner's homelab. Two classes of
attacker follow from that: a **prompt injector** who gets text in front of the model, and a
**network attacker** who reaches the web app. Both are graded separately below, because a finding
that matters only to one of them is not the same finding.

---

## Critical

### 1. Any signed-in session or API token can become root on the brain

`POST /api/v1/update` is guarded by `requireAuth` alone (`apps/brain/src/routes/admin.ts:33,93-102`).
`requireAuth` accepts any session and any Bearer token (`apps/brain/src/auth/middleware.ts:25`). Any
session can mint a token (`apps/brain/src/routes/auth.ts:166-175`). The handler then writes
`/var/lib/hatbot/update-request` (`apps/brain/src/updates.ts:48-50`) with no second factor and no
confirmation.

That file is watched by `hatbot-update.path`, which runs `infra/hatbot-update.sh` **as root**
(`infra/brain-deploy.sh:150-159`). That script fetches the configured branch and runs **the fetched
commit's own `infra/brain-deploy.sh` as root** (`infra/hatbot-update.sh:98-99`).

Signature checking happens only when `HATBOT_UPDATE_SIGNERS` is set (`infra/hatbot-update.sh:70-80`).
It is unset by default, and `deploy.sh:209` only *warns* about it. The brain even displays the
`"signed": false` state in Settings (`infra/brain-deploy.sh:176-180`) without ever gating on it.

So: whoever can push to the configured branch, or steal one session cookie or one token, gets root
on the brain. README says "give it only a repository you control" — that covers the pusher, not
the session holder.

**Fix.** Require a fresh password + TOTP for `/update`; fail closed in `hatbot-update.sh` when
signers are unset; do not let the web tier write the trigger file at all — have `hatbot-update.path`
accept only a request the root-side unit creates after its own check.

### 2. The release tree root deploys is owned by the brain's own user

`infra/brain-deploy.sh:27-33` extracts each release and then `chown -R hatbot:hatbot`. The brain
runs as `hatbot` (`:52`) with `ReadWritePaths=/var/lib/hatbot` (`:76`). A later deploy extracts into
that tree and runs `bun install --frozen-lockfile` in it (`:38`), and `bun -e` with that cwd
(`:111-112`) — both as `hatbot`, so package install scripts run with the brain's privileges in a
tree the brain can rewrite.

This one is lower than #1 because the build already runs as `hatbot` (`as_hatbot`, `:13,38,40`),
not as root — an earlier draft of this audit said otherwise. What remains is that a compromised
brain can plant files that a *later* deploy picks up, and that `bun install` executes lifecycle
scripts with the web app's privileges.

**Fix.** Extract to a root-owned directory, build there, and `--ignore-scripts`; keep the brain's
`ReadWritePaths` to data, memory, archive and the update request only.

---

## High

### 3. A "rest of this task" approval is not tied to the untrusted source it was given for

`Approvals.granted()` (`apps/brain/src/approvals.ts:272-289`) matches a `session`-scoped approval on
`bot_id`, `tool`, `target`, `task_id`/`episode_id`. It never compares *which* untrusted content
caused the ask.

The sequence: a task reads page A (an SSH log, a web page), asks for `ssh_exec` on `nas`, and the
owner answers "for the rest of this task". The task then reads page B. Injected text on B can now
reuse that grant for a different command on the same target with no prompt. The desktop path has the
same shape (`apps/brain/src/tasks/desktop-run.ts` `armed`), though there the page must match.

`scopesFor` offers the session scope for any taint-driven ask except money, `always` and suspected
injection (`apps/brain/src/agent/review.ts:39`), and `ssh_exec` and other destructive tools are
included.

**Fix.** Record the taint source on the approval and match it in `granted()`; don't offer the
session scope for destructive write kinds.

### 4. Status output is trusted, but several "status" commands print names other people choose

`ssh_exec` output is untrusted unless the command passes `statusOnly` (`apps/brain/src/plugins/ssh/index.ts:552-553`).
`statusOnly` judges the *command*, not what it prints. These are classified trusted (verified by
running the function):

- `ip -br addr`, `ip link`, `ip neigh` — interface labels and links (`policy.ts:291`); a compose
  network or a workload that names an interface plants the text.
- `systemctl --failed --plain` and `list-units` without `--no-legend` (`policy.ts:292,306`) — unit
  names are chosen by anything that installs a unit; without the flag a unit named like the legend
  reads as the legend.
- `docker ps -a --format '{{.Names}}'` — container names, and a custom `--format` can print labels
  an image author chose (`policy.ts:295`).
- `pct list` — guest hostnames, set from inside the guest.
- `zpool status`, `df -h` — pool and device labels.

Anyone who can name a container, unit, guest or interface can therefore put text in front of the
model that it treats as trusted: no taint, no ceiling on writes, no review. The existing tests
(`apps/brain/test/ssh-plugin.test.ts:190-260`) cover what the command *reads*, not what it *prints*.

Relatedly, `ssh_check errors` runs `journalctl -p err` (`apps/brain/src/plugins/ssh/index.ts:53`).
A syslog message is attacker-written and carries its own priority, so a service that logs at `err`
passes its text through — on hosts with `trustOutput` this bypasses the taint even though the
comment two lines above says logs are untrusted.

**Fix.** Treat anything whose output includes a name as untrusted — at minimum `ip`, `docker ps`,
`pct list`, `systemctl --failed` — and require `--no-legend` for `list-units`; run `errors` with
`-o cat`. A test per command, asserting `untrusted: true`.

### 4b. The destructive-command list misses writes and obfuscation

These pass `destructive()` (`apps/brain/src/plugins/ssh/policy.ts:20-134`) yet change system state:
`printf … > /etc/nginx/nginx.conf`, `sed -i` and `tee` onto a system file; `install -m 4755 bash /tmp/x`
(`install` has no rule); `find . -exec sh -c '…'` and `find . -exec busybox rm {} +` (only a bare
`rm` is matched); a base64-decoded payload piped to `sh` (only `curl`/`wget` piping is matched);
`cd /etc && rm -f *` (the glob rule wants `/*`). `ip -4 addr flush dev eth0` is classed read-only
because `changes()` reads `-4` as the `ip` object (`policy.ts:340`), which on a Proxmox host skips
the careful-host check.

None of these escapes approval once a task has read untrusted content, since that gate is taint-based
rather than pattern-based. The gap is the untainted path, plus the `ssh_exec` description telling the
model the pattern check is what protects it.

**Fix.** Add rules for redirections, `tee` and `sed -i` onto system paths, `install`, `find -exec` of
any shell, and `| sh` regardless of where the bytes came from; detect `ip`'s object properly.

### 4c. MCP tool descriptions reach the prompt unfiltered

Results from an MCP server are always untrusted (`apps/brain/src/plugins/mcp/index.ts:456`), which is
right. Descriptions are not: `untrustedDefinition` (`:457`) taints the task but leaves the text in
the prompt as an ordinary tool description. `visible()` (`:70-80`) strips format characters but not
ANSI escapes, and Settings' Accept button accepts every pending tool of a server at once
(`apps/web/src/plugins/mcp.tsx:265-280`), so an owner accepting one tool also vets the others blind.

**Fix.** Strip ANSI in `visible()`, and accept per tool. This is the documented "third-party code
comes in through MCP" risk, so the default of untrusted-plus-taint is reasonable; the UI is the part
worth tightening.

---

## Medium

### 5. The renderer checks the first host, then lets Chromium resolve again
`apps/desktop-agent/src/render.ts:57` resolves and validates the target host, then launches Chromium
on the **hostname** with no resolver pinning, no proxy and no redirect check. Redirects,
subresources and a rebinding window are outside the check that was made. `/fetch` and the boxes
egress do this correctly by pinning the checked address (`apps/desktop-agent/src/fetch.ts:80-95`,
`apps/hatbox/src/egress.ts:47-56`).

**Fix.** Launch the renderer with `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE <checked ip>` per
render, or route it through the same pinned path `/fetch` uses.

### 6. Four write tools run without approval when nothing is tainted
`verdictFor` allows a write with no `policy` (`apps/brain/src/plugins/registry.ts:475,484`). With no
taint there is then no approval at all: `pbs_verify`, `pbs_garbage_collect`,
`proxmox_snapshot` and `self_update`. None reads untrusted content, so this is a correctness gap
rather than an injection path — but `pbs_garbage_collect` and `self_update` are irreversible.

**Fix.** Give irreversible tools an explicit `policy`, and a `target` so they can't run concurrently
with each other.

### 7. The Linux app writes attachments to a name the model can influence
`apps/brain/src/attachments.ts:137` strips only CR, LF, `/` and `\`, so `..` survives in a name;
`apps/linux/src/ui/files.rs:207-222` joins that name onto the cache directory without a components
check and writes it when the owner opens the file. A model-chosen name such as `../../x.desktop`
escapes the cache directory. The user has to click, so this is not remote code execution, but it is
a write outside the intended directory.

**Fix.** Reject `..` in `attachments.ts` as the brain sanitizes it, and check components in the Linux
app before writing.

### 8. The brain listens on all interfaces with a plaintext fallback
`infra/brain-deploy.sh:55` sets `HATBOT_HOST=0.0.0.0`. The desktop and boxes guest are firewalled off
port 8080 (`infra/verify.sh:121,251`), but any other host on the LAN can reach it directly, bypassing
the TLS-terminating proxy. Session cookies are marked `Secure` whenever `HATBOT_PUBLIC_URL` is
`https://` (`apps/brain/src/auth/middleware.ts:15`), so a sign-in over that plaintext path gets a
cookie the browser won't send back over HTTP — the plaintext path is not a silent credential leak.
Still, the health check and every unauthenticated route are exposed unencrypted.

**Fix.** Bind `127.0.0.1` and let the reverse proxy on the same guest reach it, or document the
firewall rule as required rather than optional.

### 9. A temp file holding every secret is created 0644
`infra/lib.sh:92-105` (`push_secret`) uses `mktemp`, inheriting the caller's umask (022 in
`host-setup.sh` and `deploy.sh`). A crash between write and cleanup leaves the file readable. The
same secret-in-a-temp-file shape is used for the API key and the git token.

**Fix.** `tmp=$(umask 077; mktemp)` plus a `trap` that removes it.

### 10. `update-request` is a file the brain writes and root reads
Independent of #1, the brain (or anything that can act as it, including a prompt injection that
reaches a shell on the brain) can write the trigger file directly. Root then acts on it without
knowing which path produced it.

**Fix.** Have the root-side unit verify the request was made through the authenticated, second-factor
checked route — for example by having root create the file and the brain only name a commit that
root validates.

---

## Low

- **A false-positive screen disables both reviewers.** `suspected === true` skips Haiku *and* Opus
  (`apps/brain/src/agent/review.ts:34-39`), so a page that trips the screener turns every subsequent
  write into a manual prompt. Sound in the safe direction, inconvenient in practice.
- **`proxmox_power` has no `kind`**, so a taint-driven power-off asks as `"other"`, which a phone
  notification may approve (`apps/brain/src/plugins/proxmox/index.ts:192`, `approvals.ts:17-18`).
- **`verify.sh` has a check that fails by construction**: `:188-189` compares `%a %G` to `"750 desk"`
  while the unit leaves root as owner, so it prints `"750 root"`.
- **`verify.sh` probes the sandbox from root**, so `PrivateTmp`/`PrivateIPC` are inferred, not proven
  (`infra/verify.sh:162-189`).
- **`deploy.sh:27`** runs `pct exec … git archive` on a user-supplied directory as root.
- **The brain unit has no `MemoryMax`/`TasksMax`**, unlike the desktop and boxes guest.

---

## What holds up

These were checked specifically and are sound, with the line that proves it:

- **No same-turn read-then-write injection gap.** `inBatches` evaluates `verdictFor` and
  `untrustedOf` for *every* call before any runs, and splits reads from writes
  (`apps/brain/src/tasks/agent-run.ts:806-820`, `apps/brain/src/agent/tools.ts:1940-1963`). A write
  in the same turn as a read does not escape the taint ceiling.
- **Cookie CSRF.** Cookie-authenticated writes require the exact public `Origin`
  (`apps/brain/src/auth/middleware.ts:39-42`); verified: a foreign origin gets 403. The WebSocket
  handshake checks it too (`apps/brain/src/routes/stream.ts:52-60`, `routes/desktop.ts:60-70`).
- **Sign-in limiting.** Failures are counted before the check, by signed device cookie or client IP,
  with a global limit (`apps/brain/src/routes/auth.ts:43-62`); verified that rotating
  `X-Forwarded-For` from an unlisted proxy does not reset the IP limit.
- **SSRF guards.** `privateAddress` covers IPv4-mapped/compatible/translated IPv6, NAT64, 6to4,
  Teredo, ULA and link-local, and fails closed on non-IPs (`packages/shared/src/net.ts:14-37`);
  `/fetch` and box egress pin the checked address across redirects.
- **Box isolation.** Each unit has `PrivateNetwork=yes`, `AF_UNIX` only and a read-only `/run/hatbox`
  (`infra/boxes-deploy.sh:127-132`); the egress `env` op returns only that box's secrets.
- **Desktop shell.** `ProtectHome=yes` with a DynamicUser, no sudo; nftables keeps its UID off
  `127.0.0.1:9222` (`infra/desktop-deploy.sh:98,132,142`).
- **The `hatbot-pct-exec` wrapper** refuses Hatbot's own containers by ID and by tag, and the sudo
  rule is scoped to it alone (`infra/pct-exec-setup.sh:60-103`).
- **SSH quoting.** `quote()` is the canonical `'\''` escape and `remotePath` allows no NUL or newline
  (`apps/brain/src/plugins/ssh/index.ts:735,789-793`); no breakout found. Every `Bun.spawn` in the
  brain is array-form with no shell.
- **MCP results and definitions' names.** Results are always untrusted; tool and server names are
  sanitized to `[A-Za-z0-9_-]` and stdio servers get only their own `env`, never the brain's.
- **Web rendering.** No raw HTML anywhere (`react-markdown` defaults, `apps/web/src/markdown.tsx:1`);
  `javascript:` URLs can't run from chat content thanks to the CSP (`apps/brain/src/web.ts:5-10`),
  and both native apps reject plain `http://`.
- **Secrets.** `secrets.json` is 600 and deliberately outside the DB so snapshots don't carry it
  (`apps/brain/src/secrets.ts:157-166`); CI runs tests, Biome, typecheck, licences, shellcheck and
  the firewall test.
