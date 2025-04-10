import json5 from "json5";
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { parseEther } from "./lib/util.js";

const PriceSchema = v.object({
  $pol: v.pipe(
    v.string(),
    v.check((x) => {
      let num = parseFloat(x);
      if (Number.isNaN(num)) return false;
      if (num < 0) return false;
      return true;
    }, "Must be parsed as a positive number"),
    v.transform((x) => parseEther(x).toString())
  ),
});

export const ConfigSchema = v.object({
  rpc_host: v.optional(v.string(), "127.0.0.1"),
  rpc_port: v.optional(v.number(), 4269),
  openai_base_url: v.pipe(v.string(), v.url()),
  openai_api_key: v.optional(v.string()),
  database_url: v.string(),
  offers: v.record(
    v.string(),
    v.object({
      model_id: v.string(),
      context_size: v.pipe(v.number(), v.integer(), v.minValue(1)),
      description: v.optional(v.string()),
      input_token_price: PriceSchema,
      output_token_price: PriceSchema,
      trial: v.optional(PriceSchema),
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
  console.error("--config or -c argument expected");
  process.exit(1);
}

const configText = fs.readFileSync(configPath, { encoding: "utf8" });
const configJson = json5.parse(configText);
const configParseResult = v.safeParse(ConfigSchema, configJson);
if (!configParseResult.success) {
  console.error("Failed to parse config", v.flatten(configParseResult.issues));
  process.exit(1);
}
export const config = configParseResult.output;
console.dir(config, { depth: null, colors: true });
