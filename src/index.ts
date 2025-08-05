import { promisify } from 'util';
import { brotliCompress, brotliDecompress, gunzip, gzip } from 'zlib';
import { existsSync, openSync, read, write, writeSync } from 'fs';

import type { Face, Metadata } from 's2-tilejson';

const gunzipAsync = promisify(gunzip);
const brotliDecompressAsync = promisify(brotliDecompress);
const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);
const readAsync = promisify(read);
const writeAsync = promisify(write);

/**
 * Enum representing a compression algorithm used. Mimics the PMTiles specification for easier use.
 * 0 = unknown compression, for if you must use a different or unspecified algorithm.
 * 1 = no compression.
 * 2 = gzip
 * 3 = brotli
 * 4 = zstd
 */
export enum Compression {
  Unknown = 0,
  None = 1,
  Gzip = 2,
  Brotli = 3,
  Zstd = 4,
}

/**
 * A Node consists of an offset and a length pointing to a node
 * Offset: 6 bytes
 * Length: 4 bytes
 */
type Node = Directory;
/**
 * A directory consists of an offset and a length pointing to a node or a leaf.
 * - Offset: 6 bytes
 * - Length: 4 bytes
 */
type Directory = [offset: number, length: number];

const NODE_SIZE = 10; // [offset, length] => [6 bytes, 4 bytes]
const DIR_SIZE = 1_365 * NODE_SIZE; // (13_650) -> 6 levels, the 6th level has both node and leaf (1+4+16+64+256+1024)*2 => (1365)+1365 => 2_730
const METADATA_SIZE = 131_072; // 131,072 bytes is 128kB
const ROOT_DIR_SIZE = DIR_SIZE * 6; // 27_300 * 6 = 163_800
const ROOT_SIZE = METADATA_SIZE + ROOT_DIR_SIZE;
// assuming all tiles exist for every face from 0->30 the max leafs to reach depth of 30 is 5
// root: 6sides * 27_300bytes/dir = (163_800 bytes)
// all leafs at 6: 1024 * 6sides * 27_300bytes/dir (0.167731 GB)
// al leafs at 12: 524_288 * 6sides * 27_300bytes/dir (85.8783744 GB) - obviously most of this is water

/**
 * # S2 Tiles Reader
 *
 * Reads & Writes data via the [S2Tiles specification](https://github.com/Open-S2/s2tiles/blob/master/s2tiles-spec/1.0.0/README.md).
 */
export class S2TilesStore {
  file: number;
  #isSetup = false;
  offset = ROOT_SIZE;
  maxzoom = 0;
  version = 1;
  compression: Compression;
  metadata?: Metadata;
  decoder = new TextDecoder();
  encoder = new TextEncoder();
  /**
   * @param path - the location of the S2Tiles data
   * @param maxzoom - set the maxzoom if you're writing
   * @param compression - set the compression algorithm if you're writing
   */
  constructor(
    readonly path: string,
    maxzoom?: number,
    compression?: Compression,
  ) {
    this.maxzoom = maxzoom ?? 0;
    this.compression = compression ?? Compression.Gzip;
    // open file and add ROOT_SIZE padding if it didn't exist previously
    if (!existsSync(path)) {
      writeSync(openSync(path, 'w'), new Uint8Array(new ArrayBuffer(ROOT_SIZE)));
    }
    this.file = openSync(path, 'r+');
  }

  /**
   * Get the metadata of the archive
   * @returns - the metadata of the archive
   */
  async getMetadata(): Promise<Metadata> {
    if (this.metadata !== undefined) return this.metadata;
    await this.setup();
    return this.metadata!;
  }

