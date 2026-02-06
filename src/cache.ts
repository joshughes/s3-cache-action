import * as core from "@actions/core";
import * as glob from "@actions/glob";
import * as s3 from "@aws-sdk/client-s3";
import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as tar from "tar";
import * as tmp from "tmp";
import { promisify } from "util";

import { Client } from "./client";

const execCommand = promisify(require("child_process").exec);

export type CompressionMethod = "none" | "gzip" | "zstd";

/**
 * Save cache to Amazon S3.
 * @param paths The paths to cache.
 * @param key The cache key.
 * @param bucketName The S3 bucket name.
 * @param s3Client The S3 client.
 * @param compressionMethod The compression method to use.
 * @returns A boolean indicating whether the cache is saved or skipped.
 */
export async function saveCache(
  paths: string[],
  key: string,
  bucketName: string,
  s3Client: s3.S3Client,
  compressionMethod: CompressionMethod = "none",
): Promise<boolean> {
  const client = new Client(bucketName, s3Client);

  // Expand glob patterns of the paths.
  const expandedPaths = await glob
    .create(paths.join("\n"), { implicitDescendants: false })
    .then((globber) => globber.glob());
  core.debug(`expanded paths: [${expandedPaths.join(", ")}]`);
  if (expandedPaths.length === 0) {
    core.info("No files matched the cache paths. Skipping cache save.");
    return false;
  }

  const file = fileName(paths, compressionMethod);

  // If the cache already exists, do not save the cache.
  if (await client.headObject(key, file)) {
    core.info(`Cache found in S3 with key ${key}, not saving cache.`);
    return false;
  }

  // Create a tarball archive.
  const archive = archivePath(compressionMethod);
  try {
    core.info(`Creating archive with ${compressionMethod} compression: ${archive}`);
    await createArchive(archive, expandedPaths, compressionMethod);

    // Save the cache to S3.
    await client.putObject(key, file, fs.createReadStream(archive));
    core.info(`Cache saved to S3 with key ${key}, ${fileSize(archive)} bytes.`);
    return true;
  } finally {
    try {
      core.debug(`Deleting archive ${archive}.`);
      fs.unlinkSync(archive);
    } catch (error: unknown) {
      if (error instanceof Error && !("code" in error && error.code === "ENOENT")) {
        core.debug(`Failed to delete archive: ${error}`);
      }
    }
  }
}

/**
 * Restore cache from Amazon S3.
 * @param paths The paths to cache.
 * @param key The cache key.
 * @param restoreKeys The restore keys.
 * @param bucketName The S3 bucket name.
 * @param s3Client The S3 client.
 * @param compressionMethod The compression method to use.
 * @returns The matched key of the cache.
 */
export async function restoreCache(
  paths: string[],
  key: string,
  restoreKeys: string[],
  bucketName: string,
  s3Client: s3.S3Client,
  compressionMethod: CompressionMethod = "none",
): Promise<string | undefined> {
  const client = new Client(bucketName, s3Client);
  const file = fileName(paths, compressionMethod);
  const archive = archivePath(compressionMethod);

  try {
    let restoredKey: string | undefined;
    // Restore the cache from S3 with the cache key.
    if (await client.getObject(key, file, fs.createWriteStream(archive))) {
      restoredKey = key;
    } else {
      core.info(`Cache not found in S3 with key ${key}.`);
      // Restore the cache from S3 with the restore keys.
      L: for (const restoreKey of restoreKeys) {
        for (const key of await client.listObjects(restoreKey, file)) {
          if (await client.getObject(key, file, fs.createWriteStream(archive))) {
            restoredKey = key;
            break L;
          }
        }
        core.info(`Cache not found in S3 with restore key ${restoreKey}.`);
      }
    }

    if (restoredKey) {
      // Extract the tarball archive.
      core.info(`Extracting archive with ${compressionMethod} decompression: ${archive}`);
      await extractArchive(archive, compressionMethod);
      core.info(`Cache restored from S3 with key ${restoredKey}, ${fileSize(archive)} bytes.`);
    }

    return restoredKey;
  } finally {
    try {
      core.debug(`Deleting archive ${archive}.`);
      fs.unlinkSync(archive);
    } catch (error: unknown) {
      if (error instanceof Error && !("code" in error && error.code === "ENOENT")) {
        core.debug(`Failed to delete archive: ${error}`);
      }
    }
  }
}

