# S2 Tiles Version 1 Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

---

Please refer to the [change log](../CHANGELOG.md) for a documentation of changes to this specification.

## 1 Abstract

S2Tiles is a single-file archive format for tiled data that works for both WM and S2 projections.
The goal is three-fold:
- 1: to be a "cloud optimized tile store" for vector/raster/grid data.
- 2: To be as simple as possible to both understand and implement in every language.
- 3: To allow a large level of mallability for potential future storage mechanics and for the user to implement their own metadata and store their own "data".

This spec is intentionally designed as simply as possible to allow room for the user to implement their own JSON metadata and store quad-tree data in any format they like.

The recommended MIME Type for S2Tiles is `application/vnd.s2tiles`.

## 2 Overview

A S2Tiles archive consists of five main sections:

1. A fixed-size 128kB header (described in [Chapter 3](#3-header))
1. A root directory (described in [Chapter 4](#4-directories))
1. Optional leaf directories (described in [Chapter 4](#4-directories))
1. The actual tile data

These sections are normally in the same order as in the list above, but it is possible to relocate all sections other than the header arbitrarily.
The only two restrictions are that the header is at the start of the archive, and the root directory MUST be contained in the first 16,384 bytes (16 KiB) so that latency-optimized clients can retrieve the root directory in advance and ensure that it is complete.

```spec
           Root Directory   Leaf Directories & Tile Data
               Length
          <--------------> <---------------------------->
+--------+----------------+------------------------------+
|        |                |                              |
| Header | Root Directory | Leaf Directories & Tile Data |
|        |                |                              |
+--------+----------------+------------------------------+
         ^                ^
     Root Dir     Leaf & Tile Data
      Offset           Offset
     (131_072)        (294,872)
```

## 3 Header

The Header is REQUIRED and has a length of 131,072 bytes (128kB) and is always at the start of the archive.
It includes everything needed to decode and read the rest of the S2Tiles archive properly.

### 3.1 Overview

The first 9 bytes are used to describe the archive with the remaining bytes being reserved for the metadata.

```spec
Offset     00   01   02   03   04   05   06   07   08   09   0A   0B   0C   0D   0E   0F
         +----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+
000000   | S  |  2 | Version | MZ | CP |  Metadata Length  | Metadata...
         +----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+
```

### 3.2 Fields

#### Magic Number

The magic number is a fixed 2-byte field whose value is always `S2` in UTF-8 encoding (`0x53 0x32`) or UTF16-LE of  (`0x12883`)

#### Version

The version is a fixed 1-byte field whose value is always 1 (`0x01`).

#### Max Zoom (MZ)

The max zoom is an 8-byte field specifying the maximum zoom level of the quad-tree archive.

To optimize the directory sizing, I found specifying the maxzoom for writing helped reduce the total size of the file by greater than 20GB for a zoom level of 14 so it was worth the complexity.

#### Compression (CP)

The Tile and Metadata Compression is a 1-byte field specifying the compression of all tiles.

The compression enum is as follows:

| Value  | Meaning |
| :----- | :------ |
| `0x00` | Unknown |
| `0x01` | None    |
| `0x02` | gzip    |
| `0x03` | brotli  |
| `0x04` | zstd    |

A usable Typescript example:

```typescript
enum Compression {
    /** Unknown compression, for if you must use a different or unspecified algorithm. */
    Unknown: 0,
    /** No compression. */
    None: 1,
    /** Gzip compression. */
    Gzip: 2,
    /** Brotli compression. */
    Brotli: 3,
    /** Zstd compression. */
    Zstd: 4,
}
```

#### Metadata Length

The Metadata Length is an 4-byte field specifying the number of bytes of metadata.

This field is encoded as a little-endian 32-bit unsigned integer.

#### Metadata

The metadata is a JSON object describing how to read the tile data.

It is RECOMMENDED to use the [S2 TileJSON 1.0](https://github.com/Open-S2/s2-tilejson/tree/master/s2-tilejson-spec/1.0.0) spec for this purpose.

The S2 TileJSON 1.0 spec describes how to read/parse & render the tiles.

## 4 Directories

### 4.1 Design

This system mimics a **prefix tree (trie)** specifically to benefit the quad-tree structure that Tile data is shaped into.

Data is stored inside a structured binary format made of directories, nodes, and leaves.

This storage is hierarchical and allows fast lookup of tiles based on (face, zoom, x, y) coordinates.

A directory is a binary blob composed of multiple entries.

A directory is MUST be of size 13,650 kB containg 6 levels.

The directory is shaped as a 6-level flat quad-tree index.

You can visualize it as: 1->4->16->64->256->1024.

The first 5 levels are Nodes, and the last level is by default a Leaf but will be a Node if the level is equal to the maxzoom.

Each entry (10 bytes) represents either a node or a leaf:
- 6 bytes = offset (where the node/leaf lives in the file)
- 4 bytes = length (how much data to read from that offset)

A **Node** Points to a tile’s actual data (e.g. a compressed MVT or protobuf).

A **Leaf** Points to another directory, which contains more nodes or leaves.

A 6-byte unsigned integer (uint48) has a maximum value of `281,474,976,710,655` which is enough for 281 TB of data.

### 4.2 Root Directory

There are 6 root directories, one for each S2 face. If the projection is WM, the 0th face is the world.

All 6 root directories are stored at offset 131,072 in the archive and uses a total of 163,800 bytes regardless of the projection.

### 4.3 Walking the Tree

To keep it as simple as possible, a flat quadtree indexing scheme is used for each directory.

Let’s say you want to find a tile at (face, zoom, x, y):

**Step 1**: Compute the Path
1. Use getPath(zoom, x, y) to compute a flat index path to follow the tree.
1. Each level of zoom breaks the tile space into a grid.
1. getPath reduces (zoom, x, y) into a list of numeric offsets into directories.
1. These offsets represent where in a directory we expect to find the next entry.

**Step 2**: Walk the Directory Tree
1. Start at the root directory for the given face.
1. For each index in the path:
    1. Read the 10-byte entry at index * 10:
    1. Extract the offset and length.
    1. If offset === 0 or length === 0: tile does not exist.
    1. If this is the last entry in the path:
        1. This is a node, it points to the tile data.
    1. Otherwise:
        1. This is a leaf, it points to the next-level directory.
        1. Fetch that directory (cache it), and continue walking.

**Step 3**: Retrieve the Tile
1. Once you reach a node (the last entry), use its offset and length to extract raw tile bytes.
1. Decompress it using the format specified in the header metadata.

Pseudocode with complementary Typescript and Rust code are as followed to visualize the process.
The list of offsets is called the **path** (the returned value of `GetTilePath`).

```pseudocode
PROCEDURE GetTilePath(zoom: INTEGER, x: INTEGER, y: INTEGER) RETURNS LIST OF INTEGER
    DECLARE path AS LIST OF TUPLES (INTEGER, INTEGER, INTEGER)
    
    WHILE zoom >= 5 DO
        APPEND (5, x MOD 32, y MOD 32) TO path
        x ← x DIV 32
        y ← y DIV 32
        zoom ← MAX(zoom - 5, 0)
    END WHILE

    APPEND (zoom, x, y) TO path

    DECLARE result AS EMPTY LIST

    FOR EACH (z, i, j) IN path DO
        val ← j × (2 ^ z) + i
        tempZoom ← z
        WHILE tempZoom ≠ 0 DO
            tempZoom ← tempZoom - 1
            val ← val + (2 ^ tempZoom) ^ 2
        END WHILE
        APPEND val TO result
    END FOR

    RETURN result
END PROCEDURE
```

```typescript
/**
 * Get the path to a tile
 * @param zoom - the zoom
 * @param x - the x
 * @param y - the y
 * @returns - The path as a collection of offsets pointing to the tile Node in the directory
 */
export function getTilePath(zoom: number, x: number, y: number): number[] {
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
```

```rust
/// Get the path to a tile
///
/// ## Parameters
/// - `zoom`: the zoom
/// - `x`: the x
/// - `y`: the y
///
/// ## Returns
/// The path as a collection of offsets pointing to the tile Node in the directory
pub fn get_tile_path(mut zoom: u8, mut x: u32, mut y: u32) -> Vec<u64> {
    let mut path = vec![];

    while zoom >= 5 {
        path.push((5, x & 31, y & 31));
        x >>= 5;
        y >>= 5;
        zoom = zoom.saturating_sub(5);
    }
    path.push((zoom, x, y));

    path.into_iter()
        .map(|(zoom, x, y)| {
            let val = (y as u64) * ((1 << zoom) as u64) + (x as u64);
            let sum: u64 = (0..zoom).map(|z| (1 << z) * (1 << z)).sum();
            val + sum
        })
        .collect()
}
```
