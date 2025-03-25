import { Provider } from "@derouter/provider";
import json5 from "json5";
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import * as v from "valibot";

const PriceSchema = v.object({
  $pol: v.string(),
});

export const ConfigSchema = v.object({
  rpcHost: v.optional(v.string(), "127.0.0.1"),
  rpcPort: v.optional(v.number(), 4269),
  offers: v.record(
    v.string(),
    v.object({
      modelId: v.string(),
      contextSize: v.pipe(v.number(), v.integer(), v.minValue(1)),
      description: v.optional(v.string()),
      input1MTokenPrice: PriceSchema,
      output1MTokenPrice: PriceSchema,
      trialAllowance: v.optional(PriceSchema),
    })
  ),
});

const { values } = parseArgs({
  args: process.argv,
  allowPositionals: true,
  options: {
    config: {
      type: "string",
      short: "c",
    },
  },
});

const configPath = values.config;

if (!configPath) {
  console.error("--config argument expected");
  process.exit(1);
}

const configText = fs.readFileSync(configPath, { encoding: "utf8" });
const configJson = json5.parse(configText);
const config = v.parse(ConfigSchema, configJson);
console.dir(config, { depth: null, colors: true });

class OpenAiProxyProvider extends Provider {}

new OpenAiProxyProvider(
  {
    offers: Object.fromEntries(
      Object.entries(config.offers).map(([offerId, offer]) => [
        offerId,
        {
          protocol: "openai@0",
          protocol_payload: offer,
        },
      ])
    ),
  },
  config.rpcHost,
  config.rpcPort
).loop();