/**
 * Lookup cache from Amazon S3.
 * @param paths The paths to cache.
 * @param key The cache key.
 * @param restoreKeys The restore keys.
 * @param bucketName The S3 bucket name.
 * @param s3Client The S3 client.
 * @param compressionMethod The compression method to use.
 * @returns The matched key of the cache.
 */
export async function lookupCache(
  paths: string[],
  key: string,
  restoreKeys: string[],
  bucketName: string,
  s3Client: s3.S3Client,
  compressionMethod: CompressionMethod = "none",
): Promise<string | undefined> {
  const client = new Client(bucketName, s3Client);
  const file = fileName(paths, compressionMethod);

  let foundKey: string | undefined;
  // Lookup the cache from S3 with the cache key.
  if (await client.headObject(key, file)) {
    core.info(`Cache found in S3 with key ${key}.`);
    foundKey = key;
  } else {
    core.info(`Cache not found in S3 with key ${key}.`);
    // Lookup the cache from S3 with the restore keys.
    L: for (const restoreKey of restoreKeys) {
      for (const key of await client.listObjects(restoreKey, file)) {
        if (await client.headObject(key, file)) {
          core.info(`Cache found in S3 with key ${key}, restore key ${restoreKey}.`);
          foundKey = key;
          break L;
        }
      }
      core.info(`Cache not found in S3 with restore key ${restoreKey}.`);
    }
  }

  return foundKey;
}

/**
 * Check if a command is available on the system.
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execCommand(`command -v ${command}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a compressed archive using the specified compression method.
 */
async function createArchive(
  archive: string,
  paths: string[],
  compressionMethod: CompressionMethod,
): Promise<void> {
  if (compressionMethod === "none") {
    // No compression - just create tar
    await tar.create({ file: archive, preservePaths: true }, paths);
  } else if (compressionMethod === "gzip") {
    // Use gzip compression (built into tar library)
    await tar.create({ file: archive, gzip: true, preservePaths: true }, paths);
  } else if (compressionMethod === "zstd") {
    // Use zstd with optimal multi-threaded settings
    if (!(await isCommandAvailable("zstd"))) {
      throw new Error(
        "zstd command not found. Please install zstd or use a different compression method.",
      );
    }
    if (!(await isCommandAvailable("tar"))) {
      throw new Error(
        "tar command not found. Please install tar or use a different compression method.",
      );
    }

    const cpuCount = os.cpus().length;
    core.info(`Compressing with tar | zstd pipeline using ${cpuCount} threads...`);

    await new Promise<void>((resolve, reject) => {
      // Pipe tar directly to zstd for optimal performance
      // This avoids creating intermediate uncompressed tar file
      const tarProcess = spawn(
        "tar",
        [
          "-c", // Create archive
          "-P", // Preserve absolute paths (equivalent to preservePaths: true)
          ...paths,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      // zstd options optimized for speed:
      // -T0: Use all available CPU cores
      // -1: Fast compression level (prioritizes speed over ratio)
      // -v: Verbose output for progress
      // -o: Output file
      const zstdProcess = spawn(
        "zstd",
        [
          "-T0", // Multi-threading: use all cores
          "-1", // Fast compression (level 1)
          "-v", // Verbose
          "-o",
          archive,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      // Pipe tar output to zstd input
      tarProcess.stdout.pipe(zstdProcess.stdin);

      tarProcess.stderr?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) core.info(`tar: ${msg}`);
      });

      zstdProcess.stdout?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) core.info(msg);
      });

      zstdProcess.stderr?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) core.info(msg);
      });

      let tarError: Error | null = null;
      let zstdError: Error | null = null;

      tarProcess.on("error", (error) => {
        tarError = error;
        reject(new Error(`tar process error: ${error.message}`));
      });

      zstdProcess.on("error", (error) => {
        zstdError = error;
        reject(new Error(`zstd process error: ${error.message}`));
      });

      tarProcess.on("close", (code) => {
        if (code !== 0 && !tarError) {
          reject(new Error(`tar failed with exit code ${code}`));
        }
      });

      zstdProcess.on("close", (code) => {
        if (code === 0 && !zstdError) {
          core.info("zstd compression completed successfully");
          resolve();
        } else if (!zstdError) {
          reject(new Error(`zstd compression failed with exit code ${code}`));
        }
      });
    });
  }
}

