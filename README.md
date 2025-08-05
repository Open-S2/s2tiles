<h1 style="text-align: center;">
    <div align="center">s2tiles</div>
</h1>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/Open-S2/s2tiles/test.yml?logo=github" alt="GitHub Actions Workflow Status">
  <a href="https://npmjs.org/package/s2tiles">
    <img src="https://img.shields.io/npm/v/s2tiles.svg?logo=npm&logoColor=white" alt="npm">
  </a>
  <a href="https://www.npmjs.com/package/s2tiles">
    <img src="https://img.shields.io/npm/dm/s2tiles.svg" alt="downloads">
  </a>
  <a href="https://bundlejs.com/?q=s2tiles&treeshake=%5B%7B+S2TilesStore+%7D%5D">
    <img src="https://deno.bundlejs.com/badge?q=s2tiles&treeshake=[{+S2TilesStore+}]" alt="bundle">
  </a>
  <a href="https://open-s2.github.io/s2tiles/">
    <img src="https://img.shields.io/badge/docs-typescript-yellow.svg" alt="docs-ts">
  </a>
  <img src="https://raw.githubusercontent.com/Open-S2/s2tiles/master/assets/doc-coverage.svg" alt="doc-coverage">
  <a href="https://coveralls.io/github/Open-S2/s2tiles?branch=master">
    <img src="https://coveralls.io/repos/github/Open-S2/s2tiles/badge.svg?branch=master" alt="code-coverage">
  </a>
  <a href="https://discord.opens2.com">
    <img src="https://img.shields.io/discord/953563031701426206?logo=discord&logoColor=white" alt="Discord">
  </a>
</p>

## About

S2Tiles is a single-file archive format for tiled data that works for both WM and S2 projections. The goal is to be a "cloud optimized tile store" for vector/raster/grid data. It works much like the [PMTiles](https://github.com/protomaps/PMTiles) library.

## Read The Spec

[s2tiles-spec](/s2tiles-spec/1.0.0/README.md)

For now this spec supports deflating metadata/directories inside the browser, but it will be removed in the future.

## Install

```bash
#bun
bun add s2tiles
# pnpm
pnpm add s2tiles
# yarn
yarn add s2tiles
# npm
npm install s2tiles
```

---

## Development

### Running Tests

To run the tests, use the following command:

```bash
# TYPESCRIPT
## basic test
bun run test
## live testing
bun run test:dev
```
