import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/*
 * This config lives beside the tests, not at the repository root, because Visual Studio's Vitest
 * test adapter creates its Vitest instance with `root` set to the folder containing the project
 * file. A config anywhere else is simply not read, and Test Explorer would then run the tests with
 * Vitest's defaults -- notably the `node` environment, which fails every test that touches the DOM.
 *
 * `npm test` points Vitest at the same root (see the root package.json), so the command line, CI,
 * and Test Explorer all share one configuration.
 */
export default defineConfig({
    test: {
        include: ['unit/**/*.test.ts'],

        // The view builds its output with real DOM calls. Running against a real DOM implementation
        // rather than stubs means the rendering tests, including the one asserting that comment text
        // is never interpreted as markup, exercise the same code paths the browser will.
        environment: 'jsdom',

        reporters: process.env.CI ? ['default', 'junit'] : ['default'],

        // Resolved against the repository root rather than this folder, so CI collects results from
        // one predictable place.
        outputFile: { junit: resolve(__dirname, '../../test-results/vitest-junit.xml') },
    },
});
