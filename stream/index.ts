import { Readable, Transform } from "stream";
import { byteArrayToLong } from "../src/utils";
import base64url from "base64url";
import { indexToType } from "../src/signing/constants";
import { MIN_BINARY_SIZE } from "../src/index";
import { SIG_CONFIG } from "../src/constants";
import { tagsParser } from "../src/parser";
import * as crypto from "crypto";
import { stringToBuffer } from "arweave/web/lib/utils";
import { deepHash } from "../src/deepHash";

export default async function processStream(
  stream: Readable,
): Promise<Record<string, any>[]> {
  const reader = getReader(stream);
  let bytes: Uint8Array = (await reader.next()).value;
  bytes = await readBytes(reader, bytes, 32);
  const itemCount = byteArrayToLong(bytes.subarray(0, 32));
  bytes = bytes.subarray(32);
  const headersLength = 64 * itemCount;
  bytes = await readBytes(reader, bytes, headersLength);
  const headers: [number, string][] = new Array(itemCount);
  for (let i = 0; i < headersLength; i += 64) {
    headers[i / 64] = [
      byteArrayToLong(bytes.subarray(i, i + 32)),
      base64url(Buffer.from(bytes.subarray(i + 32, i + 64))),
    ];
  }

  bytes = bytes.subarray(headersLength);

  let offsetSum = 32 + headersLength;

  const items = [];

  for (const [length, id] of headers) {
    bytes = await readBytes(reader, bytes, MIN_BINARY_SIZE);

    // Get sig type
    bytes = await readBytes(reader, bytes, 2);
    const signatureType = byteArrayToLong(bytes.subarray(0, 2));
    bytes = bytes.subarray(2);

    const { sigLength, pubLength, sigName } = SIG_CONFIG[signatureType];

    // Get sig
    bytes = await readBytes(reader, bytes, sigLength);
    const signature = bytes.subarray(0, sigLength);
    bytes = bytes.subarray(sigLength);

    // Get owner
    bytes = await readBytes(reader, bytes, pubLength);
    const owner = bytes.subarray(0, pubLength);
    bytes = bytes.subarray(pubLength);

    // Get target
    bytes = await readBytes(reader, bytes, 1);
    const targetPresent = bytes[0] === 1;
    if (targetPresent) bytes = await readBytes(reader, bytes, 33);
    const target = targetPresent
      ? bytes.subarray(1, 33)
      : Buffer.allocUnsafe(0);
    bytes = bytes.subarray(targetPresent ? 33 : 1);

    // Get anchor
    bytes = await readBytes(reader, bytes, 1);
    const anchorPresent = bytes[0] === 1;
    if (anchorPresent) bytes = await readBytes(reader, bytes, 33);
    const anchor = anchorPresent
      ? bytes.subarray(1, 33)
      : Buffer.allocUnsafe(0);
    bytes = bytes.subarray(anchorPresent ? 33 : 1);

    // Get tags
    bytes = await readBytes(reader, bytes, 8);
    const tagsLength = byteArrayToLong(bytes.subarray(0, 8));
    bytes = bytes.subarray(8);

    bytes = await readBytes(reader, bytes, 8);
    const tagsBytesLength = byteArrayToLong(bytes.subarray(0, 8));
    bytes = bytes.subarray(8);

    bytes = await readBytes(reader, bytes, tagsBytesLength);
    const tagsBytes = bytes.subarray(0, tagsBytesLength);
    const tags =
      tagsLength !== 0 && tagsBytesLength !== 0
        ? tagsParser.fromBuffer(Buffer.from(tagsBytes))
        : [];
    if (tags.length !== tagsLength) throw new Error("Tags lengths don't match");
    bytes = bytes.subarray(tagsBytesLength);

    const transform = new Transform();
    transform._transform = function (chunk, _, done) {
      this.push(chunk);
      done();
    };

    // Verify signature
    const signatureData = deepHash([
      stringToBuffer("dataitem"),
      stringToBuffer("1"),
      stringToBuffer(signatureType.toString()),
      owner,
      target,
      anchor,
      tagsBytes,
      transform,
    ]);

    // Get offset of data start and length of data
    const dataOffset =
      2 +
      sigLength +
      pubLength +
      (targetPresent ? 33 : 1) +
      (anchorPresent ? 33 : 1) +
      16 +
      tagsBytesLength;
    const dataSize = length - dataOffset;

    if (bytes.byteLength > dataSize) {
      transform.write(bytes.subarray(0, dataSize));
      bytes = bytes.subarray(dataSize);
    } else {
      let skipped = bytes.byteLength;
      transform.write(bytes);
      while (dataSize > skipped) {
        bytes = (await reader.next()).value;
        if (!bytes) {
          throw new Error(
            `Not enough data bytes  expected: ${dataSize} received: ${skipped}`,
          );
        }

        skipped += bytes.byteLength;

        if (skipped > dataSize)
          transform.write(
            bytes.subarray(0, bytes.byteLength - (skipped - dataSize)),
          );
        else transform.write(bytes);
      }
      bytes = bytes.subarray(bytes.byteLength - (skipped - dataSize));
    }

    transform.end();

    // Check id
    if (
      id !== base64url(crypto.createHash("sha256").update(signature).digest())
    )
      throw new Error("ID doesn't match signature");

    const Signer = indexToType[signatureType];

    if (!(await Signer.verify(owner, (await signatureData) as any, signature)))
      throw new Error("Invalid signature");

    items.push({
      id,
      sigName,
      signature: base64url(Buffer.from(signature)),
      target: base64url(Buffer.from(target)),
      anchor: base64url(Buffer.from(anchor)),
      owner: base64url(Buffer.from(owner)),
      tags,
      dataOffset: offsetSum + dataOffset,
      dataSize,
    });

    offsetSum += dataOffset + dataSize;
  }

  return items;
}

async function readBytes(
  reader: AsyncGenerator<Buffer>,
  buffer: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (buffer.byteLength > length) return buffer;

  const { done, value } = await reader.next();

  if (done && !value) throw new Error("Invalid buffer");

  return readBytes(reader, Buffer.concat([buffer, value]), length);
}

async function* getReader(s: Readable): AsyncGenerator<Buffer> {
  for await (const chunk of s) {
    yield chunk;
  }
}
