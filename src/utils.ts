import * as core from "@actions/core";
import * as s3 from "@aws-sdk/client-s3";

import { Env, Inputs } from "./constants";

export function splitInput(str: string): string[] {
  return str
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("#"));
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
    core.warning("No AWS region specified. The SDK will attempt to determine the region automatically.");
  }
  
  return new s3.S3Client({
    region: region || undefined,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    // Follow region redirects automatically if the bucket is in a different region
    followRegionRedirects: true,
  });
}

function getAWSInput(key: keyof typeof Inputs & keyof typeof Env): string {
  const value =
    core.getState(Env[key]) || core.getInput(Inputs[key]) || process.env[Env[key]] || "";
  core.saveState(Env[key], value);
  return value;
}
