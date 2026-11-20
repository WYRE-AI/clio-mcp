## [1.0.1](https://github.com/wyre-technology/clio-mcp/compare/v1.0.0...v1.0.1) (2026-07-29)


### Bug Fixes

* **security:** eliminate cross-tenant server-ref race in gateway mode ([#2](https://github.com/wyre-technology/clio-mcp/issues/2)) ([1d99ad8](https://github.com/wyre-technology/clio-mcp/commit/1d99ad8de0a8b35f3259b1194101498e68451f18)), closes [#4](https://github.com/wyre-technology/clio-mcp/issues/4)

# 1.0.0 (2026-07-15)


### Bug Fixes

* **ci:** install semantic-release plugin devDependencies ([ff1111d](https://github.com/wyre-technology/clio-mcp/commit/ff1111d89d98e1895097cbcf8911210abcfd31ab))


### Features

* initial Clio MCP server scaffold ([b9edc5a](https://github.com/wyre-technology/clio-mcp/commit/b9edc5a26c89313fbc37aca812f8ffdef265573a))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is maintained automatically by [semantic-release](https://semantic-release.gitbook.io/) from
[Conventional Commits](https://www.conventionalcommits.org/) on `main` -- entries below this point are
generated, not hand-edited.

## [Unreleased]

### Fixed

- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.
