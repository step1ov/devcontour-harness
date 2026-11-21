// The first import of every test file (tests/test-temp.test.ts checks it): the
// process writes its temporary files into its own directory, removed on exit.
// See scripts/test-temp.mjs; HARNESS_KEEP_TEST_TMP=1 keeps it.
import { scopeTestTemp } from '../scripts/test-temp.mjs';

scopeTestTemp();
