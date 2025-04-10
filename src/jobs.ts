import * as openai from "@derouter/protocol-openai";
import { RPC } from "@derouter/rpc";
import { writeCbor } from "@derouter/rpc/util";
import { eq } from "drizzle-orm";
import assert from "node:assert";
import { Writable } from "node:stream";
import OpenAI from "openai";
import { ReReadable } from "rereadable-stream";
import { d } from "./lib/drizzle.js";
import { parseWeiToEth, pick, safeTryAsync } from "./lib/util.js";

export class StreamingCompletionJob {
  private _responseStream = new ReReadable();

  constructor(private localJobId: number) {}

  async prefetch() {
    const job = await d.db.query.jobs.findFirst({
      where: eq(d.jobs.rowid, this.localJobId),
    });

    if (!job) {
      throw new Error(`Failed to prefetch job #${this.localJobId}`);
    }

    if (job.openaiError) {
      await writeCbor(this._responseStream, {
        status: "ServiceError",
      } satisfies openai.ResponsePrologue);

      this._responseStream.end();
    } else if (job.output) {
      assert(job.completedAtSync);
      assert(job.publicPayload);

      await writeCbor(this._responseStream, {
        status: "Ok",
      } satisfies openai.ResponsePrologue);

      const chunks = JSON.parse(job.output) as (
        | openai.completions.CompletionChunk
        | openai.chatCompletions.CompletionChunk
      )[];

      for (const chunk of chunks) {
        await writeCbor(this._responseStream, chunk);
      }

      await writeCbor(this._responseStream, {
        object: "derouter.epilogue",
        balance_delta: job.balanceDelta,
        completed_at_sync: job.completedAtSync,
        public_payload: job.publicPayload,
      } satisfies openai.StreamingEpilogueChunk);

      this._responseStream.end();
    } else {
      // This can't be.
      throw new Error("Prefetched job is still in-progress");
    }
  }

  async connect(stream: Writable) {
    this._responseStream.rewind().pipe(stream);
  }

