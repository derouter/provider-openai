import * as openai from "@derouter/protocol-openai";
import { Auth, RPC } from "@derouter/rpc";
import { readCborOnce, writeCbor } from "@derouter/rpc/util";
import json5 from "json5";
import assert from "node:assert";
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { Duplex } from "stream";
import * as v from "valibot";
import { parseEther, parseWeiToEth, pick } from "./lib/util.js";

enum FailureReason {
  UnhandledError,

  /**
   * Request body contents violate the OpenAI protocol.
   */
  ProtocolRequestBody,

  /**
   * Model ID mismatches the offer's.
   */
  ProtocolModelId,

  /**
   * We've encountered an OpenAI service error.
   */
  OpenAIError,
}

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
const config = configParseResult.output;
console.dir(config, { depth: null, colors: true });

class OpenAiProxyProvider {
  private readonly _rpc: RPC;

  constructor(readonly config: v.InferOutput<typeof ConfigSchema>) {
    this._rpc = new RPC(config.rpc_host, config.rpc_port, Auth.Provider);

    this._rpc.emitter.on("providerOpenConnection", (event) =>
      this.onConnection(event)
    );

    this._rpc.providerConfig({
      provider_id: "@derouter/provider-openai_proxy@0.1.0",
      offers: Object.fromEntries(
        Object.entries(config.offers).map(([offerId, offer]) => [
          offerId,
          {
            protocol: openai.ProtocolId,
            protocol_payload: offer satisfies openai.OfferPayload,
          },
        ])
      ),
    });
  }

