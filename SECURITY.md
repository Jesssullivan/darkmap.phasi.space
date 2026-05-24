# Security policy

This repository is the source for the public darkmap site at
<https://darkmap.phasi.space>. The public edge is Cloudflare Tunnel backed; the
legacy `darkmap.tinyland.dev` path remains a tailnet ingress. The site has no
user accounts, payments, runtime database, or analytics.

## Reporting a vulnerability

Until a public security email is published, please report security
issues against this site via a **private GitHub security advisory** on
this repository:

<https://github.com/Jesssullivan/darkmap.phasi.space/security/advisories/new>

## Scope

In scope for this repository:

- Build / CI supply-chain issues
- Site content that misrepresents this brand or its data sources
- Secrets accidentally committed to history
- Third-party dep vulnerabilities affecting the build pipeline

Out of scope:

- Cosmetic / SEO / accessibility issues — please open a normal issue
- DDoS / availability

## What we won't do

- Bug bounties (no programme yet)
- Public discussion of unfixed issues until a coordinated disclosure
  date is agreed
