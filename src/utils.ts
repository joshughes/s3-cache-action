import * as core from "@actions/core";
import * as s3 from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";
import * as http from "http";
import * as https from "https";

import type { CompressionMethod } from "./cache";
import { Env, Inputs } from "./constants";

export function splitInput(str: string): string[] {
  return str
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("#"));
}

export function getCompressionMethod(): CompressionMethod {
  // Check new compression-method input first
  const compressionMethod = core.getInput(Inputs.CompressionMethod).toLowerCase();
  if (
    compressionMethod === "zstd" ||
    compressionMethod === "gzip" ||
    compressionMethod === "none"
  ) {
    return compressionMethod as CompressionMethod;
  }

  // Fall back to legacy enable-gzip for backwards compatibility
  const enableGzip = core.getInput(Inputs.EnableGzip) === "true";
  if (enableGzip) {
    core.warning(
      "The 'enable-gzip' input is deprecated. Please use 'compression-method: gzip' instead.",
    );
    return "gzip";
  }

  return "none";
}

export function newS3Client(): s3.S3Client {
  const region = getAWSInput("AWSRegion");
  const accessKeyId = getAWSInput("AWSAccessKeyId");
  const secretAccessKey = getAWSInput("AWSSecretAccessKey");
  const sessionToken = getAWSInput("AWSSessionToken");

  // Log the region being used for debugging
  if (region) {
    core.debug(`Using AWS region: ${region}`);
  } else {
    core.warning(
      "No AWS region specified. The SDK will attempt to determine the region automatically.",
    );
  }

  // Configure HTTP agents with connection pooling to maximize bandwidth
  // maxSockets controls how many concurrent connections can be made
  // Setting to 20 allows high parallelism for multipart uploads/downloads
  const maxSockets = 20;

  const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets,
    maxFreeSockets: 10
  });

  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets,
    maxFreeSockets: 10
  });

  return new s3.S3Client({
    region: region || undefined,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    // Follow region redirects automatically if the bucket is in a different region
    followRegionRedirects: true,
    // Use custom request handler with connection pooling for better throughput
    requestHandler: new NodeHttpHandler({
      httpAgent,
      httpsAgent,
    }),
  });
}

function getAWSInput(key: keyof typeof Inputs & keyof typeof Env): string {
  const value =
    core.getState(Env[key]) || core.getInput(Inputs[key]) || process.env[Env[key]] || "";
  core.saveState(Env[key], value);
  return value;
}
