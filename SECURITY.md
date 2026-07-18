# Security policy

## Supported versions

vedit is currently a technical preview. Security fixes are provided on the
latest `main` revision only.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for `akakeishin/vedit`.
If that channel is unavailable, open a public issue that only asks the
maintainer for a private contact route. Do not include exploit details,
private videos, project manifests, access tokens, or other sensitive user
data in a public issue.

## Local trust boundary

vedit binds its Web NLE to loopback and is designed for one trusted local
user. It is not an authenticated multi-user server and must not be exposed to
a LAN or the public internet. Source media stays local unless the user invokes
a separate external tool; vedit does not implement publishing or uploads.