  /** Setup the reader */
  async setup(): Promise<void> {
    if (this.#isSetup) return;
    this.#isSetup = true;
    // fetch the metadata
    const data = Buffer.alloc(ROOT_SIZE);
    await readAsync(this.file, data, 0, ROOT_SIZE, 0);
    // prep a data view, store in header, build metadata
    const dv = new DataView(data.buffer, 0, ROOT_SIZE);
    if (dv.getUint16(0, true) !== 12883) {
      // the first two bytes are S and 2, we validate
      throw new Error(`Bad metadata from ${this.path}`);
    }
    // parse the version, maxzoom, and compression
    this.version = dv.getUint16(2, true);
    this.maxzoom = dv.getUint8(4);
    this.compression = dv.getUint8(5) as Compression;
    // parse the JSON metadata length and offset
    const mL = dv.getUint32(6, true);
    if (mL === 0) {
      // if the metadata is empty, we failed
      throw new Error(`Failed to extrapolate ${this.path} metadata`);
    }
    const meta_data = await decompress(data.slice(10, 10 + mL), this.compression);
    this.metadata = JSON.parse(this.decoder.decode(meta_data)) as Metadata;
  }

  /**
   * Check if a tile exists in the archive
   * @param zoom - the zoom level of the tile
   * @param x - the x coordinate of the tile
   * @param y - the y coordinate of the tile
   * @returns - true if the tile exists in the archive
   */
  async hasTileWM(zoom: number, x: number, y: number): Promise<boolean> {
    return await this.hasTileS2(0, zoom, x, y);
  }

  /**
   * Check if an S2 tile exists in the archive
   * @param face - the Open S2 projection face
   * @param zoom - the zoom level of the tile
   * @param x - the x coordinate of the tile
   * @param y - the y coordinate of the tile
   * @returns - true if the tile exists in the archive
   */
  async hasTileS2(face: Face, zoom: number, x: number, y: number): Promise<boolean> {
    await this.setup();
    // now we walk to the next directory as necessary
    const cursor = await this.#walk(face, zoom, x, y, false); // [offset, length]
    if (cursor === undefined) {
      return false;
    }
    // read contents at cursor position
    const node = Buffer.alloc(NODE_SIZE);
    await readAsync(this.file, node, 0, NODE_SIZE, cursor);
    const [offset, length] = [_readUInt48LE(node), node.readUInt32LE(6)];
    return offset !== 0 && length !== 0;
  }

  /**
   * Get the bytes of the tile at the given (zoom, x, y) coordinates
   * @param zoom - the zoom level of the tile
   * @param x - the x coordinate of the tile
   * @param y - the y coordinate of the tile
   * @returns - the bytes of the tile at the given (z, x, y) coordinates, or undefined if the tile
   * does not exist in the archive.
   */
  async getTileWM(zoom: number, x: number, y: number): Promise<Uint8Array | undefined> {
    await this.setup();
    return await this.getTileS2(0, zoom, x, y);
  }

  /**
   * Get the bytes of the tile at the given (face, zoom, x, y) coordinates
   * @param face - the Open S2 projection face
   * @param zoom - the zoom level of the tile
   * @param x - the x coordinate of the tile
   * @param y - the y coordinate of the tile
   * @returns - the bytes of the tile at the given (face, zoom, x, y) coordinates, or undefined if
   * the tile does not exist in the archive.
   */
  async getTileS2(face: Face, zoom: number, x: number, y: number): Promise<undefined | Uint8Array> {
    await this.setup();
    const { compression } = this;

    // now we walk to the next directory as necessary
    const cursor = await this.#walk(face, zoom, x, y, false); // [offset, length]
    if (cursor === undefined) {
      return;
    }
    // read contents at cursor position
    const node = Buffer.alloc(NODE_SIZE);
    await readAsync(this.file, node, 0, NODE_SIZE, cursor);
    const [offset, length] = [_readUInt48LE(node), node.readUint32LE(6)];

    // we found the vector file, let's send the details off to the tile worker
    const data = new Uint8Array(new ArrayBuffer(length));
    await readAsync(this.file, data, 0, length, offset);
    return await decompress(data, compression);
  }

  /**
   * Write a tile to the S2Tiles file given its (z, x, y) coordinates.
   * @param zoom - the zoom level
   * @param x - the tile X coordinate
   * @param y - the tile Y coordinate
   * @param data - the tile data to store
   */
  async writeTileWM(zoom: number, x: number, y: number, data: Uint8Array): Promise<void> {
    await this.putTile(0, zoom, x, y, data);
  }

  /**
   * Write a tile to the S2Tiles file given its (face, zoom, x, y) coordinates.
   * @param face - the Open S2 projection face
   * @param zoom - the zoom level
   * @param x - the tile X coordinate
   * @param y - the tile Y coordinate
   * @param data - the tile data to store
   */
  async writeTileS2(
    face: Face,
    zoom: number,
    x: number,
    y: number,
    data: Uint8Array,
  ): Promise<void> {
    await this.putTile(face, zoom, x, y, data);
  }

  /**
   * Finish writing by building the header with root and leaf directories
   * @param metadata - the metadata to store
   * @param tileCompression - the compression algorithm that was used on the tiles [Default: None]
   */
  async commit(metadata: Metadata, tileCompression?: Compression): Promise<void> {
    // set the ID, version, and compression type
    const data = Buffer.alloc(10);
    // Store format metadata
    data.writeUint8(83, 0); // S
    data.writeUint8(50, 1); // 2
    data.writeUint16LE(this.version, 2);
    data.writeUint8(this.maxzoom, 4);
    data.writeUint8(tileCompression ?? this.compression, 5);
    // store the metadata's length then actual data
    let metaBuffer = this.encoder.encode(JSON.stringify(metadata));
    metaBuffer = await compress(metaBuffer, this.compression);
    if (metaBuffer.byteLength > METADATA_SIZE - 10) {
      throw new Error('Metadata too large for S2Tiles');
    }
    data.writeUint32LE(metaBuffer.byteLength, 6);
    // store the format metadata and lengthen the writer to fill METADATA_SIZE. Then store the map metadata
    await writeAsync(this.file, data, 0, 10, 0);
    await writeAsync(this.file, metaBuffer, 0, metaBuffer.byteLength, 10);
  }

  /**
   * Write a tile to the S2Tiles file given its (face, zoom, x, y) coordinates.
   * @param face - the Open S2 projection face
   * @param zoom - the zoom level
   * @param x - the tile X coordinate
   * @param y - the tile Y coordinate
   * @param data - the tile data to store
   */
  async putTile(face: Face, zoom: number, x: number, y: number, data: Uint8Array): Promise<void> {
    const length = data.byteLength;
    // first create node, setting offset
    const node: Node = [this.offset, length];
    data = await compress(data, this.compression);
    await writeAsync(this.file, data, 0, length, this.offset);
    this.offset += length;
    // store node in the correct directory
    await this.#putNodeInDir(face, zoom, x, y, node);
  }

  /**
   * Work our way towards the correct parent directory.
   * If parent directory does not exists, we create it.
   * @param face - the Open S2 projection face
   * @param zoom - the zoom level
   * @param x - the tile X coordinate
   * @param y - the tile Y coordinate
   * @param node - the node
   */
  async #putNodeInDir(face: Face, zoom: number, x: number, y: number, node: Node): Promise<void> {
    // use the s2cellID and move the cursor
    const cursor = await this.#walk(face, zoom, x, y, true);
    // finally store
    await this.#writeNode(cursor, node);
  }

