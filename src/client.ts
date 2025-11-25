import * as core from "@actions/core";
import * as s3 from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { once } from "events";
import * as fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

function enhanceS3Error(error: unknown): Error {
  if (error instanceof Error) {
    // Check if it's an AWS SDK error with metadata
    const awsError = error as Error & {
      name?: string;
      $metadata?: {
        httpStatusCode?: number;
        requestId?: string;
        extendedRequestId?: string;
        cfId?: string;
      };
      Endpoint?: string;
      Bucket?: string;
      Region?: string;
      [key: string]: unknown;
    };

    // Log full error object for debugging
    core.debug(`S3 Error Name: ${awsError.name}`);
    core.debug(`S3 Error Message: ${error.message}`);

    // Log all error properties
    const errorProps: Record<string, unknown> = {};
    for (const key in awsError) {
      if (key !== "stack" && key !== "message" && key !== "name") {
        errorProps[key] = awsError[key];
      }
    }
    core.debug(`S3 Error Properties: ${JSON.stringify(errorProps, null, 2)}`);

    // Log metadata if available
    if (awsError.$metadata) {
      core.debug(`S3 Error Metadata: ${JSON.stringify(awsError.$metadata, null, 2)}`);
    }

    // Handle PermanentRedirect specifically
    if (awsError.name === "PermanentRedirect") {
      let enhancedMessage = error.message;

      if (awsError.Endpoint) {
        enhancedMessage += `\n  → Correct endpoint: ${awsError.Endpoint}`;
        core.error(`S3 PermanentRedirect: Bucket must use endpoint: ${awsError.Endpoint}`);
      }

      if (awsError.Bucket) {
        enhancedMessage += `\n  → Bucket: ${awsError.Bucket}`;
        core.error(`S3 PermanentRedirect: Bucket name: ${awsError.Bucket}`);
      }

      if (awsError.Region) {
        enhancedMessage += `\n  → Region: ${awsError.Region}`;
        core.error(`S3 PermanentRedirect: Correct region: ${awsError.Region}`);
      }

      const enhancedError = new Error(enhancedMessage);
      enhancedError.name = error.name;
      enhancedError.stack = error.stack;
      return enhancedError;
    }
  }
  return error as Error;
}

export class Client {
  constructor(
    private readonly bucketName: string,
    private readonly client: s3.S3Client,
  ) {}

  private static joinKey(key: string, file: string): string {
    return `${key}/${file}`;
  }

  private static matchFile(objectKey: string, file: string): boolean {
    return objectKey.endsWith(`/${file}`);
  }

  private static getKey(objectKey: string): string {
    const index = objectKey.lastIndexOf("/");
    if (index === -1) {
      throw new Error(`Invalid object key: ${objectKey}`);
    }
    return objectKey.substring(0, index);
  }

  async getObject(key: string, file: string, stream: fs.WriteStream): Promise<boolean> {
    core.debug(`Getting object from S3 with key ${key}, file ${file}.`);
    const command = new s3.GetObjectCommand({
      Bucket: this.bucketName,
      Key: Client.joinKey(key, file),
    });
    try {
      const response = await this.client.send(command);
      await pipeline(response.Body! as Readable, stream);
      return true;
    } catch (error: unknown) {
      if (error instanceof s3.NoSuchKey) {
        return false;
      }
      throw enhanceS3Error(error);
    } finally {
      if (!stream.closed) {
        stream.destroy();
        await once(stream, "close");
      }
    }
  }

  async headObject(key: string, file: string): Promise<boolean> {
    core.debug(`Heading object from S3 with key ${key}, file ${file}.`);
    const command = new s3.HeadObjectCommand({
      Bucket: this.bucketName,
      Key: Client.joinKey(key, file),
    });
    try {
      await this.client.send(command);
      return true;
    } catch (error: unknown) {
      if (error instanceof s3.NotFound) {
        return false;
      }
      throw enhanceS3Error(error);
    }
  }

  async listObjects(prefix: string, file: string): Promise<string[]> {
    core.debug(`Listing objects from S3 with prefix ${prefix}.`);
    const command = new s3.ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
    });
    try {
      const response = await this.client.send(command);
      if (response.IsTruncated) {
        core.info(
          `Too many objects in S3 with prefix ${prefix}, ` +
            `only ${response.KeyCount} objects will be checked.`,
        );
      }
      return (
        response.Contents?.filter((object) => Client.matchFile(object.Key!, file))
          .sort((x, y) => (x.LastModified!.getTime() < y.LastModified!.getTime() ? 1 : -1))
          .map((object) => Client.getKey(object.Key!)) ?? []
      );
    } catch (error: unknown) {
      throw enhanceS3Error(error);
    }
  }

  async putObject(key: string, file: string, stream: fs.ReadStream): Promise<void> {
    core.debug(`Putting object to S3 with key ${key}, file ${file}.`);

    // Optimized settings for same-region AWS uploads with high bandwidth
    // - partSize: 8MB (minimum for S3 is 5MB, 8MB provides good balance)
    // - queueSize: 10 (allows 10 concurrent part uploads to saturate the link)
    // This configuration enables multipart uploads with high concurrency
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucketName,
        Key: Client.joinKey(key, file),
        Body: stream,
      },
      partSize: 8 * 1024 * 1024, // 8 MB per part
      queueSize: 10, // 10 concurrent uploads
    });

    upload.on("httpUploadProgress", ({ loaded, total }) => {
      if (loaded !== undefined && total !== undefined) {
        const percentage = ((loaded / total) * 100).toFixed(1);
        core.info(`Upload progress: ${percentage}% (${loaded}/${total} bytes)`);
      } else if (loaded !== undefined) {
        core.debug(`Uploaded ${loaded} bytes.`);
      }
    });

    try {
      await upload.done();
    } catch (error: unknown) {
      throw enhanceS3Error(error);
    }
  }
}
