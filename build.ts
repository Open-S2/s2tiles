import bun from 'bun';

try {
  console.info('Starting the build process...');
  const outputNode = await bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    format: 'esm',
    minify: true,
    sourcemap: 'external',
    target: 'browser',
    // target: 'esnext', // Adjust target based on your project needs
  });
  console.info('Node Build completed successfully!', outputNode);
  const outputFile = await bun.build({
    entrypoints: ['src/file.ts'],
    outdir: 'dist',
    format: 'esm',
    minify: true,
    sourcemap: 'external',
    target: 'node',
    // target: 'esnext', // Adjust target based on your project needs
  });
  console.info('File Build completed successfully!', outputFile);
  const outputMMap = await bun.build({
    entrypoints: ['src/mmap.ts'],
    outdir: 'dist',
    format: 'esm',
    minify: true,
    sourcemap: 'external',
    target: 'node',
    // target: 'esnext', // Adjust target based on your project needs
  });
  console.info('File Build completed successfully!', outputMMap);
} catch (error) {
  console.error('Build failed:', error);
}