  /**
   * given position and level, find the tile offset and length
   * @param face - the Open S2 projection face
   * @param zoom - the zoom level of the tile
   * @param x - the x coordinate of the tile
   * @param y - the y coordinate of the tile
   * @param create - whether or not we are writing or reading
   * @returns - the offset the tile if it exists or the directory, creates if it doesn't and create is true
   */
  async #walk(face: Face, zoom: number, x: number, y: number, create: boolean): Promise<number> {
    const { maxzoom } = this;

    const leafNode = Buffer.alloc(NODE_SIZE);
    let cursor: number = METADATA_SIZE + face * DIR_SIZE;
    let leaf: number;
    let depth = 0;
    const path = getS2TilePath(zoom, x, y);

    while (path.length !== 0) {
      // grab movement
      const shift = path.shift() ?? 0;
      depth++;
      // update cursor position
      cursor += shift * NODE_SIZE;

      if (path.length !== 0) {
        // if we hit a leaf, adjust nodePos position and move cursor to new directory
        // if we are at the max zoom, we are already in the correct position (the "leaf" is actually a node instead)
        if (maxzoom % 5 === 0 && path.length === 1 && zoom === maxzoom && path[0] === 0)
          return cursor;
        // grab the leaf from the file
        await readAsync(this.file, leafNode, 0, NODE_SIZE, cursor);
        leaf = _readUInt48LE(leafNode);
        // if the leaf doesn't, we create, otherwise we move to the leaf
        if (leaf === 0) {
          if (create) cursor = await this.#createLeafDir(cursor, depth * 5);
          else return 0;
        } else {
          cursor = leaf;
        } // move to where leaf is pointing
      }
    }

