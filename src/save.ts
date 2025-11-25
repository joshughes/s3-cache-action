import * as core from "@actions/core";

import { saveCache } from "./cache";
import { Inputs, State } from "./constants";
import { getCompressionMethod, newS3Client, splitInput } from "./utils";

export async function save() {
  // Get the inputs.
  const path = splitInput(
    core.getState(State.CachePath) || core.getInput(Inputs.Path, { required: true }),
  );
  const key = core.getState(State.CacheKey) || core.getInput(Inputs.Key, { required: true });
  const bucketName = core.getInput(Inputs.BucketName, { required: true });
  const compressionMethod = getCompressionMethod();
  core.debug(`${Inputs.Path}: [${path.join(", ")}]`);
  core.debug(`${Inputs.Key}: ${key}`);
  core.debug(`${Inputs.BucketName}: ${bucketName}`);
  core.debug(`Compression method: ${compressionMethod}`);

  // If the cache has already been restored, don't save it again.
  if (core.getState(State.CacheHit) === "true") {
    core.info(`Cache restored from S3 with key ${key}, not saving cache.`);
    return;
  }

  // Save the cache to S3.
  await saveCache(path, key, bucketName, newS3Client(), compressionMethod);
}

if (require.main === module) {
  (async () => {
    try {
      await save();
    } catch (error: unknown) {
      if (error instanceof Error) {
        core.setFailed(error);
      }
    }
  })();
}
