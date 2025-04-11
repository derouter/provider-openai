# DeRouter OpenAI Provider

[![Build](https://github.com/derouter/provider-openai/actions/workflows/build.yaml/badge.svg)](https://github.com/derouter/provider-openai/actions/workflows/build.yaml)

A [DeRouter](https://derouter.org) Provider module conforming to the [OpenAI protocol](https://github.com/derouter/protocol-openai).

It proxies requests incoming from the DeRouter network to a configured OpenAI-compatible URL.
The module connects to a running [DeRouter node](https://github.com/derouter/derouter).
See [`config.example.jsonc`](./config.example.jsonc) for example configuration.

## 👷 Development

```sh
npm run build
npm start -- -c./config.json
```

```sh
# Run with nodemon.
npm run dev -- -- -- -c./config.json
```

## 🚀 Releases

The module may be compiled into a single binary with NodeJS's [SEA](https://nodejs.org/api/single-executable-applications.html).
You can download a binary from the [Releases](https://github.com/derouter/provider-openai/releases) page, or build it manually.

### Linux

```sh
./scripts/compile/linux.sh
./dist/bin/output -c./config.json
```

### Windows

```pwsh
./scripts/compile/win32.ps1
./dist/bin/output.exe -c ./config.json
```

### MacOS

```sh
./scripts/compile/darwin.sh
./dist/bin/output -c./config.json
```
