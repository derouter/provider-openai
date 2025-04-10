import * as openai from "@derouter/protocol-openai";
import {
  ProviderCreateJobData,
  ProviderCreateJobResponseData,
  ProviderPrepareJobConnectionData,
  ProviderPrepareJobConnectionResponseData,
  RPC,
} from "@derouter/rpc";
import { and, eq } from "drizzle-orm";
import OpenAI from "openai";
import { Duplex } from "stream";
import * as v from "valibot";
import { ConfigSchema } from "./config.js";
import { NonStreamingCompletionJob, StreamingCompletionJob } from "./jobs.js";
import { d } from "./lib/drizzle.js";
import { safeTry } from "./lib/util.js";

export class OpenAiProxyProvider {
  private readonly _rpc: RPC;
  private readonly _openAiClient: OpenAI;
  private connectionNonce = 0;

  private readonly _jobProcessors = new Map<
    number,
    StreamingCompletionJob | NonStreamingCompletionJob
  >();

  private readonly _awaitingConnections = new Map<
    number,
    {
      jobRowid: number;
      streaming: boolean;
    }
  >();

  constructor(readonly config: v.InferOutput<typeof ConfigSchema>) {
    this._openAiClient = new OpenAI({
      baseURL: config.openai_base_url,
      apiKey: config.openai_api_key ?? "",
    });

    this._rpc = new RPC(config.rpc_host, config.rpc_port);

    this._rpc.emitter.on("providerOpenJobConnection", (event) =>
      this.onJobConnection(event)
    );

    this.init();
  }

  async init() {
    for (const [offerId, offer] of Object.entries(this.config.offers)) {
      const payload = {
        offer_id: offerId,
        protocol_id: openai.ProtocolId,
        protocol_payload: JSON.stringify(offer satisfies openai.OfferPayload),
      };

      console.debug("Providing", payload);
      await this._rpc.providerProvideOffer(payload);
    }

    this._rpc.setOnProviderCreateJob((data) => this.onCreateJob(data));

    this._rpc.setOnProviderPrepareJobConnection((data) =>
      this.onPrepareJobConnection(data)
    );

    console.info("✅ Provider initialized");
  }

  async onCreateJob(
    data: ProviderCreateJobData
  ): Promise<ProviderCreateJobResponseData> {
    console.log("onCreateJob", data);

    if (data.protocol_id !== openai.ProtocolId) {
      throw new Error(`Invalid protocol_id: ${data.protocol_id}`);
    }

    const offer = this.config.offers[data.offer_id];
    if (!offer) {
      throw new Error(`Invalid offer_id: ${data.offer_id}`);
    }

    if (!data.job_args) {
      return {
        tag: "InvalidJobArgs",
        content: "Expected args",
      };
    }

    const jobArgsJsonResult = safeTry(() => JSON.parse(data.job_args!));

    if (!jobArgsJsonResult.success) {
      return {
        tag: "InvalidJobArgs",
        content: `Failed to parse args as JSON: ${jobArgsJsonResult.error}`,
      };
    }

    const jobArgsJson = jobArgsJsonResult.output;

    const jobArgsParseResult = v.safeParse(
      openai.RequestBodySchema,
      jobArgsJson
    );

    if (!jobArgsParseResult.success) {
      console.warn(v.flatten(jobArgsParseResult.issues));

      return {
        tag: "InvalidJobArgs",
        content: JSON.stringify(v.flatten(jobArgsParseResult.issues)),
      };
    }

    const input = jobArgsParseResult.output;

    let jobRowid = (
      await d.db
        .insert(d.jobs)
        .values({
          providerPeerId: data.provider_peer_id,
          providerJobId: data.provider_job_id,
          input: JSON.stringify(input),
          streaming: input.stream ?? false,
        })
        .returning({
          rowid: d.jobs.rowid,
        })
    )[0].rowid;

    const job = input.stream
      ? new StreamingCompletionJob(jobRowid)
      : new NonStreamingCompletionJob(jobRowid);

    job.process(
      this._openAiClient,
      data.provider_peer_id,
      data.provider_job_id,
      offer,
      input,
      this._rpc
    );

    this._jobProcessors.set(jobRowid, job);

    return {
      tag: "Ok",
    };
  }

  async onPrepareJobConnection(
    data: ProviderPrepareJobConnectionData
  ): Promise<ProviderPrepareJobConnectionResponseData> {
    const job = await d.db.query.jobs.findFirst({
      where: and(
        eq(d.jobs.providerPeerId, data.provider_peer_id),
        eq(d.jobs.providerJobId, data.provider_job_id)
      ),
      columns: {
        rowid: true,
        streaming: true,
      },
    });

    if (job) {
      const nonce = this.connectionNonce++;

      this._awaitingConnections.set(nonce, {
        jobRowid: job.rowid,
        streaming: job.streaming,
      });

      return {
        tag: "Ok",
        content: nonce.toString(),
      };
    } else {
      return {
        tag: "JobNotFound",
      };
    }
  }

  async onJobConnection(data: {
    connection_id: number;
    nonce: string;
    stream: Duplex;
  }): Promise<void> {
    const job = this._awaitingConnections.get(parseInt(data.nonce));

    if (!job) {
      throw new Error(`Unexpected nonce: ${data.nonce}`);
    }

    let jobProcessor = this._jobProcessors.get(job.jobRowid);

    if (!jobProcessor) {
      console.log("Job processor not found for", job.jobRowid);

      jobProcessor = job.streaming
        ? new StreamingCompletionJob(job.jobRowid)
        : new NonStreamingCompletionJob(job.jobRowid);

      jobProcessor.prefetch();

      this._jobProcessors.set(job.jobRowid, jobProcessor);
    }

    jobProcessor.connect(data.stream);
  }
}