  async onConnection(data: {
    customer_peer_id: string;
    protocol_id: string;
    offer_id: string;
    protocol_payload: any;
    connection_id: number;
    stream: Duplex;
  }): Promise<void> {
    console.debug("onConnection", data);

    const openAiClient = new OpenAI({
      baseURL: config.openai_base_url,
      apiKey: config.openai_api_key ?? "",
    });

    connectionLoop: while (true) {
      console.debug("Waiting for a request...");

      const request = await readCborOnce<
        openai.completions.RequestBody | openai.chatCompletions.RequestBody
      >(data.stream);

      if (!request) {
        console.debug("Empty request, breaking connection loop");
        break connectionLoop;
      }

      const { database_job_id, provider_job_id, created_at_sync } =
        await this._rpc.providerCreateJob({
          connection_id: data.connection_id,
          private_payload: JSON.stringify({ request }),
        });

      const bodyParseResult = v.safeParse(
        "prompt" in request
          ? openai.completions.RequestBodySchema
          : openai.chatCompletions.RequestBodySchema,
        request
      );

      if (!bodyParseResult.success) {
        console.warn(
          "Invalid OpenAI Request Body",
          v.flatten(bodyParseResult.issues)
        );

        await this._rpc.providerFailJob({
          database_job_id: database_job_id,
          reason: JSON.stringify(v.flatten(bodyParseResult.issues)),
          reason_class: FailureReason.ProtocolRequestBody,
        });

        await writeCbor(data.stream, {
          status: "ProtocolViolation",
          message: "Invalid OpenAI Request Body",
        } satisfies openai.ResponsePrologue);

        break connectionLoop;
      }

      const body = bodyParseResult.output;

      if (body.model !== data.protocol_payload.model_id) {
        console.warn("Model ID Mismatch", {
          expected: data.protocol_payload.model_id,
          received: body.model,
        });

        await this._rpc.providerFailJob({
          database_job_id: database_job_id,
          reason: JSON.stringify({
            expected: data.protocol_payload.model_id,
            received: body.model,
          }),
          reason_class: FailureReason.ProtocolModelId,
        });

        await writeCbor(data.stream, {
          status: "ProtocolViolation",
          message: "Model ID Mismatch",
        } satisfies openai.ResponsePrologue);

        break connectionLoop;
      }

      if (body.stream) {
        let response;

        try {
          console.debug("Making OpenAI request...", {
            ...body,
            stream: true,
            stream_options: {
              include_usage: true,
            },
          });

          response =
            "prompt" in body
              ? await openAiClient.completions.create({
                  ...body,
                  stream: true,
                  stream_options: {
                    include_usage: true,
                  },
                })
              : await openAiClient.chat.completions.create({
                  ...body,
                  stream: true,
                  stream_options: {
                    include_usage: true,
                  },
                });
        } catch (e: any) {
          console.error("OpenAI error", e);

          await this._rpc.providerFailJob({
            database_job_id: database_job_id,
            reason: e.message,
            reason_class: FailureReason.OpenAIError,
          });

          await writeCbor(data.stream, {
            status: "ServiceError",
            message: "Internal Server Error",
          } satisfies openai.ResponsePrologue);

          continue connectionLoop;
        }

        const prologue: openai.ResponsePrologue = {
          status: "Ok",
          provider_job_id,
          created_at_sync,
        };

        console.debug("Writing prologue...", prologue);
        await writeCbor(data.stream, prologue);

        let usage;
        const chunks = [];

        // BUG: OpenAI may fail during the stream.
        for await (const chunk of response) {
          chunks.push(chunk);
          if (chunk.usage) usage = chunk.usage;

          console.debug("Writing chunk...", chunk);
          await writeCbor(data.stream, chunk);
        }

        assert(usage);

        const public_payload = JSON.stringify(
          "prompt" in body
            ? ({
                request: {
                  ...pick(body, [
                    "model",
                    "frequency_penalty",
                    "max_tokens",
                    "n",
                    "presence_penalty",
                    "stream",
                    "temperature",
                    "top_p",
                  ]),
                },

                response: { usage },
              } satisfies openai.completions.PublicJobPayload)
            : ({
                request: {
                  ...pick(body, [
                    "model",
                    "store",
                    "reasoning_effort",
                    "frequency_penalty",
                    "max_tokens",
                    "max_completion_tokens",
                    "n",
                    "presence_penalty",
                    "response_format",
                    "stream",
                    "temperature",
                    "top_p",
                  ]),
                },

                response: { usage },
              } satisfies openai.chatCompletions.PublicJobPayload)
        );

        const balance_delta = openai.calcCost(data.protocol_payload, usage);

        const { completed_at_sync } = await this._rpc.providerCompleteJob({
          database_job_id,
          balance_delta,
          public_payload,
          private_payload: JSON.stringify({ request, response: chunks }),
        });

        const epilogue =
          "prompt" in body
            ? ({
                object: "derouter.epilogue",
                balance_delta,
                public_payload,
                completed_at_sync,
              } satisfies openai.completions.EpilogueChunk)
            : ({
                object: "derouter.epilogue",
                balance_delta,
                public_payload,
                completed_at_sync,
              } satisfies openai.chatCompletions.EpilogueChunk);

        console.debug("Writing epilogue...", epilogue);
        await writeCbor(data.stream, epilogue);

        console.info(
          `Request complete ($POL ~${parseWeiToEth(balance_delta)})!`
        );
      } else {
        const prologue: openai.ResponsePrologue = {
          status: "Ok",
          provider_job_id,
          created_at_sync,
        };

        console.debug("Writing prologue...", prologue);
        await writeCbor(data.stream, prologue);

        let response;

        try {
          console.debug("Making OpenAI request...", {
            ...body,
            stream: false,
          });

          response =
            "prompt" in body
              ? ((await openAiClient.completions.create({
                  ...body,
                  stream: false,
                })) satisfies openai.completions.Response)
              : ((await openAiClient.chat.completions.create({
                  ...body,
                  stream: false,
                })) satisfies openai.chatCompletions.Response);
        } catch (e: any) {
          console.error("OpenAI error", e);

          await this._rpc.providerFailJob({
            database_job_id,
            reason: e.message,
            reason_class: FailureReason.OpenAIError,
          });

          await writeCbor(data.stream, {
            status: "ServiceError",
            message: "Internal Server Error",
          } satisfies openai.ResponsePrologue);

          continue connectionLoop;
        }

        console.debug("Writing response...", response);
        await writeCbor(data.stream, response);

        assert(response.usage);

        const public_payload = JSON.stringify(
          "prompt" in body
            ? ({
                request: {
                  ...pick(body, [
                    "model",
                    "frequency_penalty",
                    "max_tokens",
                    "n",
                    "presence_penalty",
                    "stream",
                    "temperature",
                    "top_p",
                  ]),
                },

                response: { usage: response.usage },
              } satisfies openai.completions.PublicJobPayload)
            : ({
                request: {
                  ...pick(body, [
                    "model",
                    "store",
                    "reasoning_effort",
                    "frequency_penalty",
                    "max_tokens",
                    "max_completion_tokens",
                    "n",
                    "presence_penalty",
                    "response_format",
                    "stream",
                    "temperature",
                    "top_p",
                  ]),
                },

                response: { usage: response.usage },
              } satisfies openai.chatCompletions.PublicJobPayload)
        );

        const balance_delta = openai.calcCost(
          data.protocol_payload,
          response.usage
        );

        console.debug("this.completeJob()...", {
          database_job_id,
          public_payload,
          balance_delta,
          private_payload: JSON.stringify({ request, response }),
        });

        const { completed_at_sync } = await this._rpc.providerCompleteJob({
          database_job_id,
          public_payload,
          balance_delta,
          private_payload: JSON.stringify({ request, response }),
        });

        const epilogue =
          "prompt" in body
            ? ({
                public_payload,
                balance_delta,
                completed_at_sync,
              } satisfies openai.completions.Epilogue)
            : ({
                public_payload,
                balance_delta,
                completed_at_sync,
              } satisfies openai.chatCompletions.Epilogue);

        console.debug("Writing epilogue...", epilogue);
        await writeCbor(data.stream, epilogue);

        console.info(
          `Request complete ($POL ~${parseWeiToEth(balance_delta)})!`
        );
      }
    }

    console.debug("Dropped connection", data.connection_id);
  }
}

new OpenAiProxyProvider(config);