    return cursor;
  }

  /**
   * Create a new leaf directory
   * @param cursor - the cursor
   * @param depth - the depth
   * @returns - the offset of the new leaf
   */
  async #createLeafDir(cursor: number, depth: number): Promise<number> {
    // build directory size according to maxzoom
    const dirSize = _buildDirSize(depth, this.maxzoom);
    // create offset & node
    const offset = this.offset;
    const node: Node = [offset, dirSize];
    // create a dir of said size and update to new offset
    await writeAsync(this.file, Buffer.alloc(dirSize), 0, dirSize, offset);
    this.offset += dirSize;
    // store our newly created directory as a leaf directory in our current directory
    await this.#writeNode(cursor, node);

    // return the offset of the leaf directory
    return offset;
  }

  /**
   * Writes a node to the file
   * @param cursor - the cursor
   * @param node - the node
   */
  async #writeNode(cursor: number, node: Node): Promise<void> {
    const [offset, length] = node;
    // write offset and length to buffer
    const nodeBuf = Buffer.alloc(NODE_SIZE);
    _writeUInt48LE(nodeBuf, offset);
    nodeBuf.writeUint32LE(length, 6);
    // write buffer to file at directory offset
    await writeAsync(this.file, nodeBuf, 0, NODE_SIZE, cursor);
  }
}

/**
 * Build a directory size relative to maxzoom
 * @param depth - the depth
 * @param maxzoom - the maxzoom
 * @returns - the directory size
 */
function _buildDirSize(depth: number, maxzoom: number): number {
  const { min, pow } = Math;
  let dirSize = 0;
  // grab the remainder
  let remainder = min(maxzoom - depth, 5); // must be increments of 5, so if level 4 then inc is 0 but if 5, inc is 5
  // for each remainder (including 0), we add a quadrant
  do {
    dirSize += pow(1 << remainder, 2);
  } while (remainder-- !== 0);

  return dirSize * NODE_SIZE;
}

/**
 * read a 48 bit number
 * @param buffer - the buffer
 * @param offset - the offset
 * @returns - the number
 */
function _readUInt48LE(buffer: Buffer, offset = 0): number {
  return buffer.readUint32LE(2 + offset) * (1 << 16) + buffer.readUint16LE(offset);
}

/**
 * write a 32 bit and a 16 bit
 * @param data - the data to write to
 * @param num - the number
 * @param offset - the offset to write at
 */
function _writeUInt48LE(data: Buffer, num: number, offset = 0): void {
  const lower = num & 0xffff;
  const upper = num / (1 << 16);

  data.writeUInt16LE(lower, offset);
  data.writeUInt32LE(upper, offset + 2);
}

/**
 * Get the path to a tile
 * @param zoom - the zoom
 * @param x - the x
 * @param y - the y
 * @returns - the path
 */
export function getS2TilePath(zoom: number, x: number, y: number): number[] {
  const { max, pow } = Math;
  const path: Array<[number, number, number]> = [];
  while (zoom >= 5) {
    path.push([5, x & 31, y & 31]);
    x >>= 5;
    y >>= 5;
    zoom = max(zoom - 5, 0);
  }
  path.push([zoom, x, y]);
  return path.map(([zoom, x, y]) => {
    let val = 0;
    val += y * (1 << zoom) + x;
    while (zoom-- !== 0) val += pow(1 << zoom, 2);
    return val;
  });
}

/**
 * Decompress the data
 * @param data - the data to decompress
 * @param compression - the compression type
 * @returns - the decompressed data
 */
async function decompress(data: Uint8Array, compression: Compression): Promise<Uint8Array> {
  if (compression === Compression.None) return data;
  else if (compression === Compression.Gzip)
    return new Uint8Array((await gunzipAsync(data)).buffer);
  else if (compression === Compression.Brotli)
    return new Uint8Array((await brotliDecompressAsync(data)).buffer);
  else throw new Error('Decompression type not supported');
}

/**
 * Compress the data
 * @param data - the data to compress
 * @param compression - the compression type
 * @returns - the compressed data
 */
async function compress(data: Uint8Array, compression: Compression): Promise<Uint8Array> {
  if (compression === Compression.None) return data;
  else if (compression === Compression.Gzip) return new Uint8Array((await gzipAsync(data)).buffer);
  else if (compression === Compression.Brotli)
    return new Uint8Array((await brotliCompressAsync(data)).buffer);
  else throw new Error('Compression type not supported');
}
