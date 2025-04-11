# DeRouter OpenAI Provider

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

## ⚒️ Compilation

The module may be compiled into a single binary with NodeJS's [SEA](https://nodejs.org/api/single-executable-applications.html).
This feature is currently only available on MacOS.

```sh
./compile.sh
./dist/bin/main -c./config.json
```
