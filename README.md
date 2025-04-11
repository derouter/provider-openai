# DeRouter OpenAI Provider

A [DeRouter](https://derouter.org) Provider module which proxies OpenAI-compatible requests to an OpenAI-compatible endpoint.

## Development

```sh
npm run build
npm start -- -c./config.local.jsonc
```

```sh
# Run with nodemon.
npm run dev -- -- -- -c./config.local.jsonc
```

## Build

```sh
./compile.sh
./dist/bin/main
```