  async process(
    openAiClient: OpenAI,
    provider_peer_id: string,
    provider_job_id: string,
    offerPayload: openai.OfferPayload,
    input: openai.RequestBody,
    rpc: RPC
  ) {
    const responseResult = await safeTryAsync(() =>
      // BUG:
      //@ts-ignore
      "prompt" in input
        ? openAiClient.completions.create({
            ...input,
            stream: true,
            stream_options: {
              include_usage: true,
            },
          })
        : openAiClient.chat.completions.create({
            ...input,
            stream: true,
            stream_options: {
              include_usage: true,
            },
          })
    );

    if (!responseResult.success) {
      if (responseResult.error instanceof OpenAI.OpenAIError) {
        console.warn(responseResult.error);

        await Promise.all([
          writeCbor(this._responseStream, {
            status: "ServiceError",
          } satisfies openai.ResponsePrologue),

          d.db
            .update(d.jobs)
            .set({ openaiError: responseResult.error.message }),

          rpc.failJob({
            provider_peer_id,
            provider_job_id,
            reason: "Service Error",
            reason_class: openai.ReasonClass.ServiceError,
            private_payload: JSON.stringify({
              request: input,
            }),
          }),
        ]);

        return;
      } else {
        throw responseResult.error;
      }
    }

    const response = responseResult.output;

    await writeCbor(this._responseStream, {
      status: "Ok",
    } satisfies openai.ResponsePrologue);

    let usage;
    const chunks = [];

    try {
      for await (const chunk of response) {
        chunks.push(chunk);
        await writeCbor(this._responseStream, chunk);
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (e) {
      if (e instanceof OpenAI.OpenAIError) {
        console.warn(e);

        await Promise.all([
          d.db.update(d.jobs).set({ openaiError: e.message }),

          rpc.failJob({
            provider_peer_id,
            provider_job_id,
            reason: "Service Error",
            reason_class: openai.ReasonClass.ServiceError,
            private_payload: JSON.stringify({
              request: input,
              response: chunks,
            }),
          }),
        ]);

        return;
      } else {
        throw e;
      }
    }

    assert(usage);

    const public_payload = JSON.stringify(
      "prompt" in input
        ? ({
            request: {
              ...pick(input, [
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
              ...pick(input, [
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

    const balance_delta = openai.calcCost(offerPayload, usage);

    const { completed_at_sync } = await rpc.providerCompleteJob({
      provider_peer_id,
      provider_job_id,
      balance_delta,
      public_payload,
      private_payload: JSON.stringify({
        input,
        output: chunks,
      }),
    });

    await Promise.all([
      writeCbor(this._responseStream, {
        object: "derouter.epilogue",
        balance_delta,
        public_payload,
        completed_at_sync,
      } satisfies openai.StreamingEpilogueChunk),

      d.db
        .update(d.jobs)
        .set({
          output: JSON.stringify(chunks),
          completedAtSync: completed_at_sync,
          balanceDelta: balance_delta,
          publicPayload: public_payload,
        })
        .where(eq(d.jobs.rowid, this.localJobId)),
    ]);

    console.info(
      `✅ Completed streaming request ($POL ~${parseWeiToEth(balance_delta)})`
    );

    this._responseStream.end();
  }
}

export class NonStreamingCompletionJob {
  private _responseStream = new ReReadable();

  constructor(private jobRowid: number) {}

  async prefetch() {
    const job = await d.db.query.jobs.findFirst({
      where: eq(d.jobs.rowid, this.jobRowid),
    });

    if (!job) {
      throw new Error(`Failed to prefetch job #${this.jobRowid}`);
    }

    if (job.openaiError) {
      await writeCbor(this._responseStream, {
        status: "ServiceError",
      } satisfies openai.ResponsePrologue);

      this._responseStream.end();
    } else if (job.output) {
      await writeCbor(this._responseStream, {
        status: "Ok",
      } satisfies openai.ResponsePrologue);

      await writeCbor(this._responseStream, JSON.parse(job.output));

      this._responseStream.end();
    } else {
      // This can't be.
      throw new Error("Prefetched job is still in-progress");
    }
  }

  async connect(stream: Writable) {
    this._responseStream.rewind().pipe(stream);
  }

  async process(
    openAiClient: OpenAI,
    provider_peer_id: string,
    provider_job_id: string,
    offerPayload: openai.OfferPayload,
    input: openai.RequestBody,
    rpc: RPC
  ) {
    const responseResult = await safeTryAsync(() =>
      // BUG:
      // @ts-ignore
      "prompt" in input
        ? openAiClient.completions.create({
            ...input,
            stream: false,
          })
        : openAiClient.chat.completions.create({
            ...input,
            stream: false,
          })
    );

    if (!responseResult.success) {
      if (responseResult.error instanceof OpenAI.OpenAIError) {
        console.warn(responseResult.error);

        await Promise.all([
          writeCbor(this._responseStream, {
            status: "ServiceError",
          } satisfies openai.ResponsePrologue),

          d.db
            .update(d.jobs)
            .set({ openaiError: responseResult.error.message }),

          rpc.failJob({
            provider_peer_id,
            provider_job_id,
            reason: "Service Error",
            reason_class: openai.ReasonClass.ServiceError,
            private_payload: JSON.stringify({
              request: input,
            }),
          }),
        ]);

        return;
      } else {
        throw responseResult.error;
      }
    }

    const response = responseResult.output;
    assert(response.usage);

    await writeCbor(this._responseStream, {
      status: "Ok",
    } satisfies openai.ResponsePrologue);

    await writeCbor(this._responseStream, response);

    const public_payload = JSON.stringify(
      "prompt" in input
        ? ({
            request: {
              ...pick(input, [
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
              ...pick(input, [
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

    const balance_delta = openai.calcCost(offerPayload, response.usage);
    const output = response;

    const { completed_at_sync } = await rpc.providerCompleteJob({
      provider_peer_id,
      provider_job_id,
      balance_delta,
      public_payload,
      private_payload: JSON.stringify({
        input,
        output,
      }),
    });

    await Promise.all([
      writeCbor(this._responseStream, {
        balance_delta,
        completed_at_sync,
        public_payload,
      } satisfies openai.NonStreamingResponseEpilogue),

      d.db
        .update(d.jobs)
        .set({
          output: JSON.stringify(output),
          completedAtSync: completed_at_sync,
          balanceDelta: balance_delta,
          publicPayload: public_payload,
        })
        .where(eq(d.jobs.rowid, this.jobRowid)),
    ]);

    console.info(
      `✅ Completed request ($POL ~${parseWeiToEth(balance_delta)})`
    );

    this._responseStream.end();
  }
}
