import * as openaiProtocol from "@derouter/protocol-openai";
import { Provider } from "@derouter/provider";
import { readCborOnce, writeCbor } from "@derouter/provider/util";
import json5 from "json5";
import assert from "node:assert";
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { Duplex } from "stream";
import * as v from "valibot";
import { parseEther, parseWeiToEth } from "./lib/util.js";

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

class OpenAiProxyProvider extends Provider<openaiProtocol.OfferPayload> {
  async onConnection(
    customerPeerId: string,
    offer: {
      protocolId: string;
      offerId: string;
      protocolPayload: openaiProtocol.OfferPayload;
    },
    connectionId: number,
    stream: Duplex
  ): Promise<void> {
    console.debug("onConnection", { customerPeerId, offer, connectionId });

    connectionLoop: while (true) {
      console.debug("Waiting for a request...");
      const request = await readCborOnce<
        | openaiProtocol.CompletionsRequestBody
        | openaiProtocol.ChatCompletionRequestBody
      >(stream);

      if (!request) {
        console.debug("Empty request, breaking connection loop");
        break connectionLoop;
      }

      const jobId = "42";

      if ("prompt" in request) {
        const bodyParseResult = v.safeParse(
          openaiProtocol.completions.RequestBodySchema,
          request
        );

        if (!bodyParseResult.success) {
          console.warn(
            "Invalid OpenAI Request Body",
            v.flatten(bodyParseResult.issues)
          );

          await writeCbor(stream, {
            status: "ProtocolViolation",
            message: "Invalid OpenAI Request Body",
          } satisfies openaiProtocol.ResponsePrologue);

          break connectionLoop;
        }

        const body = bodyParseResult.output;

        if (body.model !== offer.protocolPayload.model_id) {
          console.warn("Model ID Mismatch", {
            expected: offer.protocolPayload.model_id,
            received: body.model,
          });

          await writeCbor(stream, {
            status: "ProtocolViolation",
            message: "Model ID Mismatch",
          } satisfies openaiProtocol.ResponsePrologue);

          break connectionLoop;
        }

        if (body.stream) {
          let response;

          try {
            console.debug("Making an OpenAI request...");

            response = await new OpenAI({
              baseURL: config.openai_base_url,
              apiKey: config.openai_api_key ?? "",
            }).completions.create({
              ...body,
              stream: true,
              stream_options: {
                include_usage: true,
              },
            });
          } catch (e: any) {
            console.error("Unhandled OpenAI error", e);

            await writeCbor(stream, {
              status: "ServiceError",
              message: "Internal Server Error",
            } satisfies openaiProtocol.ResponsePrologue);

            continue connectionLoop;
          }

          const prologue: openaiProtocol.ResponsePrologue = {
            status: "Ok",
            jobId,
          };

          console.debug("Writing prologue...", prologue);
          await writeCbor(stream, prologue);

          let usage;
          const chunks = [];

          for await (const chunk of response) {
            chunks.push(chunk);
            if (chunk.usage) usage = chunk.usage;

            console.debug("Writing chunk...", chunk);
            await writeCbor(
              stream,
              chunk satisfies openaiProtocol.CompletionsStreamChunk
            );
          }

          assert(usage);

          const balanceDelta = openaiProtocol.calcCost(
            offer.protocolPayload,
            usage
          );

          const epilogue: openaiProtocol.CompletionsStreamChunk = {
            object: "derouter.epilogue",
            jobId,
            balanceDelta,
          };

          console.debug("Writing epilogue...", epilogue);
          await writeCbor(stream, epilogue);

          console.info(
            `Request complete ($POL ~${parseWeiToEth(balanceDelta)})!`
          );
        } else {
          const prologue: openaiProtocol.ResponsePrologue = {
            status: "Ok",
            jobId: "42",
          };

          console.debug("Writing prologue...", prologue);
          await writeCbor(stream, prologue);

          let response;

          try {
            console.debug("Making an OpenAI request...");

            response = await new OpenAI({
              baseURL: config.openai_base_url,
              apiKey: config.openai_api_key ?? "",
            }).completions.create({
              ...body,
              stream: false,
            });
          } catch (e: any) {
            console.error("Unhandled OpenAI error", e);

            await writeCbor(stream, {
              status: "ServiceError",
              message: "Internal Server Error",
            } satisfies openaiProtocol.ResponsePrologue);

            continue connectionLoop;
          }

          console.debug("Writing response...", response);
          await writeCbor(
            stream,
            response satisfies openaiProtocol.CompletionsResponse
          );

          assert(response.usage);

          const balanceDelta = openaiProtocol.calcCost(
            offer.protocolPayload,
            response.usage
          );

          const epilogue: openaiProtocol.NonStreamingResponseEpilogue = {
            jobId,
            balanceDelta,
          };

          console.debug("Writing epilogue...", epilogue);
          await writeCbor(stream, epilogue);

          console.info(
            `Request complete ($POL ~${parseWeiToEth(balanceDelta)})!`
          );
        }
      } else {
        const bodyParseResult = v.safeParse(
          openaiProtocol.chatCompletions.RequestBodySchema,
          request
        );

        if (!bodyParseResult.success) {
          console.warn(
            "Invalid OpenAI Request Body",
            v.flatten(bodyParseResult.issues)
          );

          await writeCbor(stream, {
            status: "ProtocolViolation",
            message: "Invalid OpenAI Request Body",
          } satisfies openaiProtocol.ResponsePrologue);

          break connectionLoop;
        }

        const body = bodyParseResult.output;

        if (body.model !== offer.protocolPayload.model_id) {
          console.warn("Model ID Mismatch", {
            expected: offer.protocolPayload.model_id,
            received: body.model,
          });

          await writeCbor(stream, {
            status: "ProtocolViolation",
            message: "Model ID Mismatch",
          } satisfies openaiProtocol.ResponsePrologue);

          break connectionLoop;
        }

        if (body.stream) {
          let response;

          try {
            console.debug("Making an OpenAI request...");

            response = await new OpenAI({
              baseURL: config.openai_base_url,
              apiKey: config.openai_api_key ?? "",
            }).chat.completions.create({
              ...body,
              stream: true,
              stream_options: {
                include_usage: true,
              },
            });
          } catch (e: any) {
            console.error("Unhandled OpenAI error", e);

            await writeCbor(stream, {
              status: "ServiceError",
              message: "Internal Server Error",
            } satisfies openaiProtocol.ResponsePrologue);

            continue connectionLoop;
          }

          const prologue: openaiProtocol.ResponsePrologue = {
            status: "Ok",
            jobId,
          };

          console.debug("Writing prologue...", prologue);
          await writeCbor(stream, prologue);

          let usage;
          const chunks = [];

          console.debug("Iterating chunks...");
          for await (const chunk of response) {
            chunks.push(chunk);
            if (chunk.usage) usage = chunk.usage;

            console.debug("Writing chunk...", chunk);
            await writeCbor(
              stream,
              chunk satisfies openaiProtocol.ChatCompletionsStreamChunk
            );
          }

          assert(usage);

          const balanceDelta = openaiProtocol.calcCost(
            offer.protocolPayload,
            usage
          );

          const epilogue: openaiProtocol.ChatCompletionsStreamChunk = {
            object: "derouter.epilogue",
            jobId,
            balanceDelta,
          };

          console.debug("Writing epilogue...", epilogue);
          await writeCbor(stream, epilogue);

          console.info(
            `Request complete ($POL ~${parseWeiToEth(balanceDelta)})!`
          );
        } else {
          const prologue: openaiProtocol.ResponsePrologue = {
            status: "Ok",
            jobId,
          };

          console.debug("Writing prologue...", prologue);
          await writeCbor(stream, prologue);

          let response;

          try {
            console.debug("Making an OpenAI request...");

            response = await new OpenAI({
              baseURL: config.openai_base_url,
              apiKey: config.openai_api_key ?? "",
            }).chat.completions.create({
              ...body,
              stream: false,
            });
          } catch (e: any) {
            console.error("Unhandled OpenAI error", e);

            await writeCbor(stream, {
              status: "ServiceError",
              message: "Internal Server Error",
            } satisfies openaiProtocol.ResponsePrologue);

            continue connectionLoop;
          }

          console.debug("Writing response...", response);

          await writeCbor(
            stream,
            response satisfies openaiProtocol.ChatCompletionsResponse
          );

          assert(response.usage);

          const balanceDelta = openaiProtocol.calcCost(
            offer.protocolPayload,
            response.usage
          );

          const epilogue: openaiProtocol.NonStreamingResponseEpilogue = {
            jobId,
            balanceDelta,
          };

          console.debug("Writing epilogue...", epilogue);
          await writeCbor(stream, epilogue);

          console.info(
            `Request complete ($POL ~${parseWeiToEth(balanceDelta)})!`
          );
        }
      }
    }

    console.debug("Dropped connection", connectionId);
  }
}

new OpenAiProxyProvider(
  {
    provider_id: "@derouter/provider-openai_proxy@0.1.0",
    offers: Object.fromEntries(
      Object.entries(config.offers).map(([offerId, offer]) => [
        offerId,
        {
          protocol: openaiProtocol.ProtocolId,
          protocol_payload: offer,
        },
      ])
    ),
  },
  config.rpc_host,
  config.rpc_port
).loop();