/**
 * Extract a compressed archive using the specified compression method.
 */
async function extractArchive(
  archive: string,
  compressionMethod: CompressionMethod,
): Promise<void> {
  if (compressionMethod === "none") {
    // No compression - just extract tar
    await tar.extract({ file: archive, preservePaths: true });
  } else if (compressionMethod === "gzip") {
    // Use gzip decompression (built into tar library)
    await tar.extract({ file: archive, preservePaths: true });
  } else if (compressionMethod === "zstd") {
    // Use zstd decompression with multi-threading
    if (!(await isCommandAvailable("zstd"))) {
      throw new Error(
        "zstd command not found. Please install zstd or use a different compression method.",
      );
    }
    if (!(await isCommandAvailable("tar"))) {
      throw new Error(
        "tar command not found. Please install tar or use a different compression method.",
      );
    }

    const cpuCount = os.cpus().length;
    core.info(`Decompressing with zstd | tar pipeline using ${cpuCount} threads...`);

    await new Promise<void>((resolve, reject) => {
      // Pipe zstd decompression directly to tar extraction
      // This avoids creating intermediate uncompressed tar file
      const zstdProcess = spawn(
        "zstd",
        [
          "-d", // Decompress
          "-c", // Output to stdout
          "-T0", // Multi-threading
          "-v", // Verbose
          archive,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      const tarProcess = spawn(
        "tar",
        [
          "-x", // Extract
          "-P", // Preserve absolute paths
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      // Pipe zstd output to tar input
      zstdProcess.stdout.pipe(tarProcess.stdin);

      zstdProcess.stderr?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) core.info(msg);
      });

      tarProcess.stderr?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) core.info(`tar: ${msg}`);
      });

      tarProcess.stdout?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) core.info(`tar: ${msg}`);
      });

      let zstdError: Error | null = null;
      let tarError: Error | null = null;

      zstdProcess.on("error", (error) => {
        zstdError = error;
        reject(new Error(`zstd process error: ${error.message}`));
      });

      tarProcess.on("error", (error) => {
        tarError = error;
        reject(new Error(`tar process error: ${error.message}`));
      });

      zstdProcess.on("close", (code) => {
        if (code !== 0 && !zstdError) {
          reject(new Error(`zstd decompression failed with exit code ${code}`));
        }
      });

      tarProcess.on("close", (code) => {
        if (code === 0 && !tarError) {
          core.info("Decompression and extraction completed successfully");
          resolve();
        } else if (!tarError) {
          reject(new Error(`tar extraction failed with exit code ${code}`));
        }
      });
    });
  }
}

function fileName(paths: string[], compressionMethod: CompressionMethod): string {
  const hash = crypto.createHash("md5").update(paths.join("\n")).digest("hex");
  let extension = ".tar";
  if (compressionMethod === "gzip") {
    extension = ".tar.gz";
  } else if (compressionMethod === "zstd") {
    extension = ".tar.zst";
  }
  return `${hash}${extension}`;
}

function archivePath(compressionMethod: CompressionMethod): string {
  const tmpdir = process.env.RUNNER_TEMP || "";
  let postfix = ".tar";
  if (compressionMethod === "gzip") {
    postfix = ".tar.gz";
  } else if (compressionMethod === "zstd") {
    postfix = ".tar.zst";
  }
  return tmp.tmpNameSync({ tmpdir, postfix });
}

function fileSize(file: string): number {
  return fs.statSync(file).size;
}
