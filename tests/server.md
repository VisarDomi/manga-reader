# Server

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### Server Proxy

**T-BJ-1: Proxy is provider-agnostic**
Tests rule BJ.
The server proxy forwards requests to whatever domain the provider specifies. No hardcoded upstream domains.

**T-BJ-2: Cloudflare cookies keyed by domain**
Tests rule BJ.
Two providers on the same domain share Cloudflare cookies. Two providers on different domains solve independently.

### TLS CA Distribution

**T-BK-1: Server exposes mkcert root CA at well-known endpoint**
Tests rule BK.
The server serves the CA as a downloadable PEM file for iOS devices to install and trust.
